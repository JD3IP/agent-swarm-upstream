/** Account-scoped probes. Run on the host with Bun or bundle into the sweep image.
 * Secrets stay in the existing config broker; Codex refresh uses its existing lock.
 */
import { getValidCodexOAuth, loadCodexOAuth } from "../src/providers/codex-oauth/storage.ts";
import { claudeAccountIdentity, codexAccountIdentity } from "../src/utils/account-identity.ts";
import { getApiKey } from "../src/utils/api-key.ts";
import {
  ClaudeAccountAuthError,
  ClaudeReauthenticationRequiredError,
  getClaudeAccountCredential,
} from "./claude-account-credentials.ts";

type Window = {
  id: string;
  durationSeconds: number;
  usedPercent: number | null;
  resetsAt: string | null;
  models: string[] | null;
  blocked?: boolean;
};
type Account = {
  id: string;
  provider: "codex" | "claude";
  enabled: boolean;
  credentialGeneration: number;
  identityKey: string;
  allowedModels: string[];
  credentialRef: { keyType: string; index: number; scope: string; scopeId: string | null };
};
type Observation = {
  credentialGeneration: number;
  observedAt: string;
  source: string;
  authState: "healthy" | "invalid" | "unknown";
  authAction: "reauthenticate" | null;
  state: "healthy" | "exhausted" | "throttled" | "unavailable" | "unknown";
  cooldownUntil: string | null;
  windows: Window[];
};
type Dependencies = {
  fetch: typeof fetch;
  now: () => number;
  codexCredential: (slot: number) => Promise<{ access: string; accountId: string } | null>;
  claudeCredential: (account: Account) => Promise<string | null>;
  codexUrl: string;
  claudeUrl: string;
};

function percent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}
function epoch(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1e11
    ? new Date(value * 1000).toISOString()
    : null;
}
export function codexWindows(body: unknown): Window[] {
  if (!body || typeof body !== "object") return [];
  const out: Window[] = [];
  const visit = (raw: unknown, path: string) => {
    if (!raw || typeof raw !== "object") return;
    const value = raw as Record<string, unknown>;
    if (
      typeof value.limit_window_seconds === "number" &&
      Number.isInteger(value.limit_window_seconds) &&
      value.limit_window_seconds > 0
    ) {
      out.push({
        id: path,
        durationSeconds: value.limit_window_seconds,
        usedPercent: percent(value.used_percent),
        resetsAt: epoch(value.reset_at),
        models: null,
      });
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (/^[a-zA-Z0-9_-]+$/.test(key)) visit(child, path ? `${path}.${key}` : key);
    }
  };
  visit((body as { rate_limit?: unknown }).rate_limit, "codex");
  // Unknown additional quota categories are treated conservatively as shared.
  const additional = (body as { additional_rate_limits?: unknown }).additional_rate_limits;
  if (Array.isArray(additional))
    additional.forEach((v, i) => {
      visit(v, `additional.${i}`);
    });
  return out;
}

export function claudeWindows(headers: Headers, models: string[]): Window[] {
  const out: Window[] = [];
  const prefix = "anthropic-ratelimit-unified-";
  for (const [name, value] of headers.entries()) {
    if (!name.startsWith(prefix) || !name.endsWith("-utilization")) continue;
    const bucket = name.slice(prefix.length, -"-utilization".length);
    const match = /^(\d+)(h|d)(?:-(opus|sonnet|haiku))?$/.exec(bucket);
    if (!match) continue;
    const family = match[3];
    const relevantModels = family ? models.filter((m) => m.toLowerCase().includes(family)) : null;
    // No known mapping for a family means it cannot affect these configured models.
    if (relevantModels && relevantModels.length === 0) continue;
    const raw = Number(value);
    out.push({
      id: bucket,
      durationSeconds: Number(match[1]) * (match[2] === "h" ? 3600 : 86400),
      usedPercent: value.trim() !== "" && Number.isFinite(raw) ? percent(raw * 100) : null,
      resetsAt: epoch(Number(headers.get(`${prefix}${bucket}-reset`))),
      models: relevantModels,
      blocked: headers.get(`${prefix}${bucket}-status`) === "rejected",
    });
  }
  return out;
}

