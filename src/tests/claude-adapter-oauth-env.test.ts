/**
 * Regression test: the Claude OAuth token must not be mirrored into the
 * spawned Claude process env under `AGENT_SWARM_CLAUDE_OAUTH_TOKEN`.
 *
 * The Claude CLI deliberately strips `CLAUDE_CODE_OAUTH_TOKEN` from hook
 * subprocess env. A mirror under an unrecognised name bypasses that filter,
 * so any agent shell that prints its env leaks the token. Session summaries
 * now run in the adapter process (`AGENT_SWARM_ADAPTER_SESSION_SUMMARY=1`),
 * so the mirror is no longer needed.
 *
 * Exercised through the real spawn path: `ClaudeAdapter.createSession` →
 * `ClaudeSession` constructor → `Bun.spawn`. `Bun.spawn` is stubbed and the
 * `env` option it receives is captured — the env is built inline in the
 * constructor, so the spawn call is the smallest real seam.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ClaudeAdapter } from "../providers/claude-adapter";
import type { ProviderSessionConfig } from "../providers/types";

/** Fake Bun.Subprocess — exits cleanly with no output. */
function makeFakeProc(): ReturnType<typeof Bun.spawn> {
  return {
    stdout: null,
    stderr: null,
    stdin: null,
    exited: Promise.resolve(0),
    exitCode: 0,
    kill: () => {},
    pid: 0,
    killed: false,
    ref: () => {},
    unref: () => {},
  } as unknown as ReturnType<typeof Bun.spawn>;
}

/** Empty apiUrl/apiKey/agentId skips the MCP-server fetch. */
function makeConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  return {
    prompt: "Say hello",
    systemPrompt: "",
    model: "sonnet",
    role: "worker",
    agentId: "",
    taskId: "test-task-oauth-env",
    apiUrl: "",
    apiKey: "",
    cwd: "/tmp",
    logFile: "/tmp/test-claude-adapter-oauth-env.jsonl",
    ...overrides,
  };
}

describe("ClaudeSession spawn env — OAuth token is not mirrored", () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let spawnedEnvs: Array<Record<string, string> | undefined>;

  beforeEach(() => {
    spawnedEnvs = [];
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((
      _cmd: readonly string[],
      opts?: { env?: Record<string, string> },
    ) => {
      spawnedEnvs.push(opts?.env);
      return makeFakeProc();
    }) as typeof Bun.spawn);
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  test("CLAUDE_CODE_OAUTH_TOKEN reaches Claude; AGENT_SWARM_CLAUDE_OAUTH_TOKEN does not", async () => {
    const adapter = new ClaudeAdapter();
    await adapter.createSession(
      makeConfig({
        env: {
          CLAUDE_CODE_OAUTH_TOKEN: "tok-x",
          AGENT_SWARM_CLAUDE_OAUTH_TOKEN: "tok-x",
        },
      }),
    );

    expect(spawnedEnvs).toHaveLength(1);
    const env = spawnedEnvs[0] ?? {};

    // The CLI still authenticates with its own token.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-x");
    // The mirror must be absent — neither re-added nor passed through from the source env.
    expect(Object.keys(env)).not.toContain("AGENT_SWARM_CLAUDE_OAUTH_TOKEN");
    // Summaries are owned by the adapter process, which is why the mirror is obsolete.
    expect(env.AGENT_SWARM_ADAPTER_SESSION_SUMMARY).toBe("1");
  });
});
