/**
 * Regression test for roadmap item A6 ("crash recovery is unreliable").
 *
 * Root cause (measured against live task history, not assumed): the /tmp
 * task file used for active-session heartbeats and per-session cancellation
 * checks was keyed ONLY on the runner's process PID
 * (`getTaskFilePath(pid)` -> `/tmp/agent-swarm-task-${pid}.json`). On a
 * worker running more than one concurrent Claude session (one runner
 * process, several spawned CLI sessions), every session shares the same
 * runner PID, so the second session's `writeTaskFile` silently overwrote
 * the first session's file, and `cleanupTaskFile` for one session deleted
 * the file for ALL of them. The heartbeat hook (`src/hooks/hook.ts`) reads
 * its own `TASK_FILE` env var, which is fine per-process, but the path each
 * session's process actually receives all pointed at the same file --
 * so every task but the most-recently-started one stopped heartbeating and
 * was later declared "likely crashed" by the heartbeat sweep, even though
 * the worker was still actively running it. See the roadmap for the full
 * mechanism (false-positive supersede -> unclaimable resume pin -> reaped
 * on a 10-minute wall clock).
 *
 * Fix: the task file path is now qualified by taskId as well as pid, so
 * concurrent sessions on one runner get distinct files and a cleanup only
 * ever removes its own session's file.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  cleanupTaskFile,
  getTaskFilePath,
  writeTaskFile,
} from "../providers/claude-adapter";

const SAME_PID = 999999; // fixed fake pid: this is exactly the shared-runner scenario

describe("task file: two concurrent sessions on the same runner PID", () => {
  test("get distinct file paths, keyed by taskId as well as pid", () => {
    const pathA = getTaskFilePath(SAME_PID, "task-aaaaaaaa-0000-0000-0000-000000000001");
    const pathB = getTaskFilePath(SAME_PID, "task-bbbbbbbb-0000-0000-0000-000000000002");
    expect(pathA).not.toBe(pathB);
  });

  test("writing the second session's file does not overwrite the first's content", async () => {
    const taskIdA = "task-cccccccc-0000-0000-0000-000000000003";
    const taskIdB = "task-dddddddd-0000-0000-0000-000000000004";
    const pathA = await writeTaskFile(SAME_PID, taskIdA, {
      taskId: taskIdA,
      agentId: "agent-a",
      startedAt: new Date().toISOString(),
    });
    const pathB = await writeTaskFile(SAME_PID, taskIdB, {
      taskId: taskIdB,
      agentId: "agent-b",
      startedAt: new Date().toISOString(),
    });

    try {
      const contentA = JSON.parse(await readFile(pathA, "utf8"));
      const contentB = JSON.parse(await readFile(pathB, "utf8"));
      expect(contentA.taskId).toBe(taskIdA);
      expect(contentB.taskId).toBe(taskIdB);
    } finally {
      await cleanupTaskFile(SAME_PID, taskIdA);
      await cleanupTaskFile(SAME_PID, taskIdB);
    }
  });

  test("cleaning up one session's task file leaves the other session's file intact", async () => {
    const taskIdA = "task-eeeeeeee-0000-0000-0000-000000000005";
    const taskIdB = "task-ffffffff-0000-0000-0000-000000000006";
    const pathA = await writeTaskFile(SAME_PID, taskIdA, {
      taskId: taskIdA,
      agentId: "agent-a",
      startedAt: new Date().toISOString(),
    });
    const pathB = await writeTaskFile(SAME_PID, taskIdB, {
      taskId: taskIdB,
      agentId: "agent-b",
      startedAt: new Date().toISOString(),
    });

    try {
      // This is the exact failure this test exists to catch: session A
      // ending (the normal end-of-task cleanup) must not delete session
      // B's still-live task file, or B's heartbeat/cancellation reads go
      // dark while B is still running -- the mechanism behind A6.
      await cleanupTaskFile(SAME_PID, taskIdA);

      const remaining = JSON.parse(await readFile(pathB, "utf8"));
      expect(remaining.taskId).toBe(taskIdB);
    } finally {
      await cleanupTaskFile(SAME_PID, taskIdA);
      await cleanupTaskFile(SAME_PID, taskIdB);
    }
  });
});
