/**
 * Regression tests for roadmap item A6's follow-up ("recover the original
 * agent's WIP on resume"). Two gaps were found by investigation, not
 * assumed:
 *
 * 1. A resumed task's uncommitted work survives as a `git stash` (the
 *    runner auto-stashes a dirty worktree before merging in the latest
 *    default branch — see `ensureRepoForTask`/`refreshExistingRepoForTask`).
 *    The MAIN crash-recovery dispatch path already tells the resumed agent
 *    about that stash via `src/prompts/base-prompt.ts`'s `repoContext`
 *    section. The PAUSED-task-resume-after-restart path (a separate,
 *    smaller code path taken when the runner process itself restarts mid
 *    task) does not -- it reads `repoContext.clonePath` and discards
 *    `repoContext.autoStashes` entirely, so that resumed agent never learns
 *    its predecessor's uncommitted work is hidden in a stash.
 *
 * 2. Even on the main path, a resumed agent is told THAT a stash exists but
 *    not what branch it's actually on -- a small, cheap addition (current
 *    branch name) makes the resume briefing meaningfully more useful with
 *    no new git call beyond what `ensureRepoForTask` already runs.
 *
 * These tests cover the two small, pure/real-git-backed building blocks
 * used to close both gaps: `formatAutoStashNotice` (pure string formatting,
 * reused at both call sites) and `getCurrentGitBranch` (a real git call
 * against a real temp repo, matching this project's existing testing
 * convention in `runner-repo-autostash.test.ts` of driving real git rather
 * than mocking it).
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { formatAutoStashNotice, getCurrentGitBranch } from "../commands/runner";

const execFileAsync = promisify(execFile);

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "GIT_CONFIG_NOSYSTEM" || key.startsWith("GIT_TRACE")) continue;
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { env: gitEnv() });
  return stdout.trim();
}

describe("formatAutoStashNotice", () => {
  test("returns an empty string when there are no stashes", () => {
    expect(formatAutoStashNotice(undefined)).toBe("");
    expect(formatAutoStashNotice([])).toBe("");
  });

  test("formats a single stash with restore instructions", () => {
    const notice = formatAutoStashNotice([
      { ref: "stash@{0}", message: "swarm-autostash main 2026-09-08T00:00:00.000Z" },
    ]);
    expect(notice).toContain("Pending auto-stashed work exists in this repo:");
    expect(notice).toContain("- stash@{0}: swarm-autostash main 2026-09-08T00:00:00.000Z");
    expect(notice).toContain("git stash apply <ref>");
  });

  test("lists every stash when there is more than one", () => {
    const notice = formatAutoStashNotice([
      { ref: "stash@{0}", message: "swarm-autostash main first" },
      { ref: "stash@{1}", message: "swarm-autostash main second" },
    ]);
    expect(notice).toContain("- stash@{0}: swarm-autostash main first");
    expect(notice).toContain("- stash@{1}: swarm-autostash main second");
  });
});

describe("getCurrentGitBranch", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "runner-branch-test-"));
    await execFileAsync("git", ["init", "-q", tempRoot], { env: gitEnv() });
    await git(tempRoot, ["config", "user.email", "test@example.com"]);
    await git(tempRoot, ["config", "user.name", "Test"]);
    await execFileAsync("git", ["-C", tempRoot, "commit", "--allow-empty", "-q", "-m", "init"], {
      env: gitEnv(),
    });
  });

  afterEach(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  test("returns the current branch name for a real repo", async () => {
    await execFileAsync("git", ["-C", tempRoot, "branch", "-m", "main"], { env: gitEnv() });
    const branch = await getCurrentGitBranch(tempRoot);
    expect(branch).toBe("main");
  });

  test("reflects a checked-out feature branch, not the default", async () => {
    await execFileAsync("git", ["-C", tempRoot, "checkout", "-q", "-b", "feature/resume-wip"], {
      env: gitEnv(),
    });
    const branch = await getCurrentGitBranch(tempRoot);
    expect(branch).toBe("feature/resume-wip");
  });

  test("returns null for a non-git directory instead of throwing", async () => {
    const notARepo = await mkdtemp(join(tmpdir(), "runner-branch-not-a-repo-"));
    try {
      const branch = await getCurrentGitBranch(notARepo);
      expect(branch).toBeNull();
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
  });
});
