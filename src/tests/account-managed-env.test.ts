import { afterEach, describe, expect, test } from "bun:test";
import { AccountCapacityWaitError, verifyAccountAdmission } from "../commands/account-admission";
import { fetchResolvedEnv } from "../commands/runner";

const savedFetch = globalThis.fetch;
const savedManaged = process.env.SWARM_ACCOUNT_MANAGED;
afterEach(() => {
  globalThis.fetch = savedFetch;
  if (savedManaged === undefined) delete process.env.SWARM_ACCOUNT_MANAGED;
  else process.env.SWARM_ACCOUNT_MANAGED = savedManaged;
});

const agentId = "managed-worker";
const model = "claude-sonnet-4-6";
const binding = {
  managed: true,
  state: "ready",
  accountId: "claude-second",
  provider: "claude",
  model,
  credentialRef: { keyType: "claude_oauth", scope: "global", scopeId: null, index: 1 },
  credentialGeneration: 1,
  admissionId: "reservation",
  generation: 1,
  owner: `account-controller:${agentId}`,
  taskId: "reserved-task",
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
  role: "triage",
};

describe("managed resolved config integration", () => {
  test("fresh merged config selects original Claude source index instead of random selection", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        configs: [
          { key: "SWARM_ACCOUNT_MANAGED", value: "true", scope: "agent", scopeId: agentId },
          {
            key: "SWARM_ACCOUNT_BINDING",
            value: JSON.stringify(binding),
            scope: "agent",
            scopeId: agentId,
          },
          {
            key: "CLAUDE_CODE_OAUTH_TOKEN",
            value: "first,second,third",
            scope: "global",
            scopeId: null,
          },
          {
            key: "claude_oauth_1",
            value: "private-refresh-family",
            scope: "global",
            scopeId: null,
          },
          { key: "CLAUDE_OAUTH_7", value: "other-private-family", scope: "global", scopeId: null },
        ],
      })) as typeof fetch;
    const resolved = await fetchResolvedEnv("http://swarm.test", "test-key", agentId, {
      HARNESS_PROVIDER: "claude",
      MODEL_OVERRIDE: model,
      OPENAI_API_KEY: "paid-api",
      CLAUDE_OAUTH: "default-metadata-refresh-family",
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "inherited-refresh",
      CLAUDE_CODE_OAUTH_SCOPES: "user:profile user:inference",
    });
    expect(resolved.configFetched).toBe(true);
    expect(resolved.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("second");
    expect(resolved.env.OPENAI_API_KEY).toBe("");
    expect(resolved.env.CLAUDE_OAUTH).toBe("");
    expect(resolved.env.claude_oauth_1).toBe("");
    expect(resolved.env.CLAUDE_OAUTH_7).toBe("");
    expect(resolved.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBe("");
    expect(resolved.env.CLAUDE_CODE_OAUTH_SCOPES).toBe("");
    expect(JSON.stringify(resolved.env)).not.toContain("refresh-family");
    expect(resolved.credentialSelections[0]?.index).toBe(1);
    expect(process.env.SWARM_ACCOUNT_MANAGED).toBe("true");
  });

  test("API outage cannot use a cached ready binding or fallback credentials", async () => {
    process.env.SWARM_ACCOUNT_MANAGED = "true";
    globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
    const resolved = await fetchResolvedEnv("http://swarm.test", "test-key", agentId, {
      SWARM_ACCOUNT_BINDING: JSON.stringify(binding),
      HARNESS_PROVIDER: "claude",
      MODEL_OVERRIDE: model,
      CLAUDE_CODE_OAUTH_TOKEN: "first,second,third",
      ANTHROPIC_API_KEY: "paid-api",
    });
    expect(resolved.configFetched).toBe(false);
    expect(resolved.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
    expect(resolved.env.ANTHROPIC_API_KEY).toBe("");
    await expect(
      verifyAccountAdmission(resolved.env, resolved.configFetched, agentId, "claude", model),
    ).rejects.toThrow(AccountCapacityWaitError);
  });

  test("missing binding is normal waiting at boot and cannot disable the managed switch", async () => {
    process.env.SWARM_ACCOUNT_MANAGED = "true";
    globalThis.fetch = (async () =>
      Response.json({
        configs: [{ key: "SWARM_ACCOUNT_MANAGED", value: "false" }],
      })) as typeof fetch;
    const resolved = await fetchResolvedEnv("http://swarm.test", "test-key", agentId, {
      HARNESS_PROVIDER: "claude",
      CLAUDE_CODE_OAUTH_TOKEN: "inherited",
      ANTHROPIC_API_KEY: "paid-api",
    });
    expect(resolved.configFetched).toBe(true);
    expect(resolved.env.SWARM_ACCOUNT_MANAGED).toBe("true");
    expect(resolved.credentialSelections).toEqual([]);
    expect(resolved.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
    await expect(
      verifyAccountAdmission(resolved.env, true, agentId, "claude", model),
    ).rejects.toThrow(AccountCapacityWaitError);
  });
});
