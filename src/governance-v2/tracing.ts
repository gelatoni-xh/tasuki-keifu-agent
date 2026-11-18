import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "langsmith";
import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import type { BatchInput, Metrics, Plan } from "./contracts.js";
import type { Researcher } from "./research.js";

type TraceClient = Pick<Client, "createRun" | "updateRun" | "flush">;
type Scope = { taskId: string; batchId: string; attemptId: string; graphThreadId: string; mode: string; agentMode: string };

const bestEffortFetch: typeof fetch = async (input, init) => {
  try {
    const response = await fetch(input, init);
    if (!response.ok) throw new Error(`LangSmith HTTP ${response.status}`);
    return response;
  } catch {
    // SDK 对普通网络异常会多次重试；观测故障不能拖住一次性治理命令。
    throw new Error("AbortError: LangSmith delivery unavailable");
  }
};

export function disableAutomaticGraphTracing() {
  for (const key of ["LANGSMITH_TRACING", "LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING", "LANGCHAIN_TRACING_V2"])
    process.env[key] = "false";
}

export function createGovernanceTracer(env: NodeJS.ProcessEnv = process.env, client?: TraceClient) {
  if (env.GOVERNANCE_LANGSMITH_TRACING !== "true") return undefined;
  let key = env.LANGSMITH_API_KEY?.trim();
  if (!key) {
    const keyPath = path.join(os.homedir(), ".codex", "secrets", "langsmith_api_key");
    if (existsSync(keyPath)) {
      try { key = readFileSync(keyPath, "utf8").trim(); } catch { /* 观测配置不影响治理。 */ }
    }
  }
  if (!key && !client) {
    console.warn("governance LangSmith tracing disabled: API key unavailable");
    return undefined;
  }
  const sink = client ?? new Client({ apiKey: key, apiUrl: env.LANGSMITH_ENDPOINT || undefined,
    workspaceId: env.LANGSMITH_WORKSPACE_ID || undefined, timeout_ms: 1000,
    callerOptions: { maxRetries: 0 }, fetchImplementation: bestEffortFetch });
  const project = env.GOVERNANCE_LANGSMITH_PROJECT?.trim() || "tasuki-keifu-agent-v2";
  let pending: Promise<void> = Promise.resolve();
  let warned = false;
  const warn = () => {
    if (!warned) console.warn("governance LangSmith trace delivery failed");
    warned = true;
  };
  const enqueue = (send: () => Promise<void>) => {
    pending = pending.then(send).catch(warn);
  };
  const start = (name: string, runType: string, scope: Scope, parentId?: string,
    extra: Record<string, unknown> = {}, startedAt = Date.now(), inputs: Record<string, unknown> = {}) => {
    const id = randomUUID();
    enqueue(() => sink.createRun({ id, name, run_type: runType, project_name: project,
      parent_run_id: parentId, inputs, extra: { metadata: { schema: "governance_v2_full_1", ...scope, ...extra } },
      start_time: startedAt }));
    return id;
  };
  const end = (id: string, status: "succeeded" | "failed", data: Record<string, unknown> = {}, endedAt = Date.now()) => {
    enqueue(() => sink.updateRun(id, { end_time: endedAt, outputs: { status, ...data } }));
  };
  return {
    graphCallbacks() {
      try {
        return [new LangChainTracer({ client: sink as Client, projectName: project })];
      } catch {
        warn();
        return [];
      }
    },
    startAttempt(scope: Scope, input: BatchInput) {
      const root = start("governance_batch_attempt", "chain", scope, undefined, {}, Date.now(), { input });
      return {
        research: ((inner: Researcher): Researcher => async (request, metrics) => {
          const before = metrics.researchCalls?.length ?? 0;
          const outcome = await inner(request, metrics);
          for (const call of metrics.researchCalls?.slice(before) ?? []) {
            const startedAt = call.startedAt ? Date.parse(call.startedAt) : Date.now();
            const startTime = Number.isFinite(startedAt) ? startedAt : Date.now();
            const id = start("governance_research_request", "llm", scope, root, {
              kind: request.kind, model: call.model, attemptNo: call.attemptNo,
              networkEnabled: call.networkEnabled,
            }, startTime, { request });
            end(id, call.stoppedReason ? "failed" : "succeeded", {
              ...(call === metrics.researchCalls?.at(-1) ? { outcome } : {}),
              inputTokens: call.inputTokens, outputTokens: call.outputTokens,
              webSearchCalls: call.webSearchCalls ?? 0,
              durationMs: call.durationMs, httpStatus: call.httpStatus,
              stopReason: call.stoppedReason ? "stopped" : undefined,
            }, startTime + call.durationMs);
          }
          return outcome;
        }),
        end(status: "succeeded" | "failed", metrics?: Pick<Metrics, "llmCalls" | "networkCalls" | "inputTokens" | "outputTokens">, plan?: Plan) {
          end(root, status, metrics ? { llmCalls: metrics.llmCalls, webSearchCalls: metrics.networkCalls,
            inputTokens: metrics.inputTokens, outputTokens: metrics.outputTokens, plan } : {});
        },
      };
    },
    async flush() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          pending.then(() => sink.flush()).catch(warn),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, 1500); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

export type GovernanceTracer = NonNullable<ReturnType<typeof createGovernanceTracer>>;
