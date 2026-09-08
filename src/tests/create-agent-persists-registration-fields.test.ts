/**
 * Regression test for the swarm-completion-roadmap D1/D1a finding: `createAgent`
 * accepts `role`, `capabilities`, and `description` (its TS parameter type is
 * `Omit<Agent, "id" | "createdAt" | "lastUpdatedAt">`, and `POST /api/agents`
 * genuinely computes and passes all three — see src/http/agents.ts), but the
 * INSERT statement only ever binds id/name/isLead/status/maxTasks/provider/
 * harnessProvider. The other three are silently discarded on every fresh
 * registration.
 *
 * This matters beyond data loss: `isAgentEligibleForTask` (src/be/db.ts)
 * requires `agent.role === affinity.role` for any cross-agent pooled-task
 * re-claim, with no fail-open path. An agent registered with `role` set but
 * landing NULL is invisibly ineligible for every such re-claim except its own
 * interrupted task (matched by `sourceAgentId`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, getAgentById, getDb, initDb } from "../be/db";

const TEST_DB_PATH = "./test-create-agent-persists-registration-fields.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(() => {
  getDb().prepare("DELETE FROM agents").run();
});

describe("createAgent: role, capabilities, description persist on first registration", () => {
  test("role and capabilities survive the insert and are readable back via getAgentById", () => {
    const created = createAgent({
      name: "Coder 3",
      isLead: false,
      status: "idle",
      role: "coder",
      capabilities: ["implementation", "coding", "testing", "review"],
    });

    expect(created.role).toBe("coder");
    expect(created.capabilities).toEqual(["implementation", "coding", "testing", "review"]);

    // Read back through a fresh SELECT, not the RETURNING clause of the
    // insert itself — a bug that only fixed the returned object but not the
    // stored row would pass on `created` alone.
    const reread = getAgentById(created.id);
    expect(reread?.role).toBe("coder");
    expect(reread?.capabilities).toEqual(["implementation", "coding", "testing", "review"]);
  });

  test("description survives the insert", () => {
    const created = createAgent({
      name: "Researcher 2",
      isLead: false,
      status: "idle",
      capabilities: [],
      description: "a description supplied at registration time",
    });

    expect(created.description).toBe("a description supplied at registration time");
    expect(getAgentById(created.id)?.description).toBe(
      "a description supplied at registration time",
    );
  });

  test("omitting role/capabilities/description still succeeds with the documented defaults", () => {
    // Backward compatibility: a caller that sends none of these three must
    // keep getting role=undefined, capabilities=[], description=undefined —
    // exactly rowToAgent's existing NULL-coalescing behavior — not a thrown
    // error and not a NOT NULL constraint violation.
    const created = createAgent({
      name: "Minimal Agent",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    expect(created.role).toBeUndefined();
    expect(created.capabilities).toEqual([]);
    expect(created.description).toBeUndefined();
  });
});
