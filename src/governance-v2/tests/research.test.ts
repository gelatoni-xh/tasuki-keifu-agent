import assert from "node:assert/strict";
import test from "node:test";
import { createResearcher } from "../research.js";
import { emptyMetrics } from "../contracts.js";

const request = {
  kind: "person_identity" as const,
  subjectRef: "r",
  question: "同名身份疑难",
  context: {},
  allowedIds: ["p"],
};
const answer = {
  verdict: "match",
  targetId: "p",
  duplicateIds: [],
  reason: "官方所属与赛事资料一致",
  evidence: [{ url: "https://example.org/official", quote: "学校所属" }],
  corrections: [],
  split: null,
};
test("research validates citations and structured output and stops at request budget", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, "json_schema");
    return new Response(
      JSON.stringify({
        output: [
          {
            type: "web_search_call",
            action: { sources: [{ url: "https://example.org/official" }] },
          },
          {
            type: "message",
            content: [{ type: "output_text", text: JSON.stringify(answer) }],
          },
        ],
        usage: { input_tokens: 100, output_tokens: 30 },
      }),
      { status: 200 },
    );
  };
  try {
    const metrics = emptyMetrics(),
      research = createResearcher({
        apiKey: "test-only",
        model: "configured-model",
        timeoutMs: 1000,
        maxRequests: 1,
      });
    const result = await research(request, metrics);
    assert.equal(result.answer?.targetId, "p");
    assert.equal(metrics.llmCalls, 1);
    assert.equal(metrics.networkCalls, 1);
    assert.equal(metrics.inputTokens, 100);
    assert.equal(
      (await research(request, metrics)).stopReason,
      "research_budget_exhausted",
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
test("invented source URLs and invalid JSON cannot produce an executable identity decision", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: JSON.stringify(answer) }],
            },
          ],
        }),
      );
    const research = createResearcher({
      apiKey: "test-only",
      model: "configured-model",
      timeoutMs: 1000,
      maxRequests: 2,
    });
    assert.equal(
      (await research(request, emptyMetrics())).stopReason,
      "research_has_no_verified_source_reference",
    );
    globalThis.fetch = async () => new Response("not-json");
    assert.equal(
      (await research(request, emptyMetrics())).stopReason,
      "research_unusable_response",
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("missing configuration, oversized questions and exhausted persisted budget make no model call", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    assert.fail("Must not call provider");
  };
  try {
    assert.equal(
      (
        await createResearcher({ timeoutMs: 1000, maxRequests: 1 })(
          request,
          emptyMetrics(),
        )
      ).stopReason,
      "research_not_configured",
    );
    const configured = {
      apiKey: "test",
      model: "configured-model",
      timeoutMs: 1000,
      maxRequests: 1,
    };
    assert.equal(
      (
        await createResearcher(configured)(
          { ...request, context: "x".repeat(24001) },
          emptyMetrics(),
        )
      ).stopReason,
      "research_scope_too_large",
    );
    assert.equal(
      (
        await createResearcher({ ...configured, reserve: async () => false })(
          request,
          emptyMetrics(),
        )
      ).stopReason,
      "research_budget_exhausted",
    );
  } finally {
    globalThis.fetch = original;
  }
});
