/**
 * Codex worker sessions must run with `features.multi_agent = false`.
 *
 * Why: on codex-cli 0.148.0 `multi_agent` is a stable, default-on feature. A
 * Codex sub-agent spawned via the built-in `spawn_agent` tool (with
 * `fork_turns: "all"`) inherits the parent session's MCP identity — the
 * `agent-swarm` MCP server entry carries the parent's `X-Agent-ID` /
 * `X-Source-Task-Id` headers — and on the live swarm such sub-agents called
 * `store_progress(status: "completed")` on the PARENT task, completing it
 * early (task 2551bf57 on 15 Sep 2026, 9e8b616f on 1 Sep 2026). The chosen
 * fix is to disable the feature for every swarm-spawned Codex session.
 *
 * Mechanism under test: `createInProcessCodexSession` builds a config object
 * with `buildCodexConfig` (src/providers/codex-adapter.ts) and hands it to
 * `new Codex({ config })`. The `@openai/codex-sdk` flattens that object into
 * repeated `--config <dotted.key>=<toml value>` arguments on the spawned
 * `codex exec --experimental-json ...` command line. These tests point the
 * SDK at a FAKE `codex` binary (via `CODEX_PATH_OVERRIDE`, the same hook the
 * Docker worker image uses) which records the exact argv it was spawned with,
 * then assert on that argv. Nothing here inspects source text.
 *
 * Override precedence (T2): Codex resolves config as CLI `--config` overrides
 * > profile > `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) >
 * built-in defaults. Because the adapter's value travels as a `--config`
 * override, a user/baseline `config.toml` that sets `multi_agent = true`
 * cannot win. What the adapter itself controls — and what T2 pins — is that
 * the override is ALWAYS emitted, exactly once, as `false`, and that no
 * per-agent input (`additionalArgs`, `env`, `reasoningEffort`) can put a
 * competing `multi_agent` value or `--enable multi_agent` on the command line.
 *
 * Runs on POSIX only: the fake binary is a `#!/bin/sh` wrapper, which Node's
 * `child_process.spawn` cannot execute on Windows without a shell. CI and the
 * Docker workers are Linux; on a Windows dev box run it in
 * `oven/bun:1.3.11`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { createInProcessCodexSession } from "../providers/codex-adapter";
import { resolveCodexModel } from "../providers/codex-models";
import type { ProviderSessionConfig } from "../providers/types";

const isWindows = process.platform === "win32";

/** Parsed `--config` / `-c` overrides from a codex argv: key -> every value seen, in order. */
function configOverrides(argv: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if ((flag === "--config" || flag === "-c") && i + 1 < argv.length) {
      const raw = argv[i + 1] as string;
      const eq = raw.indexOf("=");
      const key = eq === -1 ? raw : raw.slice(0, eq);
      const value = eq === -1 ? "" : raw.slice(eq + 1);
      out.set(key, [...(out.get(key) ?? []), value]);
      i++;
    }
  }
  return out;
}

