import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { handleOAuthLocks } from "../src/http/oauth-locks.ts";
import { claudeAccountIdentity } from "../src/utils/account-identity.ts";
import {
  ClaudeAccountAuthError,
  ClaudeReauthenticationRequiredError,
  claudeCredential,
  claudeCredentialRecord,
  getClaudeAccountCredential,
} from "./claude-account-credentials.ts";

function fixture() {
  let time = 1_900_000_000_000;
  const profile = { account: { uuid: "fixture-account-b" } };
  const credential = claudeCredential({
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: time + 30_000,
    refreshTokenExpiresAt: time + 86_400_000,
    scopes: ["user:profile", "user:inference"],
  });
  const account = {
    identityKey: claudeAccountIdentity(profile),
    credentialRef: { keyType: "claude_oauth", scope: "global", scopeId: null, index: 1 },
  };
  const rows = [
    {
      scope: "global",
      key: "claude_oauth_1",
      value: JSON.stringify(claudeCredentialRecord(account.identityKey, credential)),
    },
    { scope: "global", key: "CLAUDE_CODE_OAUTH_TOKEN", value: "neighbor-a,old-access,neighbor-c" },
  ];
  let locked = false;
  const requests: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  const controls = {
    profileFailure: false,
    wrongIdentity: false,
    failPoolWrite: false,
    refreshStatus: 200,
    expireLockOnProfile: false,
  };
  const request = (async (input, init) => {
    const url = String(input),
      method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    requests.push({ url, method, body });
    if (url.includes("refresh-locks")) {
      if (method === "DELETE") {
        locked = false;
        return new Response(null, { status: 204 });
      }
      if (locked) return new Response(null, { status: 409 });
      locked = true;
      return Response.json({ owner: "fixture-owner" });
    }
    if (url.endsWith("/api/config?includeSecrets=true")) return Response.json(rows);
    if (url.endsWith("/api/config")) {
      if (body?.key === "CLAUDE_CODE_OAUTH_TOKEN" && controls.failPoolWrite)
        return new Response(null, { status: 503 });
      const row = rows.find((r) => r.key === body?.key)!;
      row.value = String(body?.value);
      return Response.json({});
    }
    if (url.endsWith("/v1/oauth/token")) {
      await Bun.sleep(5);
      if (controls.refreshStatus !== 200)
        return Response.json({ error: "invalid_grant" }, { status: controls.refreshStatus });
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        scope: "user:profile user:inference",
      });
    }
    if (url.endsWith("/api/oauth/profile")) {
      if (controls.expireLockOnProfile) time += 300_000;
      if (controls.profileFailure) return new Response(null, { status: 503 });
      return Response.json(
        controls.wrongIdentity ? { account: { uuid: "other-account" } } : profile,
      );
    }
    throw new Error("Unexpected fixture request");
  }) as typeof fetch;
  return {
    rows,
    requests,
    controls,
    account,
    credential,
    advance: (ms: number) => {
      time += ms;
    },
    options: {
      apiUrl: "http://api.fixture",
      apiKey: "fixture-key",
      account,
      fetchImpl: request,
      now: () => time,
    },
    record: () => JSON.parse(rows[0]!.value),
    pool: () => rows[1]!.value,
    refreshes: () => requests.filter((r) => r.url.endsWith("/v1/oauth/token")),
  };
}