export async function probeAccount(account: Account, deps: Dependencies): Promise<Observation> {
  const observation: Observation = {
    credentialGeneration: account.credentialGeneration,
    observedAt: new Date(deps.now()).toISOString(),
    source: `${account.provider}-usage`,
    authState: "unknown",
    authAction: null,
    state: "unknown",
    cooldownUntil: null,
    windows: [],
  };
  try {
    let response: Response;
    if (account.provider === "codex") {
      // The existing broker is global-only for Codex. Never silently select a different scope.
      if (
        account.credentialRef.scope !== "global" ||
        account.credentialRef.keyType !== "codex_oauth"
      )
        return observation;
      const credential = await deps.codexCredential(account.credentialRef.index);
      if (!credential) return observation;
      if (codexAccountIdentity(credential.access, credential.accountId) !== account.identityKey)
        return { ...observation, authState: "invalid" };
      response = await deps.fetch(deps.codexUrl, {
        headers: {
          Authorization: `Bearer ${credential.access}`,
          "ChatGPT-Account-Id": credential.accountId,
        },
        signal: AbortSignal.timeout(20000),
      });
      if (response.ok) {
        const body = (await response.json()) as {
          rate_limit?: { allowed?: boolean; limit_reached?: boolean };
        };
        observation.windows = codexWindows(body);
        observation.authState = "healthy";
        observation.state =
          body?.rate_limit?.allowed === false || body?.rate_limit?.limit_reached === true
            ? "exhausted"
            : body?.rate_limit?.allowed === true && observation.windows.length
              ? "healthy"
              : "unknown";
      }
    } else {
      const credential = await deps.claudeCredential(account);
      if (!credential || !account.allowedModels.length) return observation;
      const identityResponse = await deps.fetch("https://api.anthropic.com/api/oauth/profile", {
        headers: { Authorization: `Bearer ${credential}`, "anthropic-beta": "oauth-2025-04-20" },
        signal: AbortSignal.timeout(15000),
      });
      if (!identityResponse.ok)
        return {
          ...observation,
          authState: identityResponse.status === 401 ? "invalid" : "unknown",
        };
      if (claudeAccountIdentity(await identityResponse.json()) !== account.identityKey)
        return { ...observation, authState: "invalid" };
      response = await deps.fetch(deps.claudeUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential}`,
          "anthropic-beta": "oauth-2025-04-20",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: account.allowedModels[0],
          max_tokens: 1,
          messages: [{ role: "user", content: "usage probe" }],
        }),
        signal: AbortSignal.timeout(20000),
      });
      observation.windows = claudeWindows(response.headers, account.allowedModels);
      if (response.ok) {
        const body = (await response.json()) as { type?: unknown };
        if ((body as { type?: unknown })?.type !== "message")
          return { ...observation, windows: [], state: "unavailable" };
        observation.authState = "healthy";
        observation.state = observation.windows.length ? "healthy" : "unknown";
        if (observation.windows.some((w) => w.models === null && w.blocked))
          observation.state = "exhausted";
      }
    }
    if (response.status === 401) observation.authState = "invalid";
    if (response.status === 429) {
      observation.state = "throttled";
      const retry = Number(response.headers.get("retry-after"));
      if (retry > 0 && Number.isFinite(retry) && retry < 604800)
        observation.cooldownUntil = new Date(deps.now() + retry * 1000).toISOString();
    } else if (!response.ok) observation.state = "unavailable";
    if (observation.windows.some((w) => w.models === null && w.usedPercent === 100))
      observation.state = "exhausted";
  } catch (error) {
    // Never emit upstream exception bodies: they may include a bearer or OAuth payload.
    observation.authState = error instanceof ClaudeAccountAuthError ? "invalid" : "unknown";
    observation.authAction =
      error instanceof ClaudeReauthenticationRequiredError ? "reauthenticate" : null;
    observation.state = "unavailable";
    observation.windows = [];
  }
  return observation;
}

export async function collectAccounts(options: {
  apiUrl: string;
  apiKey: string;
  sidecarUrl: string;
  sidecarToken: string;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  codexCredential?: Dependencies["codexCredential"];
}): Promise<{ accountId: string; state: string; published: boolean }[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sidecarHeaders = {
    Authorization: `Bearer ${options.sidecarToken}`,
    "content-type": "application/json",
  };
  const inventoryResponse = await fetchImpl(`${options.sidecarUrl}/accounts`, {
    headers: sidecarHeaders,
    signal: AbortSignal.timeout(15000),
  });
  if (!inventoryResponse.ok)
    throw new Error(`Account inventory unavailable: HTTP ${inventoryResponse.status}`);
  const inventory = (await inventoryResponse.json()) as { accounts: Account[] };
  const results = [];
  for (const account of inventory.accounts) {
    if (!account.enabled) continue;
    const observation = await probeAccount(account, {
      fetch: fetchImpl,
      now: options.now ?? Date.now,
      codexUrl: "https://chatgpt.com/backend-api/wham/usage",
      claudeUrl: "https://api.anthropic.com/v1/messages",
      codexCredential:
        options.codexCredential ??
        ((slot) =>
          options.dryRun
            ? loadCodexOAuth(options.apiUrl, options.apiKey, slot)
            : getValidCodexOAuth(options.apiUrl, options.apiKey, slot)),
      claudeCredential: async (a) => {
        return getClaudeAccountCredential({
          apiUrl: options.apiUrl,
          apiKey: options.apiKey,
          account: a,
          dryRun: options.dryRun,
          fetchImpl,
          now: options.now,
        });
      },
    });
    let published = false;
    if (!options.dryRun) {
      const response = await fetchImpl(
        `${options.sidecarUrl}/accounts/${encodeURIComponent(account.id)}/observation`,
        {
          method: "PUT",
          headers: sidecarHeaders,
          body: JSON.stringify(observation),
          signal: AbortSignal.timeout(15000),
        },
      );
      published = response.ok;
    }
    results.push({ accountId: account.id, state: observation.state, published });
  }
  if (!options.dryRun) {
    try {
      const response = await fetchImpl(`${options.sidecarUrl}/account-auth-notices/reconcile`, {
        method: "POST",
        headers: sidecarHeaders,
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) console.error("Account renewal notice reconciliation unavailable");
    } catch {
      console.error("Account renewal notice reconciliation unavailable");
    }
  }
  return results;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== "--dry-run" && a !== "--config-stdin")) {
    console.error("Usage: bun scripts/account-capacity-probe.ts [--dry-run] [--config-stdin]");
    process.exit(2);
  }
  let input: { apiKey?: string; sidecarToken?: string; apiUrl?: string; sidecarUrl?: string } = {};
  if (args.includes("--config-stdin")) {
    try {
      input = JSON.parse(await Bun.stdin.text());
    } catch {
      console.error("Invalid probe configuration on stdin");
      process.exit(2);
    }
  }
  const apiKey = input.apiKey ?? getApiKey();
  const sidecarToken = input.sidecarToken ?? process.env.SIDECAR_TOKEN;
  if (!apiKey || !sidecarToken) {
    console.error("Swarm and sidecar credentials must be provided through the environment");
    process.exit(2);
  }
  try {
    const results = await collectAccounts({
      apiUrl: input.apiUrl ?? process.env.SWARM_API_URL ?? "http://localhost:3013",
      apiKey,
      sidecarUrl: input.sidecarUrl ?? process.env.SIDECAR_URL ?? "http://localhost:3020",
      sidecarToken,
      dryRun: args.includes("--dry-run"),
    });
    console.log(JSON.stringify({ results }));
    if (!args.includes("--dry-run") && results.some((r) => !r.published)) process.exitCode = 1;
  } catch {
    console.error(
      "Account collection failed; prior observations will expire. No credentials logged.",
    );
    process.exitCode = 1;
  }
}
