/**
 * Per-agent Codex pool-slot policy (`CODEX_OAUTH_PINNED_SLOT` /
 * `CODEX_OAUTH_RESERVED_SLOTS`).
 *
 * Without a policy, `resolveCodexOAuthCredentialInfo` draws randomly from every
 * `codex_oauth_<n>` slot, so a second ChatGPT account can never be dedicated to
 * one agent. The policy lets one agent (the Lead) use exactly one slot while
 * every other agent is kept off it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexSlotPolicy, resolveCodexOAuthCredentialInfo } from "../commands/runner";
import { resolveCodexAuthDirectory } from "../providers/codex-oauth/auth-json-fs";

const API_URL = "http://localhost:3013";
const API_KEY = "test-api-key";
const DRAWS = 40;

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalCodexHome = process.env.CODEX_HOME;
let tmpHome: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "codex-oauth-slot-policy-"));
  process.env.HOME = tmpHome;
  process.env.CODEX_HOME = join(tmpHome, ".codex");
  expect(resolveCodexAuthDirectory()).toBe(join(tmpHome, ".codex"));
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  await rm(tmpHome, { recursive: true, force: true });
});

function creds(accountId: string) {
  return {
    access: `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_user_id: `user-${accountId}` } })).toString("base64url")}.sig-${accountId}`,
    refresh: `rt_${accountId}`,
    expires: Date.now() + 3_600_000,
    accountId,
  };
}

/** Config store holding the given slot numbers (all unrate-limited). */
function mockSlots(slots: number[], available = slots): void {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (href.includes("/api/config/resolved")) {
      return new Response(
        JSON.stringify({
          configs: slots.map((n) => ({
            key: `codex_oauth_${n}`,
            value: JSON.stringify(creds(`acct-${n}`)),
          })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (href.includes("/api/keys/available")) {
      return new Response(JSON.stringify({ availableIndices: available }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function drawnSlots(policy: Parameters<typeof resolveCodexOAuthCredentialInfo>[2]) {
  const seen = new Set<number>();
  for (let i = 0; i < DRAWS; i++) {
    const info = await resolveCodexOAuthCredentialInfo(API_URL, API_KEY, policy);
    if (info) seen.add(info.selection.index);
    else seen.add(-1);
  }
  return [...seen].sort();
}

describe("parseCodexSlotPolicy", () => {
  it("returns an empty policy when nothing is configured", () => {
    expect(parseCodexSlotPolicy({})).toEqual({ pinnedSlot: undefined, reservedSlots: [] });
  });

  it("parses a pinned slot and a comma-separated reserved list", () => {
    expect(
      parseCodexSlotPolicy({ CODEX_OAUTH_PINNED_SLOT: " 1 ", CODEX_OAUTH_RESERVED_SLOTS: "1, 3" }),
    ).toEqual({ pinnedSlot: 1, reservedSlots: [1, 3] });
  });

  it("ignores malformed entries instead of throwing", () => {
    expect(
      parseCodexSlotPolicy({
        CODEX_OAUTH_PINNED_SLOT: "lead",
        CODEX_OAUTH_RESERVED_SLOTS: "2,x,,",
      }),
    ).toEqual({ pinnedSlot: undefined, reservedSlots: [2] });
  });
});

describe("resolveCodexOAuthCredentialInfo slot policy", () => {
  it("managed sparse-slot selection keeps its actual broker index and excludes refresh tokens", async () => {
    mockSlots([0, 7]);
    const info = await resolveCodexOAuthCredentialInfo(API_URL, API_KEY, {
      pinnedSlot: 7,
      reservedSlots: [],
      strict: true,
    });
    expect(info?.selection.index).toBe(7);
    expect(info?.isPoolBacked).toBe(true);
    const auth = await Bun.file(join(tmpHome, ".codex", "auth.json")).json();
    expect(auth.tokens.refresh_token).toBe("");
    expect(auth.tokens.account_id).toBe("acct-7");
  });

  it("managed missing, blocked and empty pools never use shared/local fallback", async () => {
    for (const [slots, available] of [
      [[0], [0]],
      [[0, 7], [0]],
      [[], []],
    ]) {
      mockSlots(slots!, available!);
      await expect(
        resolveCodexOAuthCredentialInfo(API_URL, API_KEY, {
          pinnedSlot: 7,
          reservedSlots: [],
          strict: true,
        }),
      ).rejects.toThrow("Managed account waiting");
    }
  });

  it("managed availability outage waits instead of random fallback", async () => {
    mockSlots([0, 7]);
    const currentFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) =>
      String(url).includes("/api/keys/available")
        ? new Response("unavailable", { status: 503 })
        : currentFetch(url, init)) as typeof fetch;
    await expect(
      resolveCodexOAuthCredentialInfo(API_URL, API_KEY, {
        pinnedSlot: 7,
        reservedSlots: [],
        strict: true,
      }),
    ).rejects.toThrow("availability is unavailable");
  });
  it("draws from the whole pool when no policy is set (unchanged behaviour)", async () => {
    mockSlots([0, 1]);
    expect(await drawnSlots({ reservedSlots: [] })).toEqual([0, 1]);
  });

  it("a pinned agent always gets exactly its slot", async () => {
    mockSlots([0, 1]);
    expect(await drawnSlots({ pinnedSlot: 1, reservedSlots: [1] })).toEqual([1]);
  });

  it("an unpinned agent never draws a reserved slot", async () => {
    mockSlots([0, 1]);
    expect(await drawnSlots({ reservedSlots: [1] })).toEqual([0]);
  });

  it("a pinned slot with no credentials falls back to the non-reserved pool", async () => {
    mockSlots([0, 2]);
    expect(await drawnSlots({ pinnedSlot: 1, reservedSlots: [1] })).toEqual([0, 2]);
  });

  it("an unpinned agent gets no credential when every slot is reserved", async () => {
    mockSlots([1]);
    const info = await resolveCodexOAuthCredentialInfo(API_URL, API_KEY, { reservedSlots: [1] });
    expect(info).toBeNull();
  });

  it("marks a pinned selection as pool-backed with the real slot index", async () => {
    mockSlots([0, 1]);
    const info = await resolveCodexOAuthCredentialInfo(API_URL, API_KEY, {
      pinnedSlot: 1,
      reservedSlots: [1],
    });
    expect(info?.isPoolBacked).toBe(true);
    expect(info?.selection.index).toBe(1);
  });
});
