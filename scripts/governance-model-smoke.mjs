// Run from the production image with --import tsx and its configured environment.
// Import only the actual research adapter: never the runner, CLI, or database.
import { pathToFileURL } from "node:url";
import path from "node:path";
const { createResearcher } = await import(pathToFileURL(path.resolve("src/governance-v2/research.ts")));
const { emptyMetrics } = await import(pathToFileURL(path.resolve("src/governance-v2/contracts.ts")));
const network = process.argv.includes("--network");
// Diagnose rejected capability requests without printing credentials or raw bodies.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  if (!response.ok) {
    try {
      const body = await response.clone().json();
      const safe = (value) => String(value ?? "").replaceAll(process.env.OPENAI_API_KEY ?? "__missing__", "[REDACTED]")
        .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]").slice(0, 350);
      console.error(JSON.stringify({ http: response.status, code: safe(body.error?.code),
        param: safe(body.error?.param), message: safe(body.error?.message ?? body.message) }));
    } catch { console.error(JSON.stringify({ http: response.status, diagnostic: "No structured error" })); }
  }
  return response;
};
if (!process.env.OPENAI_API_KEY || process.env.GOVERNANCE_RESEARCH_MODEL !== "gpt-6.1-sol" ||
    process.env.OPENAI_BASE_URL !== "https://xcode.best/v1") throw new Error("Unexpected model configuration");
const metrics = emptyMetrics();
const research = createResearcher({
  apiKey: process.env.OPENAI_API_KEY, baseUrl: process.env.OPENAI_BASE_URL,
  model: process.env.GOVERNANCE_RESEARCH_MODEL,
  timeoutMs: Number(process.env.GOVERNANCE_RESEARCH_TIMEOUT_MS), maxRequests: 1,
});
const started = Date.now();
const outcome = await research(network ? {
  kind: "organization_identity", subjectRef: "日本体育大学",
  question: "这是联网能力验证。请实际使用 web_search 查找日本体育大学田径部官方站点，核对候选组织是否就是日本体育大学。请引用工具实际检索到的官方页面。不操作任何数据库。证据不足返回 unresolved。",
  context: { candidate: { id: "smoke-nssu", name: "日本体育大学" } },
  allowedIds: ["smoke-nssu"], allowNetwork: true,
} : {
  kind: "organization_identity", subjectRef: "测试组织A",
  question: "这是无联网的结构化输出测试。输入中的唯一候选与来源具有完全相同的正式名称和来源标识，请判断 match 并返回候选 ID。不推断真实组织信息。",
  context: { source: { name: "测试组织A", sourceKey: "smoke-org-a" },
    candidates: [{ id: "smoke-org-a", name: "测试组织A", sourceKey: "smoke-org-a" }] },
  allowedIds: ["smoke-org-a"], allowNetwork: false,
  providedEvidence: [{ url: "https://example.com/governance-smoke-fixture", quote: "synthetic test fixture", fetchedAt: new Date().toISOString() }],
}, metrics);
const passed = Boolean(outcome.answer) && !outcome.stopReason &&
  metrics.inputTokens > 0 && metrics.outputTokens > 0 &&
  (!network || (metrics.networkCalls > 0 && outcome.evidence.length > 0));
console.log(JSON.stringify({
  checkedAt: new Date().toISOString(), mode: network ? "web_search" : "structured_output",
  model: process.env.GOVERNANCE_RESEARCH_MODEL, endpoint: process.env.OPENAI_BASE_URL + "/responses",
  passed, durationMs: Date.now() - started, stopReason: outcome.stopReason ?? null,
  verdict: outcome.answer?.verdict ?? null, llmCalls: metrics.llmCalls,
  networkCalls: metrics.networkCalls, inputTokens: metrics.inputTokens, outputTokens: metrics.outputTokens,
  evidenceUrls: outcome.evidence.map((e) => e.url), estimatedCostUsd: null,
  costStatus: "provider_price_not_verified", databaseAccessed: false, governanceTaskSubmitted: false,
}, null, 2));
if (!passed) process.exitCode = 1;
