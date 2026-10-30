import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  getDb,
  getTaskById,
  initDb,
  startTask,
  supersedeTask,
} from "../be/db";
import { handlePoll } from "../http/poll";
import { handleTasks } from "../http/tasks";
import { createResumeFollowUp } from "../tasks/worker-follow-up";

const dbPath = `./test-account-poll-${process.pid}.sqlite`;
let taskServer: Server;
let taskOrigin: string;
beforeAll(async () => {
  initDb(dbPath);
  taskServer = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://local");
    void handleTasks(
      req,
      res,
      url.pathname.split("/").filter(Boolean),
      url.searchParams,
      req.headers["x-agent-id"] as string | undefined,
    );
  });
  await new Promise<void>((resolve) => taskServer.listen(0, "127.0.0.1", resolve));
  const address = taskServer.address();
  taskOrigin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => taskServer.close(() => resolve()));
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(dbPath + suffix).catch(() => {});
  }
});
beforeEach(() => {
  getDb().exec("DELETE FROM agent_tasks; DELETE FROM agents;");
});

async function poll(agentId: string, taskId?: string) {
  let status = 200;
  let body = "";
  const query = new URLSearchParams(taskId ? { taskId } : {});
  const req = {
    method: "GET",
    url: `/api/poll?${query}`,
    headers: { "x-agent-id": agentId },
  } as Parameters<typeof handlePoll>[0];
  const res = {
    setHeader() {},
    writeHead(code: number) {
      status = code;
    },
    end(value: string) {
      body = value;
    },
  } as unknown as Parameters<typeof handlePoll>[1];
  await handlePoll(req, res, ["api", "poll"], query, agentId);
  return { status, body: JSON.parse(body) as { trigger: { type: string; taskId: string } | null } };
}

