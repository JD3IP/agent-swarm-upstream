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
  active?: boolean;
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

export function claudeWindows(
  body: unknown,
  models: string[],
): { windows: Window[]; complete: boolean } {
  const windows: Window[] = [];
  let complete = true;
  const object = (v: unknown): Record<string, unknown> | null =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  const value = object(body);
  if (!value) return { windows, complete: false };
  const family = (v: string) =>
    /(?:^|[\s/_-])(opus|sonnet|haiku|fable)(?=$|[\s/_-])/i.exec(v)?.[1]?.toLowerCase();
  function scoped(model: unknown): string[] | undefined {
    const scope = object(model);
    if (
      !scope ||
      (scope.id != null && typeof scope.id !== "string") ||
      (scope.display_name != null && typeof scope.display_name !== "string")
    )
      return undefined;
    const id = typeof scope.id === "string" ? scope.id : "";
    const category =
      family(id) ?? family(typeof scope.display_name === "string" ? scope.display_name : "");
    if (!category) return models.length === 1 && models[0] === id ? [id] : undefined;
    if (models.some((m) => m !== id && !family(m))) return undefined;
    return models.filter((m) => m === id || family(m) === category);
  }
  function append(
    raw: unknown,
    id: string,
    durationSeconds: number,
    applicable: string[] | null,
    canonical: boolean,
  ): void {
    const limit = object(raw) ?? {};
    const usedPercent = percent(canonical ? limit.percent : limit.utilization);
    const active = typeof limit.is_active === "boolean" ? limit.is_active : undefined;
    const blocked =
      usedPercent === 100 ||
      (typeof limit.locked_reason === "string" && !!limit.locked_reason.trim());
    if (limit.is_active !== undefined && active === undefined) {
      complete = false;
      return;
    }
    if (active === false && (usedPercent !== 0 || blocked)) {
      complete = false;
      return;
    }
    const reset = limit.resets_at;
    const resetsAt =
      typeof reset === "string" &&
      /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(reset) &&
      Number.isFinite(Date.parse(reset))
        ? new Date(reset).toISOString()
        : null;
    // Claude reports a fresh session as active with no reset until its first use.
    // Preserve that null; only this explicit canonical zero-usage shape is known.
    const unusedSession =
      canonical &&
      id === "session" &&
      active === true &&
      usedPercent === 0 &&
      !blocked &&
      reset === null;
    if (usedPercent === null || (active !== false && !resetsAt && !unusedSession)) complete = false;
    windows.push({
      id,
      durationSeconds,
      usedPercent,
      resetsAt,
      models: applicable,
      blocked,
      ...(active === undefined ? {} : { active }),
    });
  }
  const shared = new Set<string>();
  if (Object.hasOwn(value, "limits")) {
    if (!Array.isArray(value.limits)) return { windows, complete: false };
    for (const [index, raw] of value.limits.entries()) {
      const limit = object(raw);
      if (!limit) {
        complete = false;
        continue;
      }
      const inactive =
        limit.is_active === false && percent(limit.percent) === 0 && !limit.locked_reason;
      if (limit.kind === "session" || limit.kind === "weekly_all") {
        const expectedGroup = limit.kind === "session" ? "session" : "weekly";
        if (limit.group !== expectedGroup || limit.scope != null || shared.has(limit.kind)) {
          complete = false;
          continue;
        }
        shared.add(limit.kind);
        append(limit, limit.kind, limit.kind === "session" ? 18000 : 604800, null, true);
      } else if (limit.kind === "weekly_scoped" && limit.group === "weekly") {
        const scope = object(limit.scope);
        const applicable =
          scope &&
          scope.surface == null &&
          Object.keys(scope).every((k) => ["model", "surface"].includes(k))
            ? scoped(scope.model)
            : undefined;
        if (applicable === undefined) {
          if (!inactive) complete = false;
          continue;
        }
        if (applicable.length) append(limit, `weekly_scoped.${index}`, 604800, applicable, true);
      } else if (!inactive) complete = false;
    }
    if (!shared.has("session") || !shared.has("weekly_all")) complete = false;
  } else {
    if (!Object.hasOwn(value, "five_hour") && !Object.hasOwn(value, "seven_day"))
      return { windows, complete: false };
    for (const name of ["five_hour", "seven_day"]) {
      if (!Object.hasOwn(value, name)) complete = false;
      append(value[name], name, name === "five_hour" ? 18000 : 604800, null, false);
    }
    for (const [name, raw] of Object.entries(value)) {
      if (["five_hour", "seven_day", "extra_usage"].includes(name) || raw == null) continue;
      if (name.startsWith("seven_day_")) {
        const applicable = scoped({ display_name: name.slice("seven_day_".length) });
        if (applicable === undefined) {
          complete = false;
          continue;
        }
        if (applicable.length) append(raw, name, 604800, applicable, false);
      } else if (object(raw) && Object.hasOwn(raw as object, "utilization")) complete = false;
    }
  }
  return { windows, complete };
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
      observation.authState = "healthy";
      response = await deps.fetch(deps.claudeUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${credential}`,
          "anthropic-beta": "oauth-2025-04-20",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(20000),
      });
      if (response.ok) {
        const parsed = claudeWindows(await response.json(), account.allowedModels);
        observation.windows = parsed.windows;
        observation.authState = "healthy";
        observation.state = parsed.complete && observation.windows.length ? "healthy" : "unknown";
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
      claudeUrl: "https://api.anthropic.com/api/oauth/usage",
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
