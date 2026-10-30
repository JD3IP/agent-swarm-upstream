import { z } from "zod";
import type { ProviderResult } from "../providers/types.ts";
import type { CredentialSelection } from "../utils/credentials.ts";
import {
  isCodexCreditsExhaustedMessage,
  isRateLimitMessage,
  parseRateLimitResetTime,
} from "../utils/error-tracker.ts";

const credentialRefSchema = z.object({
  keyType: z.enum(["codex_oauth", "claude_oauth"]),
  scope: z.enum(["global", "agent"]),
  scopeId: z.string().min(1).nullable(),
  index: z.number().int().nonnegative(),
});

const readyBindingSchema = z.object({
  managed: z.literal(true),
  state: z.literal("ready"),
  accountId: z.string().min(1),
  provider: z.enum(["codex", "claude"]),
  model: z.string().min(1),
  modelTier: z.enum(["smol", "regular", "smart", "ultra"]).optional(),
  credentialRef: credentialRefSchema,
  credentialGeneration: z.number().int().positive(),
  admissionId: z.string().min(1),
  generation: z.number().int().positive(),
  owner: z.string().min(1),
  taskId: z.string().min(1).nullable(),
  expiresAt: z.string().datetime(),
  role: z.string().min(1),
});

export type AccountBinding = z.infer<typeof readyBindingSchema>;

export interface AccountAdmission {
  id: string;
  generation: number;
  owner: string;
  accountId: string;
  provider: string;
  model: string;
  role: string;
  credentialRef: AccountBinding["credentialRef"];
  credentialGeneration: number;
  taskId: string | null;
  sessionId: string | null;
  state: "reserved" | "active" | "released";
  expiresAt: string;
  eligible?: boolean;
  eligibilityReason?: string;
}

const admissionSchema = z.object({
  id: z.string().min(1),
  generation: z.number().int().positive(),
  owner: z.string().min(1),
  accountId: z.string().min(1),
  provider: z.enum(["codex", "claude"]),
  model: z.string().min(1),
  role: z.string().min(1),
  credentialRef: credentialRefSchema,
  credentialGeneration: z.number().int().positive(),
  taskId: z.string().min(1).nullable(),
  sessionId: z.string().min(1).nullable(),
  state: z.enum(["reserved", "active", "released"]),
  expiresAt: z.string().datetime(),
  eligible: z.boolean().optional(),
  eligibilityReason: z.string().optional(),
});

export class AccountCapacityWaitError extends Error {
  constructor(reason: string) {
    super(`Managed account waiting: ${reason}`);
    this.name = "AccountCapacityWaitError";
  }
}

/** Once enabled at boot, an absent/deleted config row must never disable admission. */
export function isAccountManaged(env: Record<string, string | undefined>): boolean {
  return env.SWARM_ACCOUNT_MANAGED === "true" || process.env.SWARM_ACCOUNT_MANAGED === "true";
}

export function readAccountBinding(
  env: Record<string, string | undefined>,
  agentId: string,
  now = Date.now(),
): AccountBinding {
  let value: unknown;
  try {
    value = JSON.parse(env.SWARM_ACCOUNT_BINDING ?? "null");
  } catch {
    throw new AccountCapacityWaitError("binding is invalid");
  }
  const result = readyBindingSchema.safeParse(value);
  if (!result.success) throw new AccountCapacityWaitError("binding is not ready");
  const binding = result.data;
  if (binding.owner !== `account-controller:${agentId}`) {
    throw new AccountCapacityWaitError("binding belongs to another worker");
  }
  const ref = binding.credentialRef;
  if (
    (binding.provider === "codex" && (ref.keyType !== "codex_oauth" || ref.scope !== "global")) ||
    (binding.provider === "claude" && ref.keyType !== "claude_oauth") ||
    (ref.scope === "global" && ref.scopeId !== null) ||
    (ref.scope === "agent" && ref.scopeId !== agentId)
  ) {
    throw new AccountCapacityWaitError("credential scope does not match the worker");
  }
  if (Date.parse(binding.expiresAt) <= now) {
    throw new AccountCapacityWaitError("binding expired");
  }
  return binding;
}

