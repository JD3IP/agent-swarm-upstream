import { afterEach, describe, expect, test } from "bun:test";
import {
  type AccountAdmission,
  type AccountBinding,
  AccountCapacityWaitError,
  accountAdmissionClient,
  assertAdmissionMatches,
  classifyAccountIncident,
  completeManagedAccountSession,
  loadExpectedAccountIdentity,
  maintainAccountAdmission,
  managedTaskModel,
  readAccountBinding,
  selectManagedClaudeCredential,
  verifyAccountAdmission,
  verifyTaskFilteredPollSupport,
} from "../commands/account-admission.ts";

const agentId = "worker-1";
const originalFetch = globalThis.fetch;
const originalManaged = process.env.SWARM_ACCOUNT_MANAGED;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalManaged === undefined) delete process.env.SWARM_ACCOUNT_MANAGED;
  else process.env.SWARM_ACCOUNT_MANAGED = originalManaged;
});

function binding(overrides: Partial<AccountBinding> = {}): AccountBinding {
  return {
    managed: true,
    state: "ready",
    accountId: "claude-account-2",
    provider: "claude",
    model: "claude-sonnet-4-6",
    credentialRef: { keyType: "claude_oauth", scope: "global", scopeId: null, index: 1 },
    credentialGeneration: 2,
    admissionId: "admission-1",
    generation: 7,
    owner: `account-controller:${agentId}`,
    taskId: "task-1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    role: "triage",
    ...overrides,
  };
}

function admission(b: AccountBinding, overrides: Partial<AccountAdmission> = {}): AccountAdmission {
  return {
    id: b.admissionId,
    generation: b.generation,
    owner: b.owner,
    accountId: b.accountId,
    provider: b.provider,
    model: b.model,
    role: b.role,
    credentialRef: b.credentialRef,
    credentialGeneration: b.credentialGeneration,
    taskId: b.taskId,
    sessionId: null,
    state: "reserved",
    eligible: true,
    expiresAt: b.expiresAt,
    ...overrides,
  };
}

function env(b: AccountBinding): Record<string, string> {
  return {
    SWARM_ACCOUNT_MANAGED: "true",
    SWARM_ACCOUNT_BINDING: JSON.stringify(b),
    SIDECAR_URL: "http://sidecar.test",
    SIDECAR_TOKEN: "test-only-sidecar-token",
  };
}

