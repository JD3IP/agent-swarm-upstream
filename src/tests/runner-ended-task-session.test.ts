/**
 * A provider session must not outlive its task.
 *
 * Live incident, 15 Sep 2026 (task 2551bf57, Codex worker): a Codex sub-agent
 * spawned inside the session called `store-progress status=completed` on the
 * parent's task at 09:08:59Z. The API marked the task completed, but the
 * runner only ever aborted sessions for *cancelled* tasks, so the codex
 * process tree kept running — building images and starting containers — for
 * another 11.5 minutes until 09:20:40Z.
 *
 * These tests drive the runner's ended-task check against the real API task
 * handlers and a real SQLite DB, with the task ended exactly the way
 * `store-progress` ends it (`completeTask` / `failTask`), and a real OS
 * process standing in for the provider subprocess.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  cancelTask,
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  failTask,
  initDb,
  startTask,
} from "../be/db";
import { abortSessionsForEndedTasks } from "../commands/runner";
import { handleCore } from "../http/core";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = `/tmp/agent-swarm-runner-ended-task-${process.pid}.sqlite`;
const API_KEY = "ended-task-test-key";
let server: Server;
let baseUrl: string;
let agentId: string;

/** Grace before a still-running session of an ended task is aborted. */
const GRACE_MS = 120_000;

async function removeTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

/**
 * A live "provider session" backed by a real child process, mirroring
 * CodexSubprocessSession.abort() (SIGTERM to the subprocess).
 */
function liveSession() {
  const proc = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const aborts: Array<string | undefined> = [];
  return {
    proc,
    aborts,
    session: {
      abort: async (reason?: string) => {
        aborts.push(reason);
        proc.kill("SIGTERM");
      },
    },
  };
}

async function isRunning(proc: ReturnType<typeof Bun.spawn>): Promise<boolean> {
  const exited = await Promise.race([
    proc.exited.then(() => true),
    Bun.sleep(1500).then(() => false),
  ]);
  return !exited;
}

function inProgressTask(label: string): string {
  const task = createTaskExtended(`ended-task ${label}`, { agentId, source: "api" });
  expect(startTask(task.id)?.status).toBe("in_progress");
  return task.id;
}

beforeAll(async () => {
  await removeTestDb();
  initDb(TEST_DB_PATH);
  agentId = createAgent({
    name: "ended-task worker",
    isLead: false,
    status: "busy",
    maxTasks: 4,
  }).id;
  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const callerAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleCore(req, res, callerAgentId, API_KEY)) return;
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url ?? "");
    const query = parseQueryParams(req.url ?? "");
    if (await handleTasks(req, res, pathSegments, query, callerAgentId)) return;
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not listen");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeTestDb();
});

