import { describe, expect, test } from "bun:test";
import { claudeAccountIdentity, codexAccountIdentity } from "../src/utils/account-identity.ts";
import {
  claudeWindows,
  codexWindows,
  collectAccounts,
  probeAccount,
} from "./account-capacity-probe.ts";
import {
  ClaudeAccountAuthError,
  ClaudeReauthenticationRequiredError,
} from "./claude-account-credentials.ts";

const now = Date.parse("2026-10-30T03:00:00Z");
const access = `fake.${Buffer.from(JSON.stringify({ sub: "user-b" })).toString("base64url")}.fake`;
const identity = codexAccountIdentity(access, "test-workspace");
const account = {
  id: "codex-b",
  provider: "codex" as const,
  enabled: true,
  credentialGeneration: 2,
  identityKey: identity,
  allowedModels: ["test-model"],
  credentialRef: { keyType: "codex_oauth", index: 4, scope: "global", scopeId: null },
};
const window = (duration: number, used: unknown = 20) => ({
  limit_window_seconds: duration,
  used_percent: used,
  reset_at: now / 1000 + 1800,
});
const deps = (fetchImpl: typeof fetch) => ({
  fetch: fetchImpl,
  now: () => now,
  codexCredential: async (slot: number) =>
    slot === 4 ? { access, accountId: "test-workspace" } : null,
  claudeCredential: async () => "fake-claude",
  codexUrl: "https://codex.invalid/usage",
  claudeUrl: "https://claude.invalid/usage",
});