describe("managed account binding", () => {
  test("managed tier uses host's selected concrete model and checks preserved task intent", () => {
    const b = binding({ model: "host-concrete-model", modelTier: "regular" });
    expect(managedTaskModel(b, { modelTier: "regular" })).toBe("host-concrete-model");
    expect(() => managedTaskModel(b, { modelTier: "smart" })).toThrow(AccountCapacityWaitError);
    expect(() =>
      managedTaskModel(b, { modelTier: "regular", model: "different-explicit-model" }),
    ).toThrow(AccountCapacityWaitError);
    expect(() => managedTaskModel(b, {})).toThrow(AccountCapacityWaitError);
  });
  test("waiting, malformed, absent, expired or foreign bindings cannot admit work", () => {
    for (const value of [
      undefined,
      "invalid",
      JSON.stringify({ managed: true, state: "waiting" }),
      JSON.stringify(binding({ owner: "capacity:other" })),
      JSON.stringify(binding({ expiresAt: new Date(0).toISOString() })),
    ]) {
      expect(() => readAccountBinding({ SWARM_ACCOUNT_BINDING: value }, agentId)).toThrow(
        AccountCapacityWaitError,
      );
    }
  });

  test("agent-scoped Claude source may only belong to this worker; Codex requires broker global slots", () => {
    const own = binding({
      credentialRef: { keyType: "claude_oauth", scope: "agent", scopeId: agentId, index: 0 },
    });
    expect(readAccountBinding(env(own), agentId).credentialRef.scope).toBe("agent");
    for (const b of [
      binding({ credentialRef: { ...own.credentialRef, scopeId: "other" } }),
      binding({ provider: "codex" }),
      binding({ credentialRef: { ...own.credentialRef, scope: "global" } }),
    ]) {
      expect(() => readAccountBinding(env(b), agentId)).toThrow(AccountCapacityWaitError);
    }
  });

  test("Claude selection preserves original pool index and clears every alternate credential", () => {
    const b = binding();
    const resolved = {
      ...env(b),
      CLAUDE_CODE_OAUTH_TOKEN: "account-0,account-1,account-2",
      ANTHROPIC_API_KEY: "paid-key",
      OPENAI_API_KEY: "another-key",
      CODEX_OAUTH: "other-account",
    };
    const selections = selectManagedClaudeCredential(resolved, b, [
      {
        key: "CLAUDE_CODE_OAUTH_TOKEN",
        value: resolved.CLAUDE_CODE_OAUTH_TOKEN,
        scope: "global",
        scopeId: null,
      },
    ]);
    expect(selections).toEqual([
      {
        selected: "account-1",
        index: 1,
        total: 3,
        keySuffix: "unt-1",
        keyType: "CLAUDE_CODE_OAUTH_TOKEN",
        isRateLimitFallback: false,
      },
    ]);
    expect(resolved.CLAUDE_CODE_OAUTH_TOKEN).toBe("account-1");
    expect(resolved.ANTHROPIC_API_KEY).toBe("");
    expect(resolved.OPENAI_API_KEY).toBe("");
    expect(resolved.CODEX_OAUTH).toBe("");
  });

  test("Claude missing or shadowed source never uses env/API-key fallback", () => {
    for (const rows of [
      [],
      [
        {
          key: "CLAUDE_CODE_OAUTH_TOKEN",
          value: "account-0,account-1",
          scope: "agent",
          scopeId: agentId,
        },
      ],
    ]) {
      const resolved = {
        CLAUDE_CODE_OAUTH_TOKEN: "account-0,account-1",
        ANTHROPIC_API_KEY: "paid-key",
      };
      expect(() => selectManagedClaudeCredential(resolved, binding(), rows)).toThrow(
        AccountCapacityWaitError,
      );
      expect(resolved.ANTHROPIC_API_KEY).toBe("");
      expect(resolved.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
    }
  });
});

describe("authoritative reservation validation", () => {
  test("unmanaged workers retain legacy admission", async () => {
    delete process.env.SWARM_ACCOUNT_MANAGED;
    expect(await verifyAccountAdmission({}, false, agentId, "claude", "any")).toBeUndefined();
  });

  test("managed boot cannot bypass fresh config by removing the config switch", async () => {
    process.env.SWARM_ACCOUNT_MANAGED = "true";
    await expect(verifyAccountAdmission({}, false, agentId, "claude", "any")).rejects.toThrow(
      AccountCapacityWaitError,
    );
  });

  test("provider/model/task mismatch refuses before contacting sidecar", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("must not call");
    }) as typeof fetch;
    const b = binding();
    for (const args of [
      ["codex", b.model, "task-1"],
      ["claude", "wrong-model", "task-1"],
      ["claude", b.model, "task-2"],
    ]) {
      await expect(
        verifyAccountAdmission(env(b), true, agentId, args[0]!, args[1]!, args[2]!),
      ).rejects.toThrow(AccountCapacityWaitError);
    }
    expect(calls).toBe(0);
  });

  test("fresh reservation is checked before poll and active/released/stale generations refuse", async () => {
    const b = binding();
    globalThis.fetch = (async () => Response.json({ admission: admission(b) })) as typeof fetch;
    expect(
      (await verifyAccountAdmission(env(b), true, agentId, b.provider, b.model))?.binding
        .admissionId,
    ).toBe(b.admissionId);
    for (const update of [
      { state: "active" as const },
      { state: "released" as const },
      { generation: 8 },
      { credentialGeneration: 1 },
      { eligible: false },
      { accountId: "another-account" },
      { model: "wrong" },
      { expiresAt: new Date(0).toISOString() },
      { credentialRef: { ...b.credentialRef, index: 0 } },
    ]) {
      globalThis.fetch = (async () =>
        Response.json({ admission: admission(b, update) })) as typeof fetch;
      await expect(
        verifyAccountAdmission(env(b), true, agentId, b.provider, b.model),
      ).rejects.toThrow(AccountCapacityWaitError);
    }
  });

  test("sidecar outage and malformed response refuse; upstream body never leaks", async () => {
    const b = binding();
    for (const response of [
      new Response("credential-do-not-log", { status: 503 }),
      Response.json({}),
      Response.json({ admission: { id: b.admissionId } }),
    ]) {
      globalThis.fetch = (async () => response) as typeof fetch;
      await expect(
        verifyAccountAdmission(env(b), true, agentId, b.provider, b.model),
      ).rejects.toThrow();
    }
  });

  test("old APIs without task-filtered polling are refused before any claim", async () => {
    for (const data of [{}, { paths: { "/api/poll": { get: {} } } }]) {
      globalThis.fetch = (async () => Response.json(data)) as typeof fetch;
      await expect(
        verifyTaskFilteredPollSupport("http://swarm.test", "test-only-key"),
      ).rejects.toThrow(AccountCapacityWaitError);
    }
    globalThis.fetch = (async () =>
      Response.json({
        paths: { "/api/poll": { get: { parameters: [{ name: "taskId", in: "query" }] } } },
      })) as typeof fetch;
    await verifyTaskFilteredPollSupport("http://swarm.test", "test-only-key");
  });

  test("account identity metadata must match the selected source and generation", async () => {
    const b = binding();
    const account = {
      id: b.accountId,
      provider: b.provider,
      identityKey: "stable-account-identity",
      credentialRef: b.credentialRef,
      credentialGeneration: b.credentialGeneration,
    };
    globalThis.fetch = (async () => Response.json({ account })) as typeof fetch;
    expect(await loadExpectedAccountIdentity(env(b), b)).toBe(account.identityKey);
    for (const update of [
      { credentialGeneration: 3 },
      { id: "other-account" },
      { identityKey: "" },
      { credentialRef: { ...b.credentialRef, index: 0 } },
    ]) {
      globalThis.fetch = (async () =>
        Response.json({ account: { ...account, ...update } })) as typeof fetch;
      await expect(loadExpectedAccountIdentity(env(b), b)).rejects.toThrow(
        AccountCapacityWaitError,
      );
    }
  });

  test("quota completion saves the incident and parks work before releasing the stopped account", async () => {
    const b = binding();
    const calls: string[] = [];
    let payload: Record<string, unknown> = {};
    globalThis.fetch = (async (_url, init) => {
      calls.push("incident");
      payload = JSON.parse(String(init?.body));
      return Response.json({ ok: true });
    }) as typeof fetch;
    const client = {
      binding: b,
      request: async () => {
        calls.push("release");
        return admission(b, { state: "released" });
      },
    };
    const waiting = await completeManagedAccountSession(
      env(b),
      client,
      "nonce-1",
      {
        exitCode: 1,
        isError: true,
        failureReason: "[usage-limit] You have hit your usage limit",
        rateLimitResetAt: new Date(Date.now() + 600_000).toISOString(),
      },
      async () => {
        calls.push("park");
        return true;
      },
    );
    expect(waiting).toBe(true);
    expect(calls).toEqual(["incident", "park", "release"]);
    expect(payload.kind).toBe("quota");
    expect(payload.credentialGeneration).toBe(b.credentialGeneration);
    expect(payload.sessionId).toBe("nonce-1");
    expect(payload).not.toHaveProperty("windows");
  });

  test("ordinary failed tests are not retried as capacity incidents", async () => {
    expect(
      classifyAccountIncident({
        exitCode: 1,
        isError: true,
        failureReason: "pytest: assertion failed",
      }),
    ).toBeNull();
    expect(
      classifyAccountIncident({
        exitCode: 1,
        isError: true,
        failureReason: "[auth-error] refresh token revoked",
      })?.kind,
    ).toBe("auth");
    expect(
      classifyAccountIncident({ exitCode: 1, isError: true, failureReason: "service unavailable" })
        ?.kind,
    ).toBe("provider");
    const b = binding();
    let parked = false;
    const client = { binding: b, request: async () => admission(b, { state: "released" }) };
    expect(
      await completeManagedAccountSession(
        env(b),
        client,
        "nonce-1",
        { exitCode: 1, isError: true, failureReason: "pytest: assertion failed" },
        async () => {
          parked = true;
          return true;
        },
      ),
    ).toBe(false);
    expect(parked).toBe(false);
  });

  test("stopped account release retries an outage without replaying the task or incident", async () => {
    const b = binding();
    let releases = 0;
    let parks = 0;
    let incidents = 0;
    globalThis.fetch = (async () => {
      incidents++;
      return Response.json({ ok: true });
    }) as typeof fetch;
    const client = {
      binding: b,
      request: async () => {
        releases++;
        if (releases === 1) throw new AccountCapacityWaitError("temporary outage");
        return admission(b, { state: "released" });
      },
    };
    expect(
      await completeManagedAccountSession(
        env(b),
        client,
        "nonce-1",
        { exitCode: 1, isError: true, failureReason: "[auth-error] authentication failed" },
        async () => {
          parks++;
          return true;
        },
        false,
        1,
      ),
    ).toBe(true);
    expect(releases).toBe(2);
    expect(parks).toBe(1);
    expect(incidents).toBe(1);
  });

  test("activation carries launch nonce and requires matching active acknowledgement", async () => {
    const b = binding();
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        admission: admission(b, { state: "active", sessionId: "unique-session" }),
      });
    }) as typeof fetch;
    const client = accountAdmissionClient(env(b), b);
    const active = await client.request("activate", {
      taskId: "task-1",
      sessionId: "unique-session",
    });
    assertAdmissionMatches(b, active, "task-1", "active");
    expect(bodies).toEqual([
      { owner: b.owner, generation: 7, taskId: "task-1", sessionId: "unique-session" },
    ]);
    expect(active.sessionId).toBe("unique-session");
  });

  test("failed renewal stops an expired live process; stopping heartbeat prevents later calls", async () => {
    const b = binding();
    let aborted = 0;
    let calls = 0;
    const client = {
      binding: b,
      request: async () => {
        calls++;
        throw new AccountCapacityWaitError("lost");
      },
    };
    const heartbeat = maintainAccountAdmission(
      client,
      admission(b, { state: "active", expiresAt: new Date(0).toISOString() }),
      async () => {
        aborted++;
      },
      5,
    );
    await Bun.sleep(25);
    heartbeat.stop();
    const before = calls;
    await Bun.sleep(15);
    expect(aborted).toBeGreaterThan(0);
    expect(calls).toBe(before);
  });
});
