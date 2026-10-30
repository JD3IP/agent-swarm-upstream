/** One central writer owns each Claude refresh family; providers receive access tokens only. */
import { claudeAccountIdentity } from "../src/utils/account-identity.ts";

export const CLAUDE_POOL_LOCK = "claude-account-enrollment";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const LOCK_TTL_MS = 300_000;
export class ClaudeAccountAuthError extends Error {}
export class ClaudeReauthenticationRequiredError extends Error {}
type Ref = { scope: string; scopeId: string | null; index: number; keyType: string };
type Row = { key: string; value: string; scope: string; scopeId?: string | null };
export interface ClaudeOAuthCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshTokenExpiresAt?: number | null;
  scopes: string[];
  clientId: string;
}
interface RecordValue {
  version: 1;
  identityKey: string;
  credentials: ClaudeOAuthCredential;
  pendingRefresh?: ClaudeOAuthCredential;
  refreshInFlight?: boolean;
  authInvalid?: boolean;
}

export function claudeCredential(input: unknown): ClaudeOAuthCredential {
  const wrapper = input as { claudeAiOauth?: unknown } | null;
  const value = (wrapper?.claudeAiOauth ?? input) as Partial<ClaudeOAuthCredential> | null;
  if (
    !value ||
    typeof value.accessToken !== "string" ||
    !value.accessToken ||
    /[\r\n,]/.test(value.accessToken) ||
    typeof value.refreshToken !== "string" ||
    !value.refreshToken ||
    !Number.isFinite(value.expiresAt) ||
    Number(value.expiresAt) <= 0 ||
    !Array.isArray(value.scopes) ||
    !value.scopes.every((s) => typeof s === "string" && !!s) ||
    !value.scopes.includes("user:profile") ||
    !value.scopes.includes("user:inference") ||
    (value.refreshTokenExpiresAt != null &&
      (!Number.isFinite(value.refreshTokenExpiresAt) || value.refreshTokenExpiresAt <= 0)) ||
    (value.clientId !== undefined && (typeof value.clientId !== "string" || !value.clientId))
  ) {
    throw new Error("Claude enrollment requires a full profile-scoped CLI OAuth credential");
  }
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: Number(value.expiresAt),
    refreshTokenExpiresAt: value.refreshTokenExpiresAt,
    scopes: [...value.scopes],
    clientId: value.clientId ?? CLIENT_ID,
  };
}

export function replaceClaudeSlot(pool: string, index: number, token: string): string {
  const values = pool ? pool.split(",").map((v) => v.trim()) : [];
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index > values.length ||
    !token ||
    /[\r\n,]/.test(token) ||
    values.some((v) => !v)
  )
    throw new Error("Invalid Claude slot");
  values[index] = token;
  return values.join(",");
}

export function claudeCredentialRecord(
  identityKey: string,
  credentials: ClaudeOAuthCredential,
): RecordValue {
  return { version: 1, identityKey, credentials };
}

