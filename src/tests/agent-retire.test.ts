/**
 * D6a — agent tombstone route (roadmap: swarm-completion-roadmap.md D6a).
 *
 * Jody's ruling, 9 Sep 2026: agent removal is a TOMBSTONE, never a hard
 * delete. `deleteAgent()` throws on any real agent (FK from agent_skills),
 * and even a working hard-delete would silently orphan `agent_tasks` (no FK
 * to agents exists at all). So `POST /api/agents/:id/retire` sets
 * role="retired", capabilities=[], status="offline" atomically — mirroring
 * the state the 3 existing RETIRED pi-harness agents are already in — and
 * touches nothing else. No row is ever deleted by this route.
 *
 * ORCHESTRATOR-AUTHORED ACCEPTANCE TESTS. Written and pre-flighted red
 * against the unfixed tree before any implementation existed. Do not weaken
 * these to make the builder's life easier — if a fix can't satisfy the test
 * as written, the test was probably right and the approach was wrong.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { closeDb, createAgent, getAgentById, getDb, initDb } from "../be/db";
import { handleAgentRegister, handleAgentsRest } from "../http/agents";
import { can } from "../rbac";
import { LEGACY_POLICY } from "../rbac/legacy-policy";
import type { RbacPrincipal } from "../rbac/types";

const TEST_DB_PATH = "./test-agent-retire.sqlite";
const TEST_PORT = 14059 + (process.pid % 1000);

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function makeTestServer(): Server {
  return createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathSegments = url.pathname.split("/").filter(Boolean);
    const queryParams = url.searchParams;
    const myAgentId = (req.headers["x-agent-id"] as string | undefined) ?? undefined;

    try {
      if (await handleAgentRegister(req, res, pathSegments, myAgentId)) return;
      if (await handleAgentsRest(req, res, pathSegments, queryParams, myAgentId)) return;
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
}

let server: Server;
const baseUrl = `http://localhost:${TEST_PORT}`;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  server = makeTestServer();
  await new Promise<void>((resolve) => {
    server.listen(TEST_PORT, () => resolve());
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(() => {
  getDb().prepare("DELETE FROM agents").run();
  getDb().prepare("DELETE FROM agent_tasks").run();
});

describe("POST /api/agents/:id/retire", () => {
  test("tombstones a plain agent: role=retired, capabilities=[], status=offline", async () => {
    const a = createAgent({
      name: "retire-target-1",
      isLead: false,
      status: "idle",
      role: "coder",
      capabilities: ["implementation", "coding"],
    });

    const res = await fetch(`${baseUrl}/api/agents/${a.id}/retire`, { method: "POST" });
    expect(res.status).toBe(200);

    const row = getAgentById(a.id);
    expect(row?.role).toBe("retired");
    expect(row?.capabilities).toEqual([]);
    expect(row?.status).toBe("offline");
  });

  test("refuses to retire the Lead: 400, and the Lead is untouched", async () => {
    const lead = createAgent({
      name: "the-lead",
      isLead: true,
      status: "idle",
      role: "lead",
      capabilities: ["planning", "coordination"],
    });

    const res = await fetch(`${baseUrl}/api/agents/${lead.id}/retire`, { method: "POST" });
    expect(res.status).toBe(400);

    const row = getAgentById(lead.id);
    expect(row?.role).toBe("lead");
    expect(row?.status).toBe("idle");
    expect(row?.capabilities).toEqual(["planning", "coordination"]);
  });

  test("404 when the agent does not exist", async () => {
    const res = await fetch(`${baseUrl}/api/agents/nonexistent-agent-id/retire`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  test("idempotent: retiring an already-retired agent succeeds again with the same end state", async () => {
    const a = createAgent({
      name: "retire-target-2",
      isLead: false,
      status: "idle",
      role: "researcher",
      capabilities: ["research"],
    });

    const first = await fetch(`${baseUrl}/api/agents/${a.id}/retire`, { method: "POST" });
    expect(first.status).toBe(200);

    const second = await fetch(`${baseUrl}/api/agents/${a.id}/retire`, { method: "POST" });
    expect(second.status).toBe(200);

    const row = getAgentById(a.id);
    expect(row?.role).toBe("retired");
    expect(row?.capabilities).toEqual([]);
    expect(row?.status).toBe("offline");
  });

  test("never deletes a row: the agent's own agent_tasks history survives retirement", async () => {
    const a = createAgent({
      name: "retire-target-3",
      isLead: false,
      status: "idle",
      role: "coder",
      capabilities: ["implementation"],
    });

    // Insert a task row owned by this agent directly (no task-creation HTTP
    // surface needed for this check — only that the FK target still resolves
    // and the row is untouched after retire).
    const taskId = "task-owned-by-retire-target-3";
    getDb()
      .prepare(
        `INSERT INTO agent_tasks (id, agentId, task, status, createdAt, lastUpdatedAt)
         VALUES (?, ?, 'do the thing', 'completed', datetime('now'), datetime('now'))`,
      )
      .run(taskId, a.id);

    const res = await fetch(`${baseUrl}/api/agents/${a.id}/retire`, { method: "POST" });
    expect(res.status).toBe(200);

    const taskRow = getDb()
      .prepare<{ id: string; agentId: string }, [string]>(
        "SELECT id, agentId FROM agent_tasks WHERE id = ?",
      )
      .get(taskId);
    expect(taskRow?.id).toBe(taskId);
    expect(taskRow?.agentId).toBe(a.id);
  });
});

describe("agent.retire.any RBAC posture", () => {
  test("verb is registered and mapped to the lead-only legacy rule", () => {
    const rule = LEGACY_POLICY["agent.retire.any" as keyof typeof LEGACY_POLICY];
    expect(rule, "agent.retire.any must have a legacy-policy rule").toBeDefined();
    expect(rule.name).toBe("lead-only");
  });

  test("can() allows a lead principal and denies a plain worker", () => {
    const leadPrincipal: RbacPrincipal = { kind: "agent", agentId: "lead-x", isLead: true };
    const workerPrincipal: RbacPrincipal = { kind: "agent", agentId: "worker-x", isLead: false };

    const leadDecision = can({
      verb: "agent.retire.any" as never,
      principal: leadPrincipal,
      source: "http",
    });
    const workerDecision = can({
      verb: "agent.retire.any" as never,
      principal: workerPrincipal,
      source: "http",
    });

    expect(leadDecision.allow).toBe(true);
    expect(workerDecision.allow).toBe(false);
  });
});
