import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Regression test for the WORKER_BOOTSTRAP recreation block in
 * docker-entrypoint.sh (roadmap A0: the entire worker fleet crash-looped for
 * 4 days, 4-8 Sep 2026, because every restart after the first found the
 * bootstrap file already owned by `worker` from the prior boot, and the
 * kernel's protected_regular hardening blocks root from recreating a
 * non-root-owned regular file inside world-writable sticky /tmp -- even with
 * CAP_DAC_OVERRIDE present. `set -e` at the top of the real script then
 * aborts the whole container on that single failed redirect).
 *
 * The block is extracted verbatim between its `# BEGIN worker_bootstrap_write`
 * / `# END worker_bootstrap_write` markers and run in a real bash subprocess
 * against a throwaway WORKER_BOOTSTRAP path, so this test tracks the actual
 * deployed behavior instead of a hand-written mirror that could drift.
 *
 * This test cannot reproduce protected_regular directly (it needs real root
 * plus a second non-root UID inside a world-writable sticky directory, which
 * this sandbox does not have). It approximates the same class of failure --
 * "the existing bootstrap file cannot be overwritten in place" -- with a
 * mode-000 pre-existing file, which the current unprivileged test process is
 * equally blocked from truncating. Mutation-checked: this test goes red
 * against the pre-fix script (see roadmap A0) and green once the `rm -f`
 * guard is present.
 */

const entrypointPath = `${import.meta.dir}/../../docker-entrypoint.sh`;

function extractWorkerBootstrapWrite(): string {
  const script = readFileSync(entrypointPath, "utf8");
  const beginMarker = "# BEGIN worker_bootstrap_write";
  const beginIndex = script.indexOf(beginMarker);
  if (beginIndex === -1) {
    throw new Error(
      "Could not locate `# BEGIN worker_bootstrap_write` marker in docker-entrypoint.sh -- did the bootstrap block move?",
    );
  }
  const endMarker = "# END worker_bootstrap_write";
  const endIndex = script.indexOf(endMarker, beginIndex);
  if (endIndex === -1) {
    throw new Error(
      "Could not locate `# END worker_bootstrap_write` marker in docker-entrypoint.sh.",
    );
  }
  return script.slice(beginIndex + beginMarker.length, endIndex);
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runWorkerBootstrapWrite(bootstrapPath: string): RunResult {
  const blockSrc = extractWorkerBootstrapWrite();
  const script = `set -eu\nWORKER_BOOTSTRAP="$1"\n${blockSrc}\n`;
  const proc = Bun.spawnSync(["bash", "-c", script, "bash", bootstrapPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("WORKER_BOOTSTRAP recreation: first boot", () => {
  test("creates an executable bootstrap script when none exists yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "entrypoint-bootstrap-"));
    const path = join(dir, "agent-swarm-worker-entrypoint.sh");
    try {
      const result = runWorkerBootstrapWrite(path);
      expect(result.exitCode).toBe(0);
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, "utf8");
      expect(content).toContain("#!/bin/bash");
      expect(content).toContain("run_startup_script");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("WORKER_BOOTSTRAP recreation: restart with a blocked pre-existing file", () => {
  test("recreates the file rather than failing when it cannot be overwritten in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "entrypoint-bootstrap-"));
    const path = join(dir, "agent-swarm-worker-entrypoint.sh");
    // Simulates the post-restart state: a bootstrap file already exists from
    // the previous boot and the current process cannot write it in place --
    // standing in for protected_regular's block on root recreating a
    // worker-owned file in sticky /tmp (see file header).
    writeFileSync(path, "stale content from a previous boot\n");
    chmodSync(path, 0o000);
    try {
      const result = runWorkerBootstrapWrite(path);
      expect(result.exitCode).toBe(0);
      const content = readFileSync(path, "utf8");
      expect(content).not.toContain("stale content from a previous boot");
      expect(content).toContain("run_startup_script");
    } finally {
      chmodSync(path, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
