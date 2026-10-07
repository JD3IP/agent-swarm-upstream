/**
 * Codex worker sessions must run with `features.multi_agent = false`.
 *
 * Why: codex-cli ships `multi_agent` stable and default-on. A Codex sub-agent
 * spawned via the built-in `spawn_agent` tool (with `fork_turns: "all"`)
 * inherits the parent session's MCP identity (the `agent-swarm` MCP server
 * entry carries the parent's `X-Agent-ID` / `X-Source-Task-Id` headers) and on
 * the live swarm such sub-agents called `store_progress(status: "completed")`
 * on the PARENT task, completing it early (tasks 2551bf57 on 15 Sep 2026 and
 * 9e8b616f on 1 Sep 2026). The fix disables the feature for every
 * swarm-spawned Codex session.
 *
 * Mechanism under test (v1.164): `createInProcessCodexSession` builds the
 * config object with `buildCodexConfig` and sends it as the `config` param of
 * the app-server `thread/start` request. These tests capture that request via
 * `appServerFactory`, so they run on every platform (no fake binary needed).
 * Nothing here inspects source text.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { buildCodexConfig, createInProcessCodexSession } from "../providers/codex-adapter";
import type { ProviderSessionConfig } from "../providers/types";

describe("codex worker session - features.multi_agent disabled", () => {
  let root: string;
  const originalFetch = globalThis.fetch;
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "HOME",
    "CONTEXT_MODE_DISABLED",
    "SKIP_SESSION_SUMMARY",
    "OPENAI_API_KEY",
    "CODEX_SKILLS_DIR",
  ];

  beforeEach(() => {
    root = mkdtempSync(join(os.tmpdir(), "codex-multi-agent-"));
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.HOME = root;
    process.env.CONTEXT_MODE_DISABLED = "true";
    process.env.SKIP_SESSION_SUMMARY = "1";
    process.env.CODEX_SKILLS_DIR = join(root, "skills");
    delete process.env.OPENAI_API_KEY;
    // Every API call the adapter makes (installed MCP servers, OAuth lookup)
    // gets an empty-but-valid answer; none of them may influence `features`.
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/mcp-servers")) {
        return new Response(JSON.stringify({ servers: [], total: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  });

  function sessionConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
    const cwd = mkdtempSync(join(root, "cwd-"));
    return {
      prompt: "hello",
      systemPrompt: "",
      model: "gpt-5.4",
      role: "worker",
      agentId: "agent-multi-agent-test",
      // Empty taskId keeps the adapter-side swarm event handler (heartbeat /
      // cancel poll) out of the picture; it has no bearing on thread/start.
      taskId: "",
      apiUrl: "http://test.invalid",
      apiKey: "test-key",
      cwd,
      logFile: join(cwd, "session.log"),
      ...overrides,
    };
  }

  /** Start one real in-process session against a fake app-server; return the `config` sent in `thread/start`. */
  async function threadStartConfig(
    overrides: Partial<ProviderSessionConfig> = {},
  ): Promise<Record<string, unknown>> {
    let startParams: { config?: Record<string, unknown> } | undefined;
    const client = {
      request: async (method: string, params?: unknown) => {
        if (method === "thread/start") {
          startParams = params as { config?: Record<string, unknown> };
          return { thread: { id: "fake-thread-multi-agent" } };
        }
        return {};
      },
      onNotification: () => () => {},
      onClose: () => () => {},
      async close() {},
    };
    const session = await createInProcessCodexSession(sessionConfig(overrides), {
      appServerFactory: () => client as never,
    });
    await session.abort("test-done").catch(() => {});
    expect(startParams?.config, "thread/start must carry the merged config").toBeDefined();
    return startParams?.config as Record<string, unknown>;
  }

  test("T1: thread/start carries features.multi_agent=false", async () => {
    const config = await threadStartConfig();
    const features = config.features as Record<string, unknown>;
    expect(features.multi_agent).toBe(false);
  }, 30_000);

  test("T2a: per-agent inputs that would re-enable multi_agent cannot change it", async () => {
    const config = await threadStartConfig({
      env: { CODEX_HOME: join(root, "agent-codex-home") },
      // `additionalArgs` is documented as Claude-only; it must stay ignored by
      // the codex adapter so it can never smuggle a competing flag in.
      additionalArgs: ["--enable", "multi_agent", "-c", "features.multi_agent=true"],
    });
    const features = config.features as Record<string, unknown>;
    expect(features.multi_agent).toBe(false);
    expect(JSON.stringify(config).match(/multi_agent/g)).toHaveLength(1);
  }, 30_000);

  test("T2b: the reasoning-effort fragment (spread last into the config) never clobbers features.multi_agent", async () => {
    for (const reasoningEffort of [undefined, "low", "high"] as const) {
      const config = await buildCodexConfig(
        sessionConfig(reasoningEffort ? { reasoningEffort } : {}),
        "gpt-5.4",
        () => {},
      );
      const features = config.features as Record<string, unknown>;
      expect({ reasoningEffort, multiAgent: features.multi_agent }).toEqual({
        reasoningEffort,
        multiAgent: false,
      });
      // Disabling multi_agent must not drop the sibling feature flags.
      expect(features.hooks).toBe(true);
      expect(features.plugin_hooks).toBe(true);
      expect(features.apps).toBe(false);
    }
  }, 60_000);
});
