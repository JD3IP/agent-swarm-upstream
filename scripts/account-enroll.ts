/** Import an independently signed-in account without replacing another pool slot.
 * Public account policy is a JSON file; credentials are read from a private file.
 * A failed multi-service update deliberately leaves the account disabled.
 */

import { claudeAccountIdentity, codexAccountIdentity } from "../src/utils/account-identity.ts";
import { getApiKey } from "../src/utils/api-key.ts";
import {
  CLAUDE_POOL_LOCK,
  type ClaudeOAuthCredential,
  claudeCredential,
  claudeCredentialRecord,
  replaceClaudeSlot,
} from "./claude-account-credentials.ts";

export { replaceClaudeSlot } from "./claude-account-credentials.ts";

interface CredentialFile extends Partial<ClaudeOAuthCredential> {
  tokens?: { access_token?: string; refresh_token?: string; account_id?: string };
  token?: string;
  claudeAiOauth?: unknown;
}
interface AccountPolicy {
  id: string;
  identityKey?: string;
  provider: string;
  credentialGeneration: number;
  enabled: boolean;
  credentialRef: { keyType: string; scope: string; scopeId: string | null; index: number };
}
interface ExistingAccount extends AccountPolicy {
  identityKey: string;
  activeReservations?: unknown[];
}
interface ConfigRow {
  key: string;
  value: string;
  scope: string;
}

export function codexIdentity(auth: CredentialFile): { identityKey: string; credentials: object } {
  const t = auth?.tokens;
  if (!t?.access_token || !t?.refresh_token || !t?.account_id)
    throw new Error("Incomplete Codex login file");
  const payload = JSON.parse(
    Buffer.from(t.access_token.split(".")[1] ?? "", "base64url").toString(),
  );
  const user = payload["https://api.openai.com/auth"]?.chatgpt_user_id ?? payload.sub;
  if (
    typeof user !== "string" ||
    !user ||
    !Number.isFinite(payload.exp) ||
    payload.exp * 1000 <= Date.now()
  )
    throw new Error("Codex identity or expiry missing");
  return {
    identityKey: codexAccountIdentity(t.access_token, t.account_id),
    credentials: {
      access: t.access_token,
      refresh: t.refresh_token,
      expires: payload.exp * 1000,
      accountId: t.account_id,
    },
  };
}