/** Managed tier mappings live in the host policy; task intent must still match its snapshot. */
export function managedTaskModel(
  binding: AccountBinding,
  task: { model?: string; modelTier?: string },
): string {
  if (
    (task.modelTier || undefined) !== binding.modelTier ||
    (task.model && task.model !== binding.model)
  ) {
    throw new AccountCapacityWaitError("task model intent changed after reservation");
  }
  return binding.model;
}

function sameCredentialRef(
  a: AccountBinding["credentialRef"],
  b: AccountBinding["credentialRef"],
): boolean {
  return (
    a.keyType === b.keyType && a.scope === b.scope && a.scopeId === b.scopeId && a.index === b.index
  );
}

export function assertAdmissionMatches(
  binding: AccountBinding,
  admission: AccountAdmission,
  taskId: string | null,
  state: "reserved" | "active",
  now = Date.now(),
): void {
  if (
    admission.id !== binding.admissionId ||
    admission.generation !== binding.generation ||
    admission.owner !== binding.owner ||
    admission.accountId !== binding.accountId ||
    admission.provider !== binding.provider ||
    admission.model !== binding.model ||
    admission.role !== binding.role ||
    admission.credentialGeneration !== binding.credentialGeneration ||
    !sameCredentialRef(admission.credentialRef, binding.credentialRef) ||
    admission.state !== state ||
    (binding.taskId !== null && taskId !== null && binding.taskId !== taskId) ||
    (admission.taskId !== null && taskId !== null && admission.taskId !== taskId) ||
    (binding.taskId !== null && admission.taskId !== binding.taskId) ||
    Date.parse(admission.expiresAt) <= now ||
    !Number.isFinite(Date.parse(admission.expiresAt))
  ) {
    throw new AccountCapacityWaitError("reservation no longer matches the binding");
  }
}

export interface AccountAdmissionClient {
  binding: AccountBinding;
  request(
    action?: "activate" | "renew" | "release",
    body?: Record<string, unknown>,
  ): Promise<AccountAdmission>;
}

export function accountAdmissionClient(
  env: Record<string, string | undefined>,
  binding: AccountBinding,
): AccountAdmissionClient {
  const url = env.SIDECAR_URL?.replace(/\/$/, "");
  const token = env.SIDECAR_TOKEN;
  if (!url || !token) throw new AccountCapacityWaitError("sidecar connection is missing");
  return {
    binding,
    async request(action, body = {}) {
      try {
        const response = await fetch(
          `${url}/account-admissions/${encodeURIComponent(binding.admissionId)}${action ? `/${action}` : ""}`,
          {
            method: action ? "POST" : "GET",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            ...(action
              ? {
                  body: JSON.stringify({
                    owner: binding.owner,
                    generation: binding.generation,
                    ...body,
                  }),
                }
              : {}),
            signal: AbortSignal.timeout(5_000),
          },
        );
        if (!response.ok)
          throw new AccountCapacityWaitError(`reservation ${action ?? "read"} rejected`);
        const result = (await response.json()) as { admission?: unknown };
        const parsed = admissionSchema.safeParse(result.admission);
        if (!parsed.success) throw new AccountCapacityWaitError("reservation response is invalid");
        return parsed.data;
      } catch (error) {
        if (error instanceof AccountCapacityWaitError) throw error;
        // Do not put upstream bodies, URLs, credentials or the binding in logs.
        throw new AccountCapacityWaitError("sidecar is unavailable");
      }
    },
  };
}

export async function loadExpectedAccountIdentity(
  env: Record<string, string | undefined>,
  binding: AccountBinding,
): Promise<string> {
  try {
    const response = await fetch(
      `${env.SIDECAR_URL?.replace(/\/$/, "")}/accounts/${encodeURIComponent(binding.accountId)}`,
      {
        headers: { Authorization: `Bearer ${env.SIDECAR_TOKEN}` },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) throw new Error("unavailable");
    const { account } = (await response.json()) as {
      account?: {
        id: string;
        identityKey: string;
        provider: string;
        credentialGeneration: number;
        credentialRef: AccountBinding["credentialRef"];
      };
    };
    if (
      !account ||
      !account.identityKey ||
      account.id !== binding.accountId ||
      account.provider !== binding.provider ||
      account.credentialGeneration !== binding.credentialGeneration ||
      !sameCredentialRef(account.credentialRef, binding.credentialRef)
    ) {
      throw new Error("mismatch");
    }
    return account.identityKey;
  } catch {
    throw new AccountCapacityWaitError("registered account identity is unavailable");
  }
}

export async function readClaudeAccountProfile(token: string): Promise<unknown> {
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/profile", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("unavailable");
    return await response.json();
  } catch {
    throw new AccountCapacityWaitError("selected Claude account identity is unavailable");
  }
}