describe("runner ended-task session termination", () => {
  test("test_session_keeps_running_after_its_task_is_completed", async () => {
    const taskId = inProgressTask("completed-mid-session");
    const live = liveSession();
    const activeTasks = new Map([[taskId, { session: live.session }]]);
    const signaled = new Set<string>();
    const config = { apiUrl: baseUrl, apiKey: API_KEY, agentId };

    // What store-progress(status=completed) does — here, by a sub-agent,
    // while the session's main thread is still working.
    expect(completeTask(taskId, "sub-agent's partial verdict")?.status).toBe("completed");

    let clock = 1_000_000;
    const now = () => clock;
    await abortSessionsForEndedTasks(activeTasks, config, "worker", signaled, {
      now,
      graceMs: GRACE_MS,
    });
    clock += GRACE_MS + 1;
    await abortSessionsForEndedTasks(activeTasks, config, "worker", signaled, {
      now,
      graceMs: GRACE_MS,
    });

    const stillRunning = await isRunning(live.proc);
    if (stillRunning) live.proc.kill("SIGKILL");
    expect(live.aborts).toEqual(["task_completed"]);
    expect(stillRunning).toBe(false);
    expect(signaled.has(taskId)).toBe(true);
  });

  test("a normally finishing session gets the wind-down grace before any abort", async () => {
    // Live data (1–15 Sep, 680 completed tasks): session.end lands p99 22.5s,
    // max 58.4s after the agent's own store-progress(completed). That tail —
    // final message, session summary, memory indexing — must not be killed.
    const taskId = inProgressTask("normal-wind-down");
    const live = liveSession();
    const activeTasks = new Map([[taskId, { session: live.session }]]);
    const signaled = new Set<string>();
    const config = { apiUrl: baseUrl, apiKey: API_KEY, agentId };
    completeTask(taskId, "done");

    let clock = 5_000_000;
    const now = () => clock;
    await abortSessionsForEndedTasks(activeTasks, config, "worker", signaled, {
      now,
      graceMs: GRACE_MS,
    });
    clock += GRACE_MS - 1;
    await abortSessionsForEndedTasks(activeTasks, config, "worker", signaled, {
      now,
      graceMs: GRACE_MS,
    });

    try {
      expect(live.aborts).toEqual([]);
      expect(await isRunning(live.proc)).toBe(true);
    } finally {
      live.proc.kill("SIGKILL");
    }
  });

  test("a failed task's session is also terminated after the grace", async () => {
    const taskId = inProgressTask("failed-mid-session");
    const live = liveSession();
    const activeTasks = new Map([[taskId, { session: live.session }]]);
    const signaled = new Set<string>();
    const config = { apiUrl: baseUrl, apiKey: API_KEY, agentId };
    failTask(taskId, "gave up");

    let clock = 9_000_000;
    const now = () => clock;
    await abortSessionsForEndedTasks(activeTasks, config, "worker", signaled, {
      now,
      graceMs: GRACE_MS,
    });
    clock += GRACE_MS;
    await abortSessionsForEndedTasks(activeTasks, config, "worker", signaled, {
      now,
      graceMs: GRACE_MS,
    });

    const stillRunning = await isRunning(live.proc);
    if (stillRunning) live.proc.kill("SIGKILL");
    expect(live.aborts).toEqual(["task_failed"]);
    expect(stillRunning).toBe(false);
  });

  test("a cancelled task's session is still aborted immediately, once", async () => {
    const taskId = inProgressTask("cancelled");
    const live = liveSession();
    const activeTasks = new Map([[taskId, { session: live.session }]]);
    const signaled = new Set<string>();
    const config = { apiUrl: baseUrl, apiKey: API_KEY, agentId };
    cancelTask(taskId, "operator cancel");

    await abortSessionsForEndedTasks(activeTasks, config, "worker", signaled);
    await abortSessionsForEndedTasks(activeTasks, config, "worker", signaled);

    const stillRunning = await isRunning(live.proc);
    if (stillRunning) live.proc.kill("SIGKILL");
    expect(live.aborts).toEqual(["cancelled"]);
    expect(stillRunning).toBe(false);
  });

  test("an in-progress task's session is left alone", async () => {
    const taskId = inProgressTask("still-working");
    const live = liveSession();
    const activeTasks = new Map([[taskId, { session: live.session }]]);
    const signaled = new Set<string>();
    const config = { apiUrl: baseUrl, apiKey: API_KEY, agentId };

    let clock = 13_000_000;
    const now = () => clock;
    await abortSessionsForEndedTasks(activeTasks, config, "worker", signaled, {
      now,
      graceMs: GRACE_MS,
    });
    clock += GRACE_MS * 10;
    await abortSessionsForEndedTasks(activeTasks, config, "worker", signaled, {
      now,
      graceMs: GRACE_MS,
    });

    try {
      expect(live.aborts).toEqual([]);
      expect(await isRunning(live.proc)).toBe(true);
    } finally {
      live.proc.kill("SIGKILL");
    }
  });

  test("an unreachable API never aborts a session", async () => {
    const live = liveSession();
    const activeTasks = new Map([["task-x", { session: live.session }]]);
    const failingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    let clock = 17_000_000;
    const now = () => clock;
    const config = { apiUrl: baseUrl, apiKey: API_KEY, agentId };

    await abortSessionsForEndedTasks(activeTasks, config, "worker", new Set(), {
      fetchImpl: failingFetch,
      now,
      graceMs: GRACE_MS,
    });
    clock += GRACE_MS * 10;
    await abortSessionsForEndedTasks(activeTasks, config, "worker", new Set(), {
      fetchImpl: failingFetch,
      now,
      graceMs: GRACE_MS,
    });

    try {
      expect(live.aborts).toEqual([]);
    } finally {
      live.proc.kill("SIGKILL");
    }
  });
});
