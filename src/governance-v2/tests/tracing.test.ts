import assert from "node:assert/strict";
import test from "node:test";
import { createGovernanceTracer, disableAutomaticGraphTracing } from "../tracing.js";
import { emptyMetrics } from "../contracts.js";

const scope = { taskId: "task-1", batchId: "batch-1", attemptId: "attempt-1",
  graphThreadId: "thread-1", mode: "dry_run", agentMode: "full" };

test("v2 traces retain attempt input, research context and plan", async () => {
  const sent: unknown[] = [];
  const client = {
    async createRun(run: unknown) { sent.push(run); },
    async updateRun(_id: string, run: unknown) { sent.push(run); },
    async flush() {},
  };
  const tracer = createGovernanceTracer({ GOVERNANCE_LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: "test-key" }, client as never)!;
  const attempt = tracer.startAttempt(scope, { source: "full-batch-input" } as never);
  const metrics = emptyMetrics();
  const research = attempt.research(async (_request, measured) => {
    measured.llmCalls++;
    measured.networkCalls += 2;
    measured.researchCalls = [{ model: "test-model", category: "person_identity", durationMs: 12,
      inputTokens: 3, outputTokens: 4, webSearchCalls: 2, stoppedReason: null }];
    return { evidence: [], stopReason: "full-research-outcome" };
  });
  const result = await research({ kind: "person_identity", subjectRef: "private-name",
    question: "private-question", context: { secret: "private-context" }, allowedIds: [] }, metrics);
  attempt.end("succeeded", metrics, { summary: "full-plan" } as never);
  await tracer.flush();
  assert.equal(result.stopReason, "full-research-outcome");
  const payload = JSON.stringify(sent);
  assert.equal(sent.length, 4);
  for (const content of ["full-batch-input",
    "private-name", "private-question", "private-context", "full-research-outcome", "full-plan"])
    assert.ok(payload.includes(content), `${content} should be traced`);
  assert.ok(payload.includes('"webSearchCalls":2'));
  assert.ok(payload.includes('"llmCalls":1'));
});

test("delivery failures do not change governance results", async () => {
  const client = {
    async createRun() { throw new Error("offline"); },
    async updateRun() { throw new Error("offline"); },
    async flush() { throw new Error("offline"); },
  };
  const tracer = createGovernanceTracer({ GOVERNANCE_LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: "test-key" }, client as never)!;
  const attempt = tracer.startAttempt(scope, {} as never);
  attempt.end("succeeded");
  await tracer.flush();
});

test("automatic graph tracing is disabled for every LangChain alias", () => {
  const keys = ["LANGSMITH_TRACING", "LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING", "LANGCHAIN_TRACING_V2"];
  const before = keys.map(key => process.env[key]);
  try {
    disableAutomaticGraphTracing();
    for (const key of keys) assert.equal(process.env[key], "false");
  } finally {
    keys.forEach((key, index) => {
      if (before[index] === undefined) delete process.env[key];
      else process.env[key] = before[index];
    });
  }
});

test("v2 injects a LangGraph tracer into the v2 cloud project", () => {
  const tracer = createGovernanceTracer({ GOVERNANCE_LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: "test-key" },
    { async createRun() {}, async updateRun() {}, async flush() {} } as never)!;
  assert.equal(tracer.graphCallbacks()[0].projectName, "tasuki-keifu-agent-v2");
});