describe("account-scoped quota collector", () => {
  test("only durable unconfirmed renewal asks for owner action while unknown stays unknown", async () => {
    for (const error of [
      new ClaudeReauthenticationRequiredError("fixture"),
      new Error("fixture outage"),
    ]) {
      const result = await probeAccount(
        {
          ...account,
          provider: "claude",
          credentialRef: { ...account.credentialRef, keyType: "claude_oauth" },
        },
        {
          ...deps((async () => {
            throw new Error("No provider request expected");
          }) as typeof fetch),
          claudeCredential: async () => {
            throw error;
          },
        },
      );
      expect(result.authState).toBe("unknown");
      expect(result.authAction).toBe(
        error instanceof ClaudeReauthenticationRequiredError ? "reauthenticate" : null,
      );
    }
  });
  test("known Claude refresh rejection remains invalid for renewal notices", async () => {
    const result = await probeAccount(
      {
        ...account,
        provider: "claude",
        credentialRef: { ...account.credentialRef, keyType: "claude_oauth" },
      },
      {
        ...deps((async () => {
          throw new Error("No provider request expected");
        }) as typeof fetch),
        claudeCredential: async () => {
          throw new ClaudeAccountAuthError("fixture-invalid");
        },
      },
    );
    expect(result).toMatchObject({ authState: "invalid", state: "unavailable", windows: [] });
  });
  test("overwritten credential identity cannot borrow another account's reserves", async () => {
    let requests = 0;
    const result = await probeAccount(
      { ...account, identityKey: "different-account" },
      deps((async () => {
        requests++;
        return Response.json({ rate_limit: { allowed: true, primary_window: window(18000) } });
      }) as typeof fetch),
    );
    expect(result.authState).toBe("invalid");
    expect(requests).toBe(0);
  });
  test("Sonnet exhaustion does not make a healthy Haiku account globally exhausted", async () => {
    const profile = { account: { uuid: "claude-account-b" } };
    const result = await probeAccount(
      {
        ...account,
        provider: "claude",
        identityKey: claudeAccountIdentity(profile),
        allowedModels: ["claude-haiku-test", "claude-sonnet-test"],
        credentialRef: { ...account.credentialRef, keyType: "claude_oauth" },
      },
      deps((async (url, init) =>
        String(url).endsWith("/profile")
          ? Response.json(profile)
          : (() => {
              expect(init?.method).toBe("GET");
              expect(init?.body).toBeUndefined();
              const resets_at = new Date(now + 1000_000).toISOString();
              return Response.json({
                five_hour: { utilization: 10, resets_at },
                seven_day: { utilization: 20, resets_at },
                seven_day_sonnet: { utilization: 100, resets_at },
              });
            })()) as typeof fetch),
    );
    expect(result).toMatchObject({ authState: "healthy", state: "healthy" });
    expect(result.windows.find((w) => w.id === "seven_day_sonnet")).toMatchObject({
      blocked: true,
      models: ["claude-sonnet-test"],
    });
  });
  test("collects all shared blocking windows instead of just weekly", () => {
    expect(
      codexWindows({
        rate_limit: { primary_window: window(18000, 100), secondary_window: window(604800) },
      }),
    ).toHaveLength(2);
    expect(
      codexWindows({ rate_limit: { primary_window: window(18000, "20") } })[0]?.usedPercent,
    ).toBeNull();
    expect(
      codexWindows({ rate_limit: { primary_window: window(18000, 101) } })[0]?.usedPercent,
    ).toBeNull();
  });
  test("missing or malformed windows stay unknown", async () => {
    const result = await probeAccount(
      account,
      deps((async () => Response.json({ rate_limit: { allowed: true } })) as typeof fetch),
    );
    expect(result.state).toBe("unknown");
    expect(result.windows).toEqual([]);
  });
  test("actually probes the original sparse slot and correct workspace", async () => {
    let headers: Headers | undefined;
    const result = await probeAccount(
      account,
      deps((async (_url, init) => {
        headers = new Headers(init?.headers);
        return Response.json({ rate_limit: { allowed: true, primary_window: window(18000) } });
      }) as typeof fetch),
    );
    expect(headers?.get("Authorization")).toBe(`Bearer ${access}`);
    expect(headers?.get("ChatGPT-Account-Id")).toBe("test-workspace");
    expect(result).toMatchObject({
      credentialGeneration: 2,
      authState: "healthy",
      state: "healthy",
    });
    expect(JSON.stringify(result)).not.toContain("fake-secret");
  });
  test("shared short exhaustion wins over healthy weekly capacity", async () => {
    const result = await probeAccount(
      account,
      deps((async () =>
        Response.json({
          rate_limit: {
            allowed: true,
            primary_window: window(18000, 100),
            secondary_window: window(604800, 10),
          },
        })) as typeof fetch),
    );
    expect(result.state).toBe("exhausted");
  });
  test("invalid auth is distinct from outage and errors never leak", async () => {
    const invalid = await probeAccount(
      account,
      deps((async () => new Response("fake-secret", { status: 401 })) as typeof fetch),
    );
    expect(invalid.authState).toBe("invalid");
    const outage = await probeAccount(
      account,
      deps((async () => {
        throw new Error("Bearer secret");
      }) as typeof fetch),
    );
    expect(outage.authState).toBe("unknown");
    expect(outage.state).toBe("unavailable");
    expect(JSON.stringify(outage)).not.toContain("secret");
  });
  test("retry-after creates a bounded cooldown without inventing usage", async () => {
    const result = await probeAccount(
      account,
      deps(
        (async () =>
          new Response("", { status: 429, headers: { "retry-after": "60" } })) as typeof fetch,
      ),
    );
    expect(result).toMatchObject({
      state: "throttled",
      authState: "unknown",
      windows: [],
      cooldownUntil: new Date(now + 60000).toISOString(),
    });
  });
  test("legacy Claude percentages are already percent and retain known family applicability", () => {
    const resets_at = new Date(now + 1000_000).toISOString();
    const result = claudeWindows(
      {
        five_hour: { utilization: 40, resets_at },
        seven_day: { utilization: 20, resets_at },
        seven_day_opus: { utilization: 90, resets_at },
        seven_day_sonnet: { utilization: 20, resets_at },
        seven_day_cowork: null,
      },
      ["claude-opus-test"],
    );
    expect(result.complete).toBe(true);
    expect(result.windows).toHaveLength(3);
    expect(result.windows[0]).toMatchObject({
      usedPercent: 40,
      durationSeconds: 18000,
      models: null,
    });
    expect(result.windows[2]).toMatchObject({ usedPercent: 90, models: ["claude-opus-test"] });
  });
  test("verified canonical limits take precedence over opaque legacy/marketing fields, preserving inactive zero/null reset", () => {
    const resets_at = "2026-10-30T14:00:00.390747+00:00";
    const result = claudeWindows(
      {
        five_hour: { utilization: 0, resets_at: null },
        seven_day: { utilization: 100, resets_at },
        seven_day_omelette: { opaque: true },
        marketing: { utilization: 999 },
        limits: [
          {
            kind: "session",
            group: "session",
            percent: 0,
            resets_at: null,
            scope: null,
            is_active: false,
          },
          {
            kind: "weekly_all",
            group: "weekly",
            percent: 100,
            resets_at,
            scope: null,
            is_active: true,
          },
          {
            kind: "weekly_scoped",
            group: "weekly",
            percent: 0,
            resets_at,
            scope: { model: { id: null, display_name: "Fable" }, surface: null },
            is_active: false,
          },
        ],
      },
      ["haiku", "sonnet", "opus", "fable"],
    );
    expect(result.complete).toBe(true);
    expect(result.windows[0]).toMatchObject({ usedPercent: 0, resetsAt: null, active: false });
    expect(result.windows[1]).toMatchObject({
      usedPercent: 100,
      active: true,
      blocked: true,
      models: null,
    });
    expect(result.windows[2]).toMatchObject({ models: ["fable"], usedPercent: 0, active: false });
  });
  test("unknown active kind, surface, model mapping and contradictory inactivity fail closed", () => {
    const resets_at = new Date(now + 1000_000).toISOString();
    const primary = [
      {
        kind: "session",
        group: "session",
        percent: 0,
        resets_at: null,
        scope: null,
        is_active: false,
      },
      { kind: "weekly_all", group: "weekly", percent: 20, resets_at, scope: null, is_active: true },
    ];
    for (const extra of [
      { kind: "future_kind", group: "weekly", percent: 0, resets_at, scope: null, is_active: true },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 20,
        resets_at,
        scope: { model: { display_name: "Unknown model" }, surface: null },
        is_active: true,
      },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 20,
        resets_at,
        scope: { model: { display_name: "Sonnet" }, surface: "unknown-surface" },
        is_active: true,
      },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 5,
        resets_at: null,
        scope: { model: { display_name: "Sonnet" }, surface: null },
        is_active: false,
      },
    ])
      expect(claudeWindows({ limits: [...primary, extra] }, ["sonnet"]).complete).toBe(false);
    expect(claudeWindows({ limits: primary }, ["unknown-configured-model"]).complete).toBe(true);
    expect(
      claudeWindows(
        {
          limits: [
            ...primary,
            {
              kind: "weekly_scoped",
              group: "weekly",
              percent: 10,
              resets_at,
              scope: { model: { display_name: "Sonnet" }, surface: null },
              is_active: true,
            },
          ],
        },
        ["unknown-configured-model"],
      ).complete,
    ).toBe(false);
    expect(
      claudeWindows(
        {
          five_hour: { utilization: 0, resets_at: null },
          seven_day: { utilization: 20, resets_at },
        },
        ["sonnet"],
      ).complete,
    ).toBe(false);
    expect(
      claudeWindows(
        {
          five_hour: { utilization: 20, resets_at },
          seven_day: { utilization: 20, resets_at },
          seven_day_omelette: { utilization: 0, resets_at },
        },
        ["sonnet"],
      ).complete,
    ).toBe(false);
  });
  test("Claude usage429 never becomes invalid authentication or a model request", async () => {
    const profile = { account: { uuid: "claude-fixture" } };
    const result = await probeAccount(
      {
        ...account,
        provider: "claude",
        identityKey: claudeAccountIdentity(profile),
        credentialRef: { ...account.credentialRef, keyType: "claude_oauth" },
      },
      deps((async (url, init) => {
        if (String(url).endsWith("/profile")) return Response.json(profile);
        expect(init?.method).toBe("GET");
        expect(init?.body).toBeUndefined();
        return new Response(null, { status: 429, headers: { "retry-after": "60" } });
      }) as typeof fetch),
    );
    expect(result).toMatchObject({
      authState: "healthy",
      state: "throttled",
      authAction: null,
      windows: [],
    });
  });
  test("Claude successful gateway/error body is not healthy", async () => {
    const result = await probeAccount(
      {
        ...account,
        provider: "claude",
        credentialRef: { ...account.credentialRef, keyType: "claude_oauth" },
      },
      deps((async () =>
        Response.json(
          { error: "invalid" },
          { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.1" } },
        )) as typeof fetch),
    );
    expect(result).toMatchObject({ authState: "unknown", windows: [] });
  });
  test("collector publishes every account independently and skips disabled", async () => {
    const publications: unknown[] = [];
    const results = await collectAccounts({
      apiUrl: "http://swarm.invalid",
      apiKey: "fake-api",
      sidecarUrl: "http://sidecar.invalid",
      sidecarToken: "fake-sidecar",
      now: () => now,
      codexCredential: async () => ({ access, accountId: "test-workspace" }),
      fetchImpl: (async (url, init) => {
        if (String(url).endsWith("/accounts"))
          return Response.json({
            accounts: [account, { ...account, id: "disabled", enabled: false }],
          });
        if (String(url).includes("/observation")) {
          publications.push(JSON.parse(String(init?.body)));
          return Response.json({ ok: true });
        }
        return Response.json({ rate_limit: { allowed: true, primary_window: window(18000) } });
      }) as typeof fetch,
    });
    expect(results).toEqual([{ accountId: "codex-b", state: "healthy", published: true }]);
    expect(publications).toHaveLength(1);
    expect(JSON.stringify(publications)).not.toContain("secret");
  });
  test("dry-run publishes nothing", async () => {
    const methods: string[] = [];
    await collectAccounts({
      apiUrl: "http://swarm.invalid",
      apiKey: "a",
      sidecarUrl: "http://sidecar.invalid",
      sidecarToken: "b",
      dryRun: true,
      codexCredential: async () => ({ access, accountId: "test-workspace" }),
      fetchImpl: (async (url, init) => {
        methods.push(init?.method ?? "GET");
        return Response.json(
          String(url).endsWith("/accounts")
            ? { accounts: [account] }
            : { rate_limit: { allowed: true, primary_window: window(18000) } },
        );
      }) as typeof fetch,
    });
    expect(methods).toEqual(["GET", "GET"]);
  });
  test("notice reconciliation follows real observations and its failure cannot undo healthy capacity", async () => {
    const order: string[] = [],
      errors: unknown[][] = [];
    const saved = console.error;
    console.error = (...args) => {
      errors.push(args);
    };
    try {
      const result = await collectAccounts({
        apiUrl: "http://swarm.invalid",
        apiKey: "fixture",
        sidecarUrl: "http://sidecar.invalid",
        sidecarToken: "fixture",
        now: () => now,
        codexCredential: async () => ({ access, accountId: "test-workspace" }),
        fetchImpl: (async (url, init) => {
          if (String(url).endsWith("/accounts")) return Response.json({ accounts: [account] });
          if (String(url).endsWith("/observation")) {
            order.push("observation");
            return Response.json({});
          }
          if (String(url).endsWith("/account-auth-notices/reconcile")) {
            expect(init?.body).toBeUndefined();
            order.push("notices");
            return new Response("sensitive upstream fixture", { status: 503 });
          }
          return Response.json({ rate_limit: { allowed: true, primary_window: window(18000) } });
        }) as typeof fetch,
      });
      expect(result).toEqual([{ accountId: account.id, state: "healthy", published: true }]);
      expect(order).toEqual(["observation", "notices"]);
      expect(errors).toEqual([["Account renewal notice reconciliation unavailable"]]);
    } finally {
      console.error = saved;
    }
  });
});