export async function enroll(options: {
  spec: AccountPolicy;
  credential: CredentialFile;
  apiUrl: string;
  apiKey: string;
  sidecarUrl: string;
  sidecarToken: string;
  fetchImpl?: typeof fetch;
}): Promise<{ accountId: string; identityKey: string; enabled: boolean }> {
  const request = options.fetchImpl ?? fetch;
  let lockDeadline: number | undefined;
  async function json<T = unknown>(
    url: string,
    token: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    if (
      lockDeadline !== undefined &&
      method !== "GET" &&
      method !== "DELETE" &&
      Date.now() >= lockDeadline
    )
      throw new Error("Enrollment refresh lock expired");
    const response = await request(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(url.startsWith("https://api.anthropic.com/")
          ? { "anthropic-beta": "oauth-2025-04-20" }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Enrollment request failed: HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }
  const { id, identityKey: expectedIdentity, ...policy } = options.spec;
  if (
    typeof id !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id) ||
    !Number.isSafeInteger(policy.credentialGeneration) ||
    policy.credentialGeneration < 1
  )
    throw new Error("Invalid account policy");
  const ref = policy.credentialRef;
  if (
    !ref ||
    ref.scope !== "global" ||
    ref.scopeId !== null ||
    !Number.isSafeInteger(ref.index) ||
    ref.index < 0
  )
    throw new Error("Enrollment requires a global pool slot");
  if (
    (policy.provider === "codex" && ref.keyType !== "codex_oauth") ||
    (policy.provider === "claude" && ref.keyType !== "claude_oauth")
  )
    throw new Error("Provider/reference mismatch");
  const inventory = await json<{ accounts: ExistingAccount[] }>(
    `${options.sidecarUrl}/accounts`,
    options.sidecarToken,
  );
  const previous = inventory.accounts.find((a) => a.id === id);
  if (previous?.activeReservations?.length)
    throw new Error("Drain account sessions before enrollment");
  if (previous && policy.credentialGeneration <= previous.credentialGeneration)
    throw new Error("Enrollment must advance the credential generation");
  if (
    inventory.accounts.some(
      (a) => a.id !== id && JSON.stringify(a.credentialRef) === JSON.stringify(ref),
    )
  )
    throw new Error("Pool slot already registered");
  let identityKey: string;
  let stored: string;
  let configKey: string;
  let claude: ClaudeOAuthCredential | undefined;
  if (policy.provider === "codex") {
    const account = codexIdentity(options.credential);
    identityKey = account.identityKey;
    stored = JSON.stringify(account.credentials);
    configKey = `codex_oauth_${ref.index}`;
  } else if (policy.provider === "claude") {
    claude = claudeCredential(options.credential);
    if (
      claude.expiresAt <= Date.now() ||
      (claude.refreshTokenExpiresAt != null && claude.refreshTokenExpiresAt <= Date.now())
    )
      throw new Error("Claude CLI login is expired");
    const token = claude.accessToken;
    const profile = await json<{ account?: { uuid?: string } }>(
      "https://api.anthropic.com/api/oauth/profile",
      token,
    );
    const uuid = profile?.account?.uuid;
    if (typeof uuid !== "string" || !uuid)
      throw new Error("Claude profile did not establish account identity");
    identityKey = claudeAccountIdentity(profile);
    stored = token;
    configKey = "CLAUDE_CODE_OAUTH_TOKEN";
  } else throw new Error("Unsupported provider");
  if (
    (expectedIdentity && expectedIdentity !== identityKey) ||
    (previous && previous.identityKey !== identityKey)
  )
    throw new Error("Account identity does not match the requested enrollment");
  if (
    inventory.accounts.some(
      (a) => a.id !== id && a.provider === policy.provider && a.identityKey === identityKey,
    )
  )
    throw new Error("Provider identity already enrolled");
  // Lock the same Codex key as the refresh broker. Claude pool imports serialize together.
  const lockUrl = `${options.apiUrl}/api/oauth/refresh-locks/${encodeURIComponent(policy.provider === "codex" ? configKey : CLAUDE_POOL_LOCK)}`;
  const lockTtl = policy.provider === "claude" ? 300000 : 120000;
  const lockStarted = Date.now();
  const lock = await json<{ owner: string }>(lockUrl, options.apiKey, "POST", { ttlMs: lockTtl });
  lockDeadline = lockStarted + lockTtl - 1000;
  try {
    const accountPolicy = { ...policy, identityKey, enabled: false };
    await json(`${options.sidecarUrl}/accounts/${id}`, options.sidecarToken, "PUT", accountPolicy);
    if (policy.provider === "claude") {
      await json(`${options.apiUrl}/api/config`, options.apiKey, "PUT", {
        scope: "global",
        key: `claude_oauth_${ref.index}`,
        value: JSON.stringify(claudeCredentialRecord(identityKey, claude!)),
        isSecret: true,
        description: "Managed Claude refresh credential (central broker only)",
      });
      const data = await json<ConfigRow[] | { configs: ConfigRow[] }>(
        `${options.apiUrl}/api/config?includeSecrets=true`,
        options.apiKey,
      );
      const rows = Array.isArray(data) ? data : data.configs;
      if (!Array.isArray(rows)) throw new Error("Config inventory unavailable");
      const row = rows.find((r) => r.key === configKey && r.scope === "global");
      stored = replaceClaudeSlot(row?.value ?? "", ref.index, stored);
    }
    await json(`${options.apiUrl}/api/config`, options.apiKey, "PUT", {
      scope: "global",
      key: configKey,
      value: stored,
      isSecret: true,
      description: "Managed subscription account pool",
    });
    await json(`${options.sidecarUrl}/accounts/${id}`, options.sidecarToken, "PUT", {
      ...accountPolicy,
      enabled: policy.enabled === true,
    });
    return { accountId: id, identityKey, enabled: policy.enabled === true };
  } finally {
    // Lock expiry handles a failed release. Never echo a response or exception body.
    try {
      await json(lockUrl, options.apiKey, "DELETE", { owner: lock.owner });
    } catch {
      /* TTL */
    }
  }
}

if (import.meta.main) {
  if (process.argv.length !== 4) {
    console.error(
      "Usage: bun scripts/account-enroll.ts <public-account-policy.json> <private-credential.json>",
    );
    process.exit(2);
  }
  try {
    const apiKey = getApiKey();
    const sidecarToken = process.env.SIDECAR_TOKEN;
    if (!apiKey || !sidecarToken) throw new Error("Missing credentials");
    const result = await enroll({
      spec: await Bun.file(process.argv[2]!).json(),
      credential: await Bun.file(process.argv[3]!).json(),
      apiUrl: process.env.SWARM_API_URL ?? "http://localhost:3013",
      apiKey,
      sidecarUrl: process.env.SIDECAR_URL ?? "http://localhost:3020",
      sidecarToken,
    });
    console.log(JSON.stringify(result));
  } catch {
    console.error(
      "Account enrollment failed. Check target identity, generation and access; any partial registration remains disabled.",
    );
    process.exitCode = 1;
  }
}