export async function getClaudeAccountCredential(options: {
  apiUrl: string;
  apiKey: string;
  account: { identityKey: string; credentialRef: Ref };
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<string | null> {
  const request = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const ref = options.account.credentialRef;
  if (
    ref.keyType !== "claude_oauth" ||
    !["global", "agent"].includes(ref.scope) ||
    (ref.scope === "global" ? ref.scopeId !== null : !ref.scopeId) ||
    !Number.isSafeInteger(ref.index) ||
    ref.index < 0
  )
    return null;
  const key = `claude_oauth_${ref.index}`;
  const headers = { Authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" };
  const lockUrl = `${options.apiUrl}/api/oauth/refresh-locks/${CLAUDE_POOL_LOCK}`;
  async function json(url: string, init?: RequestInit): Promise<unknown> {
    const response = await request(url, { ...init, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      if (
        url === "https://api.anthropic.com/api/oauth/profile" &&
        [401, 403].includes(response.status)
      )
        throw new ClaudeAccountAuthError("Claude profile authorization unavailable");
      throw new Error(`Claude credential broker request failed: HTTP ${response.status}`);
    }
    return response.status === 204 ? null : response.json();
  }
  async function rows(): Promise<Row[]> {
    const result = (await json(`${options.apiUrl}/api/config?includeSecrets=true`, { headers })) as
      | Row[]
      | { configs: Row[] };
    const list = Array.isArray(result) ? result : result.configs;
    if (!Array.isArray(list)) throw new Error("Claude credential inventory unavailable");
    return list;
  }
  const find = (list: Row[], name: string) =>
    list.find(
      (r) => r.key === name && r.scope === ref.scope && (r.scopeId ?? null) === ref.scopeId,
    );
  function read(list: Row[]): RecordValue | null {
    const row = find(list, key);
    if (!row) return null;
    const parsed = JSON.parse(row.value) as RecordValue;
    if (parsed.version !== 1 || parsed.identityKey !== options.account.identityKey)
      throw new Error("Claude credential identity mismatch");
    if (parsed.authInvalid)
      throw new ClaudeAccountAuthError("Claude account requires renewed login");
    return {
      ...parsed,
      credentials: claudeCredential(parsed.credentials),
      ...(parsed.pendingRefresh ? { pendingRefresh: claudeCredential(parsed.pendingRefresh) } : {}),
    };
  }
  let list = await rows();
  let record = read(list);
  const poolToken = () =>
    find(list, "CLAUDE_CODE_OAUTH_TOKEN")?.value.split(",")[ref.index]?.trim() ?? null;
  // Existing access-only pools remain observable, but cannot refresh without a full enrollment.
  if (!record) return poolToken();
  if (options.dryRun)
    return !record.refreshInFlight &&
      !record.pendingRefresh &&
      record.credentials.expiresAt > now() &&
      poolToken() === record.credentials.accessToken
      ? poolToken()
      : null;
  const started = now();
  const lock = (await json(lockUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ ttlMs: LOCK_TTL_MS }),
  })) as { owner: string };
  const lease = () => {
    if (now() - started >= LOCK_TTL_MS - 1000) throw new Error("Claude refresh lock expired");
  };
  async function write(name: string, value: unknown): Promise<void> {
    lease();
    await json(`${options.apiUrl}/api/config`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        scope: ref.scope,
        scopeId: ref.scopeId,
        key: name,
        value: typeof value === "string" ? value : JSON.stringify(value),
        isSecret: true,
        description: "Managed Claude subscription credential",
      }),
    });
  }
  try {
    list = await rows();
    record = read(list);
    if (!record) return null;
    if (record.refreshInFlight && !record.pendingRefresh)
      throw new ClaudeReauthenticationRequiredError(
        "Claude refresh outcome is unconfirmed; renew this login",
      );
    let candidate = record.pendingRefresh ?? record.credentials;
    if (
      !record.pendingRefresh &&
      candidate.expiresAt - now() > 120_000 &&
      poolToken() === candidate.accessToken
    )
      return candidate.accessToken;
    if (candidate.expiresAt - now() <= 120_000) {
      if (candidate.refreshTokenExpiresAt != null && candidate.refreshTokenExpiresAt <= now())
        throw new ClaudeAccountAuthError("Claude refresh credential expired");
      // A crash/timeout after this durable marker must never replay an uncertain rotating token.
      await write(key, { ...record, pendingRefresh: undefined, refreshInFlight: true });
      const refreshed = await request("https://platform.claude.com/v1/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: candidate.refreshToken,
          client_id: candidate.clientId,
          scope: candidate.scopes.join(" "),
        }),
      });
      if (!refreshed.ok) {
        const error = (await refreshed.json().catch(() => ({}))) as { error?: unknown };
        if (refreshed.status === 401 || error.error === "invalid_grant") {
          await write(key, { ...record, authInvalid: true, refreshInFlight: false });
          throw new ClaudeAccountAuthError("Claude refresh credential requires renewed login");
        }
        if (refreshed.status === 429) await write(key, { ...record, refreshInFlight: false });
        throw new Error(`Claude OAuth refresh failed: HTTP ${refreshed.status}`);
      }
      const data = (await refreshed.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        refresh_token_expires_in?: number;
        scope?: string;
      };
      if (
        !Number.isFinite(data.expires_in) ||
        Number(data.expires_in) <= 0 ||
        Number(data.expires_in) > 31_536_000
      )
        throw new Error("Claude refresh expiry missing");
      candidate = claudeCredential({
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? candidate.refreshToken,
        expiresAt: now() + Number(data.expires_in) * 1000,
        refreshTokenExpiresAt:
          data.refresh_token_expires_in === undefined
            ? candidate.refreshTokenExpiresAt
            : now() + data.refresh_token_expires_in * 1000,
        scopes:
          data.scope === undefined ? candidate.scopes : data.scope.split(/\s+/).filter(Boolean),
        clientId: candidate.clientId,
      });
      // Save rotated family first, as an unusable candidate, so a profile outage cannot lose it.
      record = { ...record, refreshInFlight: false, pendingRefresh: candidate };
      await write(key, record);
    }
    if (candidate.expiresAt <= now()) return null;
    const profile = await json("https://api.anthropic.com/api/oauth/profile", {
      headers: {
        Authorization: `Bearer ${candidate.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
    if (claudeAccountIdentity(profile) !== options.account.identityKey) {
      await write(key, { ...record, authInvalid: true });
      throw new ClaudeAccountAuthError("Claude refreshed credential identity mismatch");
    }
    lease();
    // Canonical tuple is saved before its access-only pool projection; the next run reconciles either crash point.
    if (record.pendingRefresh || record.refreshInFlight)
      await write(key, claudeCredentialRecord(record.identityKey, candidate));
    const pool = replaceClaudeSlot(
      find(list, "CLAUDE_CODE_OAUTH_TOKEN")?.value ?? "",
      ref.index,
      candidate.accessToken,
    );
    if (pool !== find(list, "CLAUDE_CODE_OAUTH_TOKEN")?.value)
      await write("CLAUDE_CODE_OAUTH_TOKEN", pool);
    return candidate.accessToken;
  } finally {
    try {
      await json(lockUrl, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ owner: lock.owner }),
      });
    } catch {
      /* TTL fences a failed release. */
    }
  }
}
