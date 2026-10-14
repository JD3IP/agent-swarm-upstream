import { z } from "zod";
import { getResolvedConfig } from "../../be/db";
import type { ExecutorMeta } from "../../types";
import { getOpenRouterBaseUrl } from "../../utils/openrouter-base-url";
import { BaseExecutor, type ExecutorResult } from "./base";
import { validateJsonSchema } from "../json-schema-validator";

// ─── Schemas ────────────────────────────────────────────────

export const RawLlmConfigSchema = z.object({
  prompt: z.string(),
  model: z.string().optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
  fallbackPort: z.string().optional(),
  provider: z.enum(["openrouter", "anthropic"]).optional(),
  agentId: z.string().optional(),
  maxTokens: z.number().int().min(1).max(4096).optional(),
});

export const RawLlmOutputSchema = z.object({
  result: z.unknown(),
  model: z.string(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      cacheReadTokens: z.number().int().nonnegative(),
      cacheWriteTokens: z.number().int().nonnegative(),
    })
    .optional(),
});

type AnthropicMessage = {
  content: Array<{ type: string; text?: string; input?: unknown; name?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

type RawLlmDependencies = {
  anthropicCreate?: (apiKey: string, params: Record<string, unknown>) => Promise<AnthropicMessage>;
};

function resolveAnthropicKey(agentId?: string): string | undefined {
  if (agentId) {
    const scoped = getResolvedConfig(agentId).find((config) => config.key === "ANTHROPIC_API_KEY");
    if (scoped?.value) return scoped.value;
  }
  return process.env.ANTHROPIC_API_KEY;
}

async function createAnthropicMessage(
  apiKey: string,
  params: Record<string, unknown>,
): Promise<AnthropicMessage> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });
  return (await client.messages.create(
    params as unknown as Parameters<typeof client.messages.create>[0],
  )) as AnthropicMessage;
}

export async function executeRawLlm(
  config: z.infer<typeof RawLlmConfigSchema>,
  dependencies: RawLlmDependencies = {},
): Promise<
  | { status: "success"; output: z.infer<typeof RawLlmOutputSchema>; error?: string }
  | { status: "failed"; error: string }
> {
  const provider = config.provider ?? "openrouter";
  const modelName =
    config.model ??
    (provider === "anthropic" ? "claude-sonnet-5" : "google/gemini-3-flash-preview");

  try {
    if (provider === "anthropic") {
      const apiKey = resolveAnthropicKey(config.agentId);
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY is unavailable for the requested agent");

      const params: Record<string, unknown> = {
        model: modelName,
        max_tokens: config.maxTokens ?? 512,
        messages: [{ role: "user", content: config.prompt }],
      };
      if (config.schema) {
        params.tools = [
          {
            name: "submit_result",
            description: "Return the requested structured result.",
            input_schema: config.schema,
          },
        ];
        params.tool_choice = { type: "tool", name: "submit_result" };
      }

      const create = dependencies.anthropicCreate ?? createAnthropicMessage;
      const response = await create(apiKey, params);
      const result = config.schema
        ? response.content.find((part) => part.type === "tool_use" && part.name === "submit_result")
            ?.input
        : response.content
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("\n");
      if (result === undefined || result === "") {
        throw new Error("Anthropic returned no usable result");
      }
      if (config.schema) {
        const validationErrors = validateJsonSchema(config.schema, result);
        if (validationErrors.length > 0) {
          throw new Error(
            `Anthropic result failed schema validation: ${validationErrors.join("; ")}`,
          );
        }
      }

      return {
        status: "success",
        output: {
          result,
          model: modelName,
          usage: {
            inputTokens: response.usage?.input_tokens ?? 0,
            outputTokens: response.usage?.output_tokens ?? 0,
            cacheReadTokens: response.usage?.cache_read_input_tokens ?? 0,
            cacheWriteTokens: response.usage?.cache_creation_input_tokens ?? 0,
          },
        },
      };
    }

    const { createOpenAI } = await import("@ai-sdk/openai");
    const openrouter = createOpenAI({
      baseURL: getOpenRouterBaseUrl(),
      apiKey: process.env.OPENROUTER_API_KEY,
    });
    const model = openrouter(modelName);

    if (config.schema) {
      const { generateObject, jsonSchema } = await import("ai");
      const { object } = await generateObject({
        model,
        schema: jsonSchema(config.schema),
        prompt: config.prompt,
        providerOptions: {
          openai: { strictJsonSchema: false },
        },
      });
      return {
        status: "success",
        output: { result: object, model: modelName },
      };
    }

    const { generateText } = await import("ai");
    const { text } = await generateText({
      model,
      prompt: config.prompt,
    });
    return {
      status: "success",
      output: { result: text, model: modelName },
    };
  } catch (err) {
    // Re-throw rate-limit errors so executeStep's retry policy handles them
    // via the retry poller (scheduled backoff). Using the fallbackPort for
    // rate limits would trigger the semantic loop-back path instead, causing
    // runaway retries without any backoff.
    const httpStatus =
      (err as { status?: number; statusCode?: number })?.status ??
      (err as { status?: number; statusCode?: number })?.statusCode;
    const isRateLimited =
      httpStatus === 429 ||
      httpStatus === 529 ||
      (err instanceof Error && /rate.?limit|too many requests|529/i.test(err.message));
    if (isRateLimited) {
      throw err;
    }
    if (config.fallbackPort) {
      return {
        status: "success",
        output: { result: null, model: modelName },
        error: `LLM call failed, using fallback port: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return {
      status: "failed",
      error: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Executor ───────────────────────────────────────────────

export class RawLlmExecutor extends BaseExecutor<
  typeof RawLlmConfigSchema,
  typeof RawLlmOutputSchema
> {
  readonly type = "raw-llm";
  readonly mode = "instant" as const;
  readonly configSchema = RawLlmConfigSchema;
  readonly outputSchema = RawLlmOutputSchema;

  protected async execute(
    config: z.infer<typeof RawLlmConfigSchema>,
    context: Readonly<Record<string, unknown>>,
    _meta: ExecutorMeta,
  ): Promise<ExecutorResult<z.infer<typeof RawLlmOutputSchema>>> {
    const prompt = this.deps.interpolate(config.prompt, context as Record<string, unknown>);
    const result = await executeRawLlm({ ...config, prompt });
    if (result.status === "success" && result.error) {
      return {
        status: "success",
        output: result.output,
        nextPort: config.fallbackPort,
        error: result.error,
      };
    }
    return result;
  }
}
