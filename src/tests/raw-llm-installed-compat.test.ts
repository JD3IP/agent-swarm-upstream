/** Preserve the public raw-sweep extension recovered from the installed API bundle. */

import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import { createAgent, upsertSwarmConfig } from "../be/db";
import { executeRawLlm, RawLlmConfigSchema } from "../workflows/executors/raw-llm";

const originalKey = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
});
const response = (content: Message["content"]): Message => ({
  id: "fixture",
  type: "message",
  role: "assistant",
  model: "fixture",
  content,
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 10,
    output_tokens: 2,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 4,
  },
});

describe("installed raw-sweep API compatibility", () => {
  test("retains Anthropic schema fields and bounded maxTokens", () => {
    expect(
      RawLlmConfigSchema.parse({
        prompt: "fixture",
        provider: "anthropic",
        agentId: "fixture",
        maxTokens: 4096,
      }).provider,
    ).toBe("anthropic");
    expect(RawLlmConfigSchema.safeParse({ prompt: "fixture", maxTokens: 4097 }).success).toBe(
      false,
    );
  });

  test("resolves the agent key before the global environment and preserves usage", async () => {
    process.env.ANTHROPIC_API_KEY = "fixture-env-key";
    const agent = createAgent({ name: "raw-compat", isLead: false, status: "idle" });
    upsertSwarmConfig({
      scope: "agent",
      scopeId: agent.id,
      key: "ANTHROPIC_API_KEY",
      value: "fixture-scoped-key",
    });
    const result = await executeRawLlm(
      { prompt: "fixture", provider: "anthropic", agentId: agent.id, maxTokens: 64 },
      {
        anthropicCreate: async (key, params) => {
          expect(key).toBe("fixture-scoped-key");
          expect(params.model).toBe("claude-sonnet-5");
          expect(params.max_tokens).toBe(64);
          return response([
            { type: "text", text: "part1", citations: [] },
            { type: "text", text: "part2", citations: [] },
          ]);
        },
      },
    );
    expect(result).toEqual({
      status: "success",
      output: {
        result: "part1\npart2",
        model: "claude-sonnet-5",
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
      },
    });
  });

  test("forces the structured result tool and validates the returned object", async () => {
    process.env.ANTHROPIC_API_KEY = "fixture-key";
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    const result = await executeRawLlm(
      { prompt: "fixture", provider: "anthropic", schema },
      {
        anthropicCreate: async (_key, params) => {
          expect(params.tool_choice).toEqual({ type: "tool", name: "submit_result" });
          expect(params.tools?.[0]).toEqual({
            name: "submit_result",
            description: "Return the requested structured result.",
            input_schema: schema,
          });
          return response([
            { type: "tool_use", id: "fixture", name: "submit_result", input: { ok: true } },
          ]);
        },
      },
    );
    expect(result.status).toBe("success");
    const invalid = await executeRawLlm(
      { prompt: "fixture", provider: "anthropic", schema },
      {
        anthropicCreate: async () =>
          response([
            { type: "tool_use", id: "fixture", name: "submit_result", input: { ok: "invalid" } },
          ]),
      },
    );
    expect(invalid.status).toBe("failed");
  });

  test("missing keys and empty results retain the existing fallback behavior", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const unavailable = await executeRawLlm({ prompt: "fixture", provider: "anthropic" });
    expect(unavailable.status).toBe("failed");
    process.env.ANTHROPIC_API_KEY = "fixture-key";
    const empty = await executeRawLlm(
      { prompt: "fixture", provider: "anthropic", fallbackPort: "unavailable" },
      {
        anthropicCreate: async () => response([]),
      },
    );
    expect(empty.status).toBe("success");
    expect("output" in empty && empty.output.result).toBe(null);
  });

  test("429 propagates to the durable retry policy instead of taking a semantic fallback", async () => {
    process.env.ANTHROPIC_API_KEY = "fixture-key";
    await expect(
      executeRawLlm(
        { prompt: "fixture", provider: "anthropic", fallbackPort: "retry" },
        {
          anthropicCreate: async () => {
            throw Object.assign(new Error("fixture quota"), { status: 429 });
          },
        },
      ),
    ).rejects.toThrow("fixture quota");
  });
});