describe("task-filtered account admission polling", () => {
  test("HTTP task creation retains the installed raw-sweep follow-up configuration", async () => {
    const lead = createAgent({ name: "lead", isLead: true, status: "idle", maxTasks: 1 });
    const config = {
      disabled: true,
      onCompleted: "raw-sweep-complete",
      onFailed: "raw-sweep-failed",
    };
    const response = await fetch(`${taskOrigin}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-ID": lead.id },
      body: JSON.stringify({ task: "raw sweep fixture", followUpConfig: config }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string; followUpConfig: unknown };
    expect(created.followUpConfig).toEqual(config);
    expect(getTaskById(created.id)?.followUpConfig).toEqual(config);
  });
  test("HTTP managed builder handoff preserves the queued review and review-retry provenance", async () => {
    const builder = createAgent({ name: "builder", isLead: false, status: "idle", maxTasks: 1 });
    const reviewer = createAgent({ name: "reviewer", isLead: false, status: "idle", maxTasks: 1 });
    const build = createTaskExtended("build item", {
      agentId: builder.id,
      modelTier: "smart",
      tags: ["build", "overpace-night"],
      dir: "/workspace/personal/build",
    });
    startTask(build.id);
    const review = createTaskExtended(`Review the output from ${build.id}`, {
      agentId: reviewer.id,
      dependsOn: [build.id],
      tags: ["review", `review-of:${build.id}`, "overpace-night"],
      modelTier: "regular",
    });
    const final = createTaskExtended("finalise after review", {
      agentId: builder.id,
      dependsOn: [review.id],
    });
    const supersede = async (id: string, agentId: string) => {
      const response = await fetch(`${taskOrigin}/api/tasks/${id}/supersede`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-ID": agentId },
        body: JSON.stringify({ reason: "manual_supersede", pinToOriginalAgent: true }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as { resumeTaskId: string; kind: string };
    };
    const buildResume = await supersede(build.id, builder.id);
    const nextBuild = getTaskById(buildResume.resumeTaskId)!;
    expect(nextBuild.status).toBe("pending");
    expect(nextBuild.agentId).toBe(builder.id);
    expect(nextBuild.modelTier).toBe("smart");
    expect(nextBuild.tags).toContain("overpace-night");
    const reboundReview = getTaskById(review.id)!;
    expect(reboundReview.status).toBe("pending");
    expect(reboundReview.dependsOn).toEqual([nextBuild.id]);
    expect(reboundReview.tags).toContain(`review-of:${nextBuild.id}`);
    expect(reboundReview.task).toContain(nextBuild.id);
    expect(getTaskById(final.id)?.status).toBe("pending");
    expect((await poll(reviewer.id, review.id)).body.trigger).toBeNull();
    expect((await poll(builder.id, nextBuild.id)).body.trigger?.taskId).toBe(nextBuild.id);
    completeTask(nextBuild.id, "built");
    expect((await poll(reviewer.id, review.id)).body.trigger?.taskId).toBe(review.id);
    const reviewResume = await supersede(review.id, reviewer.id);
    const nextReview = getTaskById(reviewResume.resumeTaskId)!;
    expect(nextReview.dependsOn).toEqual([nextBuild.id]);
    expect(nextReview.tags).toContain(`review-of:${nextBuild.id}`);
    expect(nextReview.tags).toContain("overpace-night");
    expect(nextReview.modelTier).toBe("regular");
    expect(getTaskById(final.id)?.dependsOn).toEqual([nextReview.id]);
    expect(getTaskById(final.id)?.status).toBe("pending");
    expect((await poll(reviewer.id, nextReview.id)).body.trigger?.taskId).toBe(nextReview.id);
    completeTask(nextReview.id, "reviewed");
    expect((await poll(builder.id, final.id)).body.trigger?.taskId).toBe(final.id);
    expect((await supersede(build.id, builder.id)).kind).toBe("alreadyFinished");
    expect(
      getDb().query("SELECT count(*) AS n FROM agent_tasks WHERE parentTaskId = ?").get(build.id),
    ).toEqual({ n: 1 });
  });

  test("managed HTTP recovery cannot supersede another worker's task", async () => {
    const owner = createAgent({ name: "owner", isLead: false, status: "idle" });
    const foreign = createAgent({ name: "foreign", isLead: false, status: "idle" });
    const task = createTaskExtended("owned build", { agentId: owner.id });
    startTask(task.id);
    const response = await fetch(`${taskOrigin}/api/tasks/${task.id}/supersede`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-ID": foreign.id },
      body: JSON.stringify({ reason: "manual_supersede", pinToOriginalAgent: true }),
    });
    expect(response.status).toBe(403);
    expect(getTaskById(task.id)?.status).toBe("in_progress");
  });
  test("managed recovery keeps portable model intent pending on the stable offline agent", () => {
    const agent = createAgent({
      name: "managed offline",
      isLead: false,
      status: "offline",
      maxTasks: 1,
    });
    const parent = createTaskExtended("partial build", {
      agentId: agent.id,
      model: "gpt-5.6-sol",
      modelTier: "smart",
      dir: "/workspace/personal/build",
    });
    startTask(parent.id);
    supersedeTask(parent.id, { reason: "manual_supersede", resumeTaskId: null });
    const resume = createResumeFollowUp({
      parentId: parent.id,
      reason: "manual_supersede",
      pinToOriginalAgent: true,
    });
    expect(resume.kind).toBe("created");
    if (resume.kind !== "created") throw new Error("Expected durable resume");
    expect(resume.task.agentId).toBe(agent.id);
    expect(resume.task.status).toBe("pending");
    expect(resume.task.model).toBeUndefined();
    expect(resume.task.modelTier).toBe("smart");
    expect(resume.task.dir).toBe(parent.dir);
    expect(getTaskById(parent.id)?.status).toBe("superseded");
  });
  test("claim only the admitted pending task despite higher priority offered/pending work", async () => {
    const agent = createAgent({ name: "managed", isLead: false, status: "idle", maxTasks: 1 });
    const offered = createTaskExtended("unrelated offer", { offeredTo: agent.id });
    const earlier = createTaskExtended("higher priority", { agentId: agent.id, priority: 10 });
    const admitted = createTaskExtended("reserved task", { agentId: agent.id, priority: 1 });
    const result = await poll(agent.id, admitted.id);
    expect(result.status).toBe(200);
    expect(result.body.trigger?.taskId).toBe(admitted.id);
    expect(getTaskById(admitted.id)?.status).toBe("in_progress");
    expect(getTaskById(earlier.id)?.status).toBe("pending");
    expect(getTaskById(offered.id)?.status).toBe("offered");
  });

  test("missing/foreign task never consumes the agent's offered/pending/unassigned work", async () => {
    const agent = createAgent({ name: "managed", isLead: false, status: "idle", maxTasks: 1 });
    const other = createAgent({ name: "other", isLead: false, status: "idle" });
    const offered = createTaskExtended("unrelated offer", { offeredTo: agent.id });
    const pending = createTaskExtended("unrelated pending", { agentId: agent.id });
    const foreign = createTaskExtended("foreign", { agentId: other.id });
    const pool = createTaskExtended("unassigned pool work", {});
    for (const taskId of [crypto.randomUUID(), foreign.id, pool.id]) {
      expect((await poll(agent.id, taskId)).body.trigger).toBeNull();
    }
    expect(getTaskById(offered.id)?.status).toBe("offered");
    expect(getTaskById(pending.id)?.status).toBe("pending");
    expect(getTaskById(pool.id)?.status).toBe("unassigned");
  });

  test("unfiltered legacy polling still prioritises offered work", async () => {
    const agent = createAgent({ name: "legacy", isLead: false, status: "idle", maxTasks: 1 });
    const offered = createTaskExtended("offer", { offeredTo: agent.id });
    const pending = createTaskExtended("pending", { agentId: agent.id });
    const result = await poll(agent.id);
    expect(result.body.trigger?.type).toBe("task_offered");
    expect(result.body.trigger?.taskId).toBe(offered.id);
    expect(getTaskById(pending.id)?.status).toBe("pending");
  });

  test("filtered pending task still respects dependencies", async () => {
    const agent = createAgent({ name: "managed", isLead: false, status: "idle", maxTasks: 1 });
    const blocker = createTaskExtended("unfinished", {});
    const task = createTaskExtended("blocked", { agentId: agent.id, dependsOn: [blocker.id] });
    expect((await poll(agent.id, task.id)).body.trigger).toBeNull();
    expect(getTaskById(task.id)?.status).toBe("pending");
  });
});
