import { expect, test } from "bun:test";
import { codexIdentity, enroll, replaceClaudeSlot } from "./account-enroll.ts";

const token = (subject: string) =>
  `fake.${Buffer.from(JSON.stringify({ sub: subject, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fake`;
const auth = (subject = "user-b") => ({
  tokens: {
    access_token: token(subject),
    refresh_token: "private-refresh",
    account_id: "shared-workspace",
  },
});
const spec = {
  id: "codex-b",
  label: "Second Codex account",
  provider: "codex",
  credentialGeneration: 1,
  credentialRef: { keyType: "codex_oauth", scope: "global", scopeId: null, index: 2 },
  enabled: true,
  allowedRoles: ["lead", "build"],
  allowedModels: ["test-model"],
};

test("identity includes user as well as shared workspace and exposes no credentials", () => {
  expect(codexIdentity(auth("user-a")).identityKey).not.toBe(
    codexIdentity(auth("user-b")).identityKey,
  );
  expect(codexIdentity(auth()).identityKey).toMatch(/^[a-f0-9]{64}$/);
  expect(() => codexIdentity({ tokens: {} })).toThrow();
});
test("Claude original indices are preserved and sparse imports refused", () => {
  expect(replaceClaudeSlot("account-a,old-b", 1, "new-b")).toBe("account-a,new-b");
  expect(replaceClaudeSlot("account-a", 1, "new-b")).toBe("account-a,new-b");
  expect(() => replaceClaudeSlot("account-a", 2, "new-b")).toThrow();
  expect(() => replaceClaudeSlot("a,,b", 1, "new-b")).toThrow();
});

function fixture(existing: unknown[] = [], failConfig = false) {
  const writes: { url: string; method: string; body: Record<string, unknown> }[] = [];
  return {
    writes,
    options: {
      spec,
      credential: auth(),
      apiUrl: "http://swarm.invalid",
      apiKey: "api-secret",
      sidecarUrl: "http://sidecar.invalid",
      sidecarToken: "sidecar-secret",
      fetchImpl: (async (url, init) => {
        if (!init?.method || init.method === "GET") return Response.json({ accounts: existing });
        const body = JSON.parse(String(init?.body));
        writes.push({ url: String(url), method: init.method, body });
        if (failConfig && String(url).endsWith("/api/config"))
          return new Response("do not echo sensitive error", { status: 503 });
        return Response.json(
          String(url).includes("/refresh-locks/") ? { owner: "lock-owner" } : {},
        );
      }) as typeof fetch,
    },
  };
}
test("Codex enrollment changes exactly the requested slot, disabled until broker persistence", async () => {
  const f = fixture();
  const result = await enroll(f.options);
  const configs = f.writes.filter((w) => w.url.endsWith("/api/config"));
  expect(configs).toHaveLength(1);
  expect(configs[0]?.body.key).toBe("codex_oauth_2");
  const policies = f.writes.filter((w) => w.url.endsWith("/accounts/codex-b"));
  expect(policies.map((w) => w.body.enabled)).toEqual([false, true]);
  expect(JSON.stringify(result)).not.toContain("private-refresh");
  expect(f.writes.at(-1)).toMatchObject({ method: "DELETE", body: { owner: "lock-owner" } });
});
test("mismatched enrolled identity and duplicate identity make zero mutations", async () => {
  for (const existing of [
    [
      {
        ...spec,
        identityKey: "different-identity",
        credentialGeneration: 0,
        activeReservations: [],
      },
    ],
    [
      {
        ...spec,
        id: "another",
        credentialRef: { ...spec.credentialRef, index: 0 },
        identityKey: codexIdentity(auth()).identityKey,
      },
    ],
  ]) {
    const f = fixture(existing);
    await expect(enroll(f.options)).rejects.toThrow();
    expect(f.writes).toEqual([]);
  }
});
test("failed broker persistence leaves target disabled and releases refresh lock", async () => {
  const f = fixture([], true);
  await expect(enroll(f.options)).rejects.toThrow("HTTP 503");
  const policies = f.writes.filter((w) => w.url.endsWith("/accounts/codex-b"));
  expect(policies.map((w) => w.body.enabled)).toEqual([false]);
  expect(f.writes.at(-1)?.method).toBe("DELETE");
});
test("active target and missing generation advancement prevent replacement", async () => {
  for (const existing of [
    [
      {
        ...spec,
        identityKey: codexIdentity(auth()).identityKey,
        credentialGeneration: 1,
        activeReservations: [],
      },
    ],
    [
      {
        ...spec,
        identityKey: codexIdentity(auth()).identityKey,
        credentialGeneration: 0,
        activeReservations: [{ state: "active" }],
      },
    ],
  ]) {
    const f = fixture(existing);
    await expect(enroll(f.options)).rejects.toThrow();
    expect(f.writes).toEqual([]);
  }
});