describe.skipIf(isWindows)("codex worker session — features.multi_agent disabled", () => {
  let root: string;
  let fakeCodexPath: string;
  let homeDir: string;

  const originalFetch = globalThis.fetch;
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "CODEX_PATH_OVERRIDE",
    "HOME",
    "CONTEXT_MODE_DISABLED",
    "SKIP_SESSION_SUMMARY",
    "OPENAI_API_KEY",
    "CODEX_SKILLS_DIR",
  ];

  beforeAll(() => {
    root = mkdtempSync(join(os.tmpdir(), "codex-multi-agent-"));

    // Fake `codex`: records argv to $FAKE_CODEX_ARGV_OUT, drains the prompt
    // from stdin (the SDK writes it then closes stdin), and emits the minimal
    // JSONL a successful one-turn `codex exec --experimental-json` produces.
    const fakeJs = join(root, "fake-codex.js");
    writeFileSync(
      fakeJs,
      [
        'const fs = require("node:fs");',
        "fs.writeFileSync(process.env.FAKE_CODEX_ARGV_OUT, JSON.stringify(process.argv.slice(2)));",
        "(async () => {",
        "  for await (const _chunk of process.stdin) { /* drain */ }",
        "  const lines = [",
        '    { type: "thread.started", thread_id: "fake-thread-multi-agent" },',
        '    { type: "turn.started" },',
        '    { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },',
        "  ];",
        '  process.stdout.write(lines.map((l) => JSON.stringify(l)).join("\\n") + "\\n");',
        "  process.exit(0);",
        "})();",
        "",
      ].join("\n"),
    );
    fakeCodexPath = join(root, "codex");
    writeFileSync(fakeCodexPath, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`);
    chmodSync(fakeCodexPath, 0o755);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    homeDir = mkdtempSync(join(root, "home-"));
    process.env.CODEX_PATH_OVERRIDE = fakeCodexPath;
    process.env.HOME = homeDir;
    process.env.CONTEXT_MODE_DISABLED = "true";
    process.env.SKIP_SESSION_SUMMARY = "1";
    process.env.CODEX_SKILLS_DIR = join(homeDir, "skills");
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
      // cancel poll) out of the picture; it has no bearing on the codex argv.
      taskId: "",
      apiUrl: "http://test.invalid",
      apiKey: "test-key",
      cwd,
      logFile: join(cwd, "session.log"),
      ...overrides,
    };
  }

  /** Run one real in-process session against the fake binary; return the argv codex was spawned with. */
  async function spawnedCodexArgv(
    overrides: Partial<ProviderSessionConfig> = {},
  ): Promise<string[]> {
    const argvOut = join(root, `argv-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const cfg = sessionConfig(overrides);
    cfg.env = { ...(cfg.env ?? {}), FAKE_CODEX_ARGV_OUT: argvOut };
    const session = await createInProcessCodexSession(cfg);
    const result = await session.waitForCompletion();
    // Guard: if this fails the harness is broken, not the feature under test.
    expect(result.isError).toBe(false);
    const argv = JSON.parse(readFileSync(argvOut, "utf-8")) as string[];
    expect(argv.slice(0, 2)).toEqual(["exec", "--experimental-json"]);
    return argv;
  }

  // ── T1 ────────────────────────────────────────────────────────────────────
  test("T1: codex exec is spawned with --config features.multi_agent=false", async () => {
    const argv = await spawnedCodexArgv();
    const overrides = configOverrides(argv);

    expect(overrides.get("features.multi_agent")).toEqual(["false"]);
    // Adjacent pair, exactly as codex receives it.
    const idx = argv.indexOf("features.multi_agent=false");
    expect(idx).toBeGreaterThan(0);
    expect(argv[idx - 1]).toBe("--config");
  }, 30_000);

  // ── T2 ────────────────────────────────────────────────────────────────────
  test("T2a: per-agent/user inputs that would re-enable multi_agent cannot reach the codex command line", async () => {
    // A user-level config.toml (HOME/.codex) and a CODEX_HOME passed through
    // the per-agent env both try to turn the feature ON. Codex ranks CLI
    // `--config` above either file, so the adapter's override must be present.
    const userToml = "[features]\nmulti_agent = true\n";
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    writeFileSync(join(homeDir, ".codex", "config.toml"), userToml);
    const agentCodexHome = mkdtempSync(join(root, "agent-codex-home-"));
    writeFileSync(join(agentCodexHome, "config.toml"), userToml);

    const argv = await spawnedCodexArgv({
      env: { CODEX_HOME: agentCodexHome },
      // `additionalArgs` is documented as Claude-only; it must stay ignored by
      // the codex adapter so it can never smuggle a competing flag in.
      additionalArgs: ["--enable", "multi_agent", "-c", "features.multi_agent=true"],
    });
    const overrides = configOverrides(argv);

    // Exactly one multi_agent override, and it is false.
    expect(overrides.get("features.multi_agent")).toEqual(["false"]);
    // No other spelling of the key and no feature-toggle flag anywhere.
    const mentions = argv.filter((a) => a.includes("multi_agent"));
    expect(mentions).toEqual(["features.multi_agent=false"]);
    expect(argv).not.toContain("--enable");
  }, 30_000);

  test("T2b: the reasoning-effort fragment (spread last into the config) never clobbers features.multi_agent", async () => {
    for (const reasoningEffort of [undefined, "low", "high"] as const) {
      const argv = await spawnedCodexArgv(reasoningEffort ? { reasoningEffort } : {});
      const overrides = configOverrides(argv);
      expect({ reasoningEffort, multiAgent: overrides.get("features.multi_agent") }).toEqual({
        reasoningEffort,
        multiAgent: ["false"],
      });
      // Disabling multi_agent must not drop the sibling feature flags.
      expect(overrides.get("features.hooks")).toEqual(["true"]);
      expect(overrides.get("features.plugin_hooks")).toEqual(["true"]);
    }
  }, 60_000);

  // ── T3 ────────────────────────────────────────────────────────────────────
  test("T3: existing baseline config values reach codex unchanged", async () => {
    const argv = await spawnedCodexArgv({ model: "gpt-5.4" });
    const overrides = configOverrides(argv);
    const expectedModel = resolveCodexModel("gpt-5.4");

    expect(overrides.get("model")).toEqual([JSON.stringify(expectedModel)]);
    // approval_policy arrives twice: once from the adapter's config object and
    // once from the SDK's ThreadOptions.approvalPolicy. Both must be "never".
    const approval = overrides.get("approval_policy") ?? [];
    expect(approval.length).toBeGreaterThan(0);
    for (const v of approval) expect(v).toBe('"never"');
    expect(overrides.get("sandbox_mode")).toEqual(['"danger-full-access"']);
    expect(overrides.get("skip_git_repo_check")).toEqual(["true"]);
    expect(overrides.get("show_raw_agent_reasoning")).toEqual(["false"]);
    expect(overrides.get("features.hooks")).toEqual(["true"]);
    expect(overrides.get("features.plugin_hooks")).toEqual(["true"]);
    expect(overrides.get("mcp_servers.agent-swarm.url")).toEqual([
      JSON.stringify("http://test.invalid/mcp"),
    ]);
    // ThreadOptions-derived flags are untouched too.
    expect(argv[argv.indexOf("--sandbox") + 1]).toBe("danger-full-access");
    expect(argv[argv.indexOf("--model") + 1]).toBe(expectedModel);
    expect(argv).toContain("--skip-git-repo-check");
  }, 30_000);
});