describe("central Claude refresh broker", () => {
  test("real API SQLite lock fences concurrent independent broker invocations", async () => {
    const f = fixture();
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://fixture");
      void handleOAuthLocks(req, res, url.pathname.split("/").filter(Boolean), url.searchParams);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      const apiUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      const options = {
        ...f.options,
        apiUrl,
        fetchImpl: (async (url, init) =>
          String(url).includes("/refresh-locks/")
            ? fetch(url, init)
            : f.options.fetchImpl(url, init)) as typeof fetch,
      };
      const results = await Promise.allSettled([
        getClaudeAccountCredential(options),
        getClaudeAccountCredential(options),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(f.refreshes()).toHaveLength(1);
      expect(await getClaudeAccountCredential(options)).toBe("new-access");
      expect(f.pool()).toBe("neighbor-a,new-access,neighbor-c");
      expect(f.refreshes()).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  test("requires full profile-scoped credentials instead of setup-token", () => {
    const f = fixture();
    expect(claudeCredential({ claudeAiOauth: f.credential })).toEqual(f.credential);
    expect(() => claudeCredential({ ...f.credential, scopes: ["user:inference"] })).toThrow();
    expect(() => claudeCredential({ token: "inference-only" })).toThrow();
  });
  test("rotates one family, persists the tuple before the pool, preserving original indices", async () => {
    const f = fixture();
    expect(await getClaudeAccountCredential(f.options)).toBe("new-access");
    expect(f.pool()).toBe("neighbor-a,new-access,neighbor-c");
    expect(f.record().credentials.refreshToken).toBe("new-refresh");
    expect(f.record().pendingRefresh).toBeUndefined();
    expect(f.refreshes()[0]?.body).toMatchObject({
      refresh_token: "old-refresh",
      scope: "user:profile user:inference",
    });
    const writes = f.requests.filter((r) => r.method === "PUT");
    expect(writes.map((w) => w.body?.key)).toEqual([
      "claude_oauth_1",
      "claude_oauth_1",
      "claude_oauth_1",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
    expect(writes.every((w) => w.body?.isSecret === true)).toBe(true);
    expect(f.requests.at(-1)?.method).toBe("DELETE");
    expect(await getClaudeAccountCredential(f.options)).toBe("new-access");
    expect(f.refreshes()).toHaveLength(1);
  });
  test("parallel observers never redeem the same refresh token twice", async () => {
    const f = fixture();
    const results = await Promise.allSettled([
      getClaudeAccountCredential(f.options),
      getClaudeAccountCredential(f.options),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(f.refreshes()).toHaveLength(1);
    expect(await getClaudeAccountCredential(f.options)).toBe("new-access");
    expect(f.refreshes()).toHaveLength(1);
  });
  test("profile outage retains rotated candidate but never publishes it until verified", async () => {
    const f = fixture();
    f.controls.profileFailure = true;
    await expect(getClaudeAccountCredential(f.options)).rejects.toThrow("HTTP 503");
    expect(f.pool()).toContain("old-access");
    expect(f.record().pendingRefresh.refreshToken).toBe("new-refresh");
    f.controls.profileFailure = false;
    expect(await getClaudeAccountCredential(f.options)).toBe("new-access");
    expect(f.refreshes()).toHaveLength(1);
  });
  test("an expired unpublished candidate renews its known new family after a prolonged profile outage", async () => {
    const f = fixture();
    f.controls.profileFailure = true;
    await expect(getClaudeAccountCredential(f.options)).rejects.toThrow("HTTP 503");
    f.advance(3600_001);
    f.controls.profileFailure = false;
    expect(await getClaudeAccountCredential(f.options)).toBe("new-access");
    expect(f.refreshes().map((r) => r.body?.refresh_token)).toEqual(["old-refresh", "new-refresh"]);
    expect(f.record().pendingRefresh).toBeUndefined();
    expect(f.pool()).toBe("neighbor-a,new-access,neighbor-c");
  });
  test("an uncertain second rotation cannot replay its expired pending candidate", async () => {
    const f = fixture();
    f.controls.profileFailure = true;
    await expect(getClaudeAccountCredential(f.options)).rejects.toThrow("HTTP 503");
    f.advance(3600_001);
    f.controls.profileFailure = false;
    const options = {
      ...f.options,
      fetchImpl: (async (url, init) => {
        if (String(url).endsWith("/v1/oauth/token")) throw new Error("fixture timeout");
        return f.options.fetchImpl(url, init);
      }) as typeof fetch,
    };
    await expect(getClaudeAccountCredential(options)).rejects.toThrow("fixture timeout");
    expect(f.record().pendingRefresh).toBeUndefined();
    await expect(getClaudeAccountCredential(f.options)).rejects.toBeInstanceOf(
      ClaudeReauthenticationRequiredError,
    );
    expect(f.refreshes()).toHaveLength(1);
  });
  test("wrong profile cannot publish, and invalid refresh requires reenrollment without replay", async () => {
    for (const mode of ["wrongIdentity", "invalidGrant"] as const) {
      const f = fixture();
      if (mode === "wrongIdentity") f.controls.wrongIdentity = true;
      else f.controls.refreshStatus = 400;
      await expect(getClaudeAccountCredential(f.options)).rejects.toBeInstanceOf(
        ClaudeAccountAuthError,
      );
      expect(f.pool()).toContain("old-access");
      await expect(getClaudeAccountCredential(f.options)).rejects.toBeInstanceOf(
        ClaudeAccountAuthError,
      );
      expect(f.refreshes()).toHaveLength(1);
    }
  });
  test("pool write failure recovers from canonical rotated metadata without another refresh", async () => {
    const f = fixture();
    f.controls.failPoolWrite = true;
    await expect(getClaudeAccountCredential(f.options)).rejects.toThrow("HTTP 503");
    expect(f.record().credentials.refreshToken).toBe("new-refresh");
    f.controls.failPoolWrite = false;
    expect(await getClaudeAccountCredential(f.options)).toBe("new-access");
    expect(f.refreshes()).toHaveLength(1);
  });
  test("expired lock cannot publish and dry run never mutates or refreshes", async () => {
    const f = fixture();
    expect(await getClaudeAccountCredential({ ...f.options, dryRun: true })).toBe("old-access");
    expect(f.requests.map((r) => r.method)).toEqual(["GET"]);
    f.controls.expireLockOnProfile = true;
    await expect(getClaudeAccountCredential(f.options)).rejects.toThrow("lock expired");
    expect(f.pool()).toContain("old-access");
    expect(f.record().pendingRefresh.refreshToken).toBe("new-refresh");
  });
  test("an uncertain crash marker never redeems the refresh family again", async () => {
    const f = fixture();
    f.rows[0]!.value = JSON.stringify({ ...f.record(), refreshInFlight: true });
    await expect(getClaudeAccountCredential(f.options)).rejects.toBeInstanceOf(
      ClaudeReauthenticationRequiredError,
    );
    expect(f.refreshes()).toHaveLength(0);
  });
});