export interface AccountIncident {
  kind: "quota" | "auth" | "provider";
  resetAt?: string;
}

/** Infrastructure capacity failures may resume; ordinary build/test failures stay failures. */
export function classifyAccountIncident(
  result: ProviderResult,
  leaseExpired = false,
): AccountIncident | null {
  if (leaseExpired) return { kind: "provider" };
  if (result.exitCode === 0 && !result.isError && !result.rateLimitResetAt) return null;
  const reason = result.failureReason || "";
  const category = result.errorCategory || "";
  if (
    result.rateLimitResetAt ||
    ["rate_limit", "quota", "usage_limit", "credits_exhausted"].includes(category) ||
    isRateLimitMessage(reason) ||
    isCodexCreditsExhaustedMessage(reason)
  ) {
    const resetAt = result.rateLimitResetAt || parseRateLimitResetTime(reason) || undefined;
    return {
      kind: "quota",
      ...(resetAt && Number.isFinite(Date.parse(resetAt)) ? { resetAt } : {}),
    };
  }
  if (
    ["auth", "auth_error", "authentication"].includes(category) ||
    /\[auth-error\]|authentication failed|invalid_grant|refresh token.*(?:revoked|expired|already used)|unauthorized/i.test(
      reason,
    )
  ) {
    return { kind: "auth" };
  }
  if (
    ["server_error", "model_unavailable", "provider_unavailable"].includes(category) ||
    /overloaded|service unavailable|model.*(?:temporarily unavailable|not available)|\b529\b/i.test(
      reason,
    )
  ) {
    return { kind: "provider" };
  }
  return null;
}

export async function reportAccountIncident(
  env: Record<string, string | undefined>,
  client: AccountAdmissionClient,
  sessionId: string,
  incident: AccountIncident,
): Promise<void> {
  const binding = client.binding;
  try {
    const response = await fetch(
      `${env.SIDECAR_URL?.replace(/\/$/, "")}/accounts/${encodeURIComponent(binding.accountId)}/incident`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.SIDECAR_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          credentialGeneration: binding.credentialGeneration,
          admissionId: binding.admissionId,
          generation: binding.generation,
          owner: binding.owner,
          sessionId,
          model: binding.model,
          ...incident,
        }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) throw new Error("rejected");
  } catch {
    throw new AccountCapacityWaitError("account incident awaits durable reconciliation");
  }
}

/** Called only after ProviderSession.waitForCompletion proves the provider exited. */
export async function completeManagedAccountSession(
  env: Record<string, string | undefined>,
  client: AccountAdmissionClient,
  sessionId: string,
  result: ProviderResult,
  park: () => Promise<boolean>,
  leaseExpired = false,
  retryMs = 10_000,
): Promise<boolean> {
  const incident = classifyAccountIncident(result, leaseExpired);
  if (incident) {
    // A stopped process keeps its account fenced while either owner is down.
    for (;;) {
      try {
        await reportAccountIncident(env, client, sessionId, incident);
        if (!(await park()))
          throw new AccountCapacityWaitError("task awaits durable capacity handoff");
        break;
      } catch {
        console.warn("[account-capacity] stopped session awaits durable capacity handoff");
        await Bun.sleep(retryMs);
      }
    }
  }
  for (;;) {
    try {
      await client.request("release", {
        outcome: incident ? "stopped" : result.exitCode === 0 ? "completed" : "failed",
        runnerStopped: true,
        taskId: client.binding.taskId,
        sessionId,
      });
      break;
    } catch {
      console.warn("[account-capacity] stopped session awaits admission reconciliation");
      await Bun.sleep(retryMs);
    }
  }
  return incident !== null;
}

export async function verifyAccountAdmission(
  env: Record<string, string | undefined>,
  configFetched: boolean,
  agentId: string,
  provider: string,
  model: string,
  taskId: string | null = null,
): Promise<AccountAdmissionClient | undefined> {
  if (!isAccountManaged(env)) return undefined;
  if (!configFetched) throw new AccountCapacityWaitError("fresh configuration is unavailable");
  const binding = readAccountBinding(env, agentId);
  if (binding.provider !== provider || binding.model !== model) {
    throw new AccountCapacityWaitError("runtime provider or model has not reconciled");
  }
  if (taskId !== null && binding.taskId !== null && taskId !== binding.taskId) {
    throw new AccountCapacityWaitError("task does not match the reserved work");
  }
  const client = accountAdmissionClient(env, binding);
  const admission = await client.request();
  assertAdmissionMatches(binding, admission, taskId, "reserved");
  if (admission.eligible !== true)
    throw new AccountCapacityWaitError("reservation account is no longer eligible");
  return client;
}

/** A managed worker must wait during an API-first rolling deployment. */
export async function verifyTaskFilteredPollSupport(apiUrl: string, apiKey: string): Promise<void> {
  try {
    const response = await fetch(`${apiUrl}/openapi.json`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("unavailable");
    const schema = (await response.json()) as {
      paths?: Record<string, { get?: { parameters?: Array<{ name?: string; in?: string }> } }>;
    };
    if (
      !schema.paths?.["/api/poll"]?.get?.parameters?.some(
        (p) => p.name === "taskId" && p.in === "query",
      )
    ) {
      throw new Error("unsupported");
    }
  } catch {
    throw new AccountCapacityWaitError("API has not advertised task-filtered polling");
  }
}

/** Auth is stripped first: managed sessions may never fall back to another provider/account. */
export function clearManagedCredentials(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    if (/^(?:codex|claude)_oauth(?:_\d+)?$/i.test(key)) env[key] = "";
  }
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_CUSTOM_HEADERS",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "CODEX_OAUTH",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "AGENT_SWARM_CLAUDE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_SCOPES",
  ]) {
    env[key] = "";
  }
  env.CLAUDE_CODE_USE_BEDROCK = "0";
  env.CLAUDE_CODE_USE_VERTEX = "0";
  env.CLAUDE_CODE_USE_FOUNDRY = "0";
  env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
}

export function selectManagedClaudeCredential(
  env: Record<string, string | undefined>,
  binding: AccountBinding,
  configRows: Array<{ key: string; value: string; scope?: string; scopeId?: string | null }>,
): CredentialSelection[] {
  const pool =
    env.CLAUDE_CODE_OAUTH_TOKEN?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? [];
  clearManagedCredentials(env);
  if (binding.provider !== "claude") return [];
  const ref = binding.credentialRef;
  const source = configRows.find((row) => row.key === "CLAUDE_CODE_OAUTH_TOKEN");
  if (!source || source.scope !== ref.scope || (source.scopeId ?? null) !== ref.scopeId) {
    throw new AccountCapacityWaitError("Claude credential source changed");
  }
  const selected = pool[ref.index];
  if (!selected) throw new AccountCapacityWaitError("Claude credential index is missing");
  env.CLAUDE_CODE_OAUTH_TOKEN = selected;
  return [
    {
      selected,
      index: ref.index,
      total: pool.length,
      keySuffix: selected.slice(-5),
      keyType: "CLAUDE_CODE_OAUTH_TOKEN",
      isRateLimitFallback: false,
    },
  ];
}

/** Renew the lease while the process exists. Losing it stops work; expiry never frees a live account. */
export function maintainAccountAdmission(
  client: AccountAdmissionClient,
  initial: AccountAdmission,
  abort: () => Promise<void>,
  intervalMs = 30_000,
): { stop(): void } {
  let expiresAt = Date.parse(initial.expiresAt);
  let inFlight = false;
  let stopped = false;
  let expiryTimer: ReturnType<typeof setTimeout>;
  const scheduleExpiry = () => {
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(
      () => {
        if (!stopped) void abort().catch(() => {});
      },
      Math.max(0, expiresAt - Date.now()),
    );
    expiryTimer.unref?.();
  };
  scheduleExpiry();
  const timer = setInterval(async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const renewed = await client.request("renew", {
        leaseSeconds: 300,
        taskId: initial.taskId,
        sessionId: initial.sessionId,
      });
      assertAdmissionMatches(client.binding, renewed, initial.taskId, "active");
      expiresAt = Date.parse(renewed.expiresAt);
      scheduleExpiry();
    } catch {
      if (Date.now() >= expiresAt && !stopped) await abort().catch(() => {});
    } finally {
      inFlight = false;
    }
  }, intervalMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(expiryTimer);
    },
  };
}
