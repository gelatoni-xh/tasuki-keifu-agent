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
test("cross-check wire schema permits source row keys and rejects person entity IDs", async () => {
  const original = globalThis.fetch;
  let personKey = "1765";
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const issue = body.text.format.schema.properties.issues.items;
    assert.deepEqual(issue.properties.personKeys.items.enum, ["1765"]);
    assert.deepEqual(issue.properties.organizationKey.enum, ["school"]);
    assert.deepEqual(issue.properties.evidenceRefs.items.enum, ["source:1765", "source:school"]);
    return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
      issues: [{ issueKey: "check", issueType: "mapping_conflict", organizationKey: "school", personKeys: [personKey],
        evidenceRefs: ["source:1765"], reason: "实质身份矛盾", suggestedAction: "unresolved" }],
    }) }] }] }));
  };
  try {
    const research = createResearcher({ apiKey: "test-only", model: "configured-model", timeoutMs: 1000, maxRequests: 3 });
    const scoped = { ...request, kind: "normalization_cross_check" as const, context: {
      rows: [{ key: "1765", organizationKey: "school", provisionalPersonId: "gov_person" }], organizations: [{ key: "school" }],
      catalog: { evidence: [{ key: "source:1765" }, { key: "source:school" }] },
    } };
    assert.deepEqual((await research(scoped, emptyMetrics())).crossAnswer?.issues[0].personKeys, ["1765"]);
    personKey = "gov_person";
    const metrics = emptyMetrics();
    assert.equal((await research(scoped, metrics)).stopReason, "research_unusable_response");
    assert.equal(metrics.researchCalls?.[0].diagnostic?.phase, "output_schema");
  } finally { globalThis.fetch = original; }
});
test("organization batch strict schema omits person-only assessments while person batches require them", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    for (const kind of ["normalization_light", "organization_adjudication"] as const) {
      globalThis.fetch = async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        const itemSchema = body.text.format.schema.properties.items.items;
        assert.deepEqual(itemSchema.required, ["itemKey", "verdict", "targetId", "evidenceRefs", "reason"]);
        assert.equal("personAssessments" in itemSchema.properties, false);
        const item = { itemKey: "organization_identity:club", verdict: "unresolved", targetId: null,
          evidenceRefs: ["source:club"], reason: "组织名无独立对应依据" };
        return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ items: [item] }) }] }] }));
      };
      const result = await createResearcher({ apiKey: "test", model: "mock", maxRequests: 1, timeoutMs: 1000 })({
        ...request, kind, context: { items: [{ itemKey: "organization_identity:club", allowedIds: ["org"], evidence: [{ key: "source:club" }] }] },
      }, emptyMetrics());
      assert.equal(result.batchAnswer?.items[0].verdict, "unresolved", kind);
    }
    assert.equal(calls, 2);

    globalThis.fetch = async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      const itemSchema = body.text.format.schema.properties.items.items;
      assert.equal(itemSchema.required.includes("personAssessments"), true);
      assert.equal("personAssessments" in itemSchema.properties, true);
      return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ items: [{
        itemKey: "person_identity:runner", verdict: "unresolved", targetId: null, evidenceRefs: ["source:runner"], reason: "身份待核",
        personAssessments: [{ candidateId: "p", nameRelation: "unclear", samePersonPlausibility: "low", reason: "没有可比资料" }],
      }] }) }] }] }));
    };
    const personResult = await createResearcher({ apiKey: "test", model: "mock", maxRequests: 1, timeoutMs: 1000 })({
      ...request, kind: "normalization_light", context: { items: [{ itemKey: "person_identity:runner", allowedIds: ["p"], evidence: [{ key: "source:runner" }] }] },
    }, emptyMetrics());
    assert.equal(personResult.batchAnswer?.items[0].personAssessments?.length, 1);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});
test("research validates citations and structured output and stops at request budget", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.max_output_tokens, undefined);
    assert.equal(body.max_tool_calls, undefined);
    const schema = body.text.format.schema;
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.evidence.items.properties.url.type, "string");
    assert.equal(schema.properties.evidence.items.properties.url.format, undefined);
    assert.equal(schema.properties.reason.minLength, undefined);
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
        inputCostPerMillionUsd: 1,
        outputCostPerMillionUsd: 2,
      });
    const result = await research(request, metrics);
    assert.equal(result.answer?.targetId, "p");
    assert.equal(metrics.llmCalls, 1);
    assert.equal(metrics.networkCalls, 1);
    assert.equal(metrics.inputTokens, 100);
    assert.equal(metrics.outputTokens, 30);
    assert.deepEqual(metrics.llmModels, ["configured-model"]);
    assert.equal(metrics.estimatedCostUsd, 0.00016);
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
    const metrics = emptyMetrics();
    assert.equal((await research(request, metrics)).stopReason, "research_unusable_response");
    assert.deepEqual(metrics.researchCalls?.[0]?.diagnostic, {
      phase: "response_decode",
      code: "invalid_json",
      errorName: "SyntaxError",
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("research records provider request and response identifiers without raw output", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "resp_safe_123",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }],
  }), { status: 200, headers: { "x-request-id": "req-safe-123", "content-type": "application/json" } });
  try {
    const metrics = emptyMetrics();
    const result = await createResearcher({ apiKey: "test", model: "configured-model", timeoutMs: 1000, maxRequests: 1 })(request, metrics);
    assert.equal(result.stopReason, "research_has_no_verified_source_reference");
    assert.equal(metrics.researchCalls?.[0]?.providerRequestId, "req-safe-123");
    assert.equal(metrics.researchCalls?.[0]?.responseId, "resp_safe_123");
    assert.equal(metrics.researchCalls?.[0]?.responseStatus, "completed");
    assert.equal(metrics.researchCalls?.[0]?.outputTextLength, JSON.stringify(answer).length);
    assert.equal(JSON.stringify(metrics).includes("学校所属"), false);
  } finally { globalThis.fetch = original; }
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

test("pro Responses stream retains citations and usage across arbitrary chunks", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, true);
    assert.equal(body.input[0].content[0].type, "input_text");
    assert.equal(JSON.parse(body.input[0].content[0].text).subjectRef, request.subjectRef);
    const event = { type: "response.completed", response: { status: "completed",
      output: [
        { type: "web_search_call", action: { sources: [{ url: "https://example.org/official" }] } },
        { type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] },
      ], usage: { input_tokens: 120, output_tokens: 45 } } };
    const bytes = new TextEncoder().encode(`event: response.completed\r\ndata: ${JSON.stringify(event)}\r\n\r\ndata: [DONE]\r\n\r\n`);
    return new Response(new ReadableStream({ start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
      controller.close();
    } }), { headers: { "content-type": "text/event-stream" } });
  };
  try {
    const metrics = emptyMetrics();
    const result = await createResearcher({ apiKey: "test", model: "gpt-6.1-sol", timeoutMs: 1000, maxRequests: 1 })(request, metrics);
    assert.equal(result.answer?.targetId, "p");
    assert.equal(metrics.inputTokens, 120);
    assert.equal(metrics.outputTokens, 45);
    assert.equal(metrics.networkCalls, 1);
    assert.equal(result.evidence.length, 1);
  } finally { globalThis.fetch = original; }
});

test("partial and failed Responses streams cannot authorize an identity change", async () => {
  const original = globalThis.fetch;
  try {
    for (const type of ["response.output_text.delta", "response.failed", "response.incomplete"]) {
      globalThis.fetch = async () => new Response(
        `data: ${JSON.stringify({ type, delta: JSON.stringify(answer) })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
      const result = await createResearcher({ apiKey: "test", model: "gpt-6.1-sol", timeoutMs: 1000, maxRequests: 1 })(request, emptyMetrics());
      assert.equal(result.stopReason, "research_unusable_response");
      assert.equal(result.answer, undefined);
    }
  } finally { globalThis.fetch = original; }
});

test("provider-compatible schema still enforces local URL, date and reason validation", async () => {
  const original = globalThis.fetch;
  try {
    for (const invalid of [
      { ...answer, reason: "" },
      { ...answer, evidence: [{ url: "invalid-url", quote: "bad" }] },
      { ...answer, corrections: [{ membershipId: "m", startDate: "2026-99-99", endDate: null }] },
    ]) {
      globalThis.fetch = async () => new Response(JSON.stringify({
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(invalid) }] }],
      }));
      const result = await createResearcher({ apiKey: "test", model: "gpt-6.1-sol", timeoutMs: 1000, maxRequests: 1 })(request, emptyMetrics());
      assert.equal(result.answer, undefined);
      assert.equal(result.stopReason, "research_unusable_response");
    }
  } finally { globalThis.fetch = original; }
});

test("whole-group schemas disable tools and have a fixed five-call allowance separate from deep research", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++; const body = JSON.parse(String(init?.body));
    const req = JSON.parse(body.input[0].content[0].text);
    const cross = req.kind === "normalization_cross_check";
    if (req.allowNetwork === false) {
      assert.equal(body.tools, undefined);
      assert.ok(body.text.format.schema.properties[cross ? "issues" : "items"]);
    }
    return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(req.allowNetwork === false ? cross ? { issues: [] } : { items: [] } : { ...answer, verdict: "unresolved", evidence: [] }) }] }], usage: { input_tokens: 20, output_tokens: 5 } }));
  };
  try {
    const metrics = emptyMetrics();
    const research = createResearcher({ apiKey: "test", model: "configured", maxRequests: 1, timeoutMs: 1000 });
    for (const kind of ["normalization_light", "normalization_light", "normalization_cross_check", "organization_adjudication", "normalization_light"] as const) {
      const out = await research({ ...request, kind, allowNetwork: false, context: { items: [], padding: "x".repeat(25000) } }, metrics);
      assert.ok(out.batchAnswer || out.crossAnswer);
    }
    assert.equal((await research({ ...request, kind: "normalization_light", allowNetwork: false }, metrics)).stopReason, "research_budget_exhausted");
    assert.ok((await research(request, metrics)).answer);
    assert.equal((await research(request, metrics)).stopReason, "research_budget_exhausted");
    assert.equal(calls, 6);
    assert.equal(metrics.costKnown, false);
  } finally { globalThis.fetch = original; }
});

test("organization network match requires a search call, tool citation and nonempty quote", async () => {
  const original = globalThis.fetch;
  try {
    for (const variant of ["no-search", "empty-quote", "valid", "incomplete"] as const) {
      globalThis.fetch = async () => new Response(JSON.stringify({ status: variant === "incomplete" ? "incomplete" : "completed",
        output: [...variant === "no-search" ? [] : [{ type: "web_search_call", action: { sources: [{ url: "https://example.org/official" }] } }],
          { type: "message", content: [{ type: "output_text", text: JSON.stringify({ ...answer, evidence: [{ url: "https://example.org/official", quote: variant === "empty-quote" ? " " : "学校所属" }] }), annotations: [{ url: "https://example.org/official" }] }] }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
      const metrics = emptyMetrics();
      const result = await createResearcher({ apiKey: "mock", model: "mock", maxRequests: 1, timeoutMs: 1000 })({ ...request, kind: "organization_identity", allowNetwork: true }, metrics);
      if (variant === "valid") assert.equal(result.answer?.targetId, "p");
      else assert.equal(result.stopReason, variant === "incomplete" ? "research_response_incomplete" : "research_has_no_verified_source_reference");
      assert.equal(metrics.costKnown, false);
      assert.equal(metrics.inputTokens, variant === "valid" ? 10 : 30);
    }
  } finally { globalThis.fetch = original; }
});

test("light batch retries fabricated and foreign-item evidence, then accepts the complete valid batch", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const metrics = emptyMetrics();
  const reservations: boolean[] = [];
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.text.format.schema.properties.items.items.properties.itemKey.enum, ["person_identity:2021", "person_identity:2103"]);
    const result = { items: [
      { itemKey: "person_identity:2021", verdict: "unresolved", targetId: null,
        personAssessments: [{ candidateId: "p", nameRelation: "possible_transcription", samePersonPlausibility: "medium", reason: "同音异字待调查" }],
        evidenceRefs: [calls === 1 ? "result:fabricated" : calls === 2 ? "result:other" : "result:real"], reason: "姓名存在差异" },
      { itemKey: "person_identity:2103", verdict: "match", targetId: "p2", evidenceRefs: ["result:other"], reason: "独立记录相符",
        personAssessments: [{ candidateId: "p2", nameRelation: "exact", samePersonPlausibility: "high", reason: "独立历史证据一致" }] },
    ] };
    if (calls > 1) assert.match(body.input[0].content[0].text, /上次响应未通过/);
    return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(result) }] }], usage: { input_tokens: 100, output_tokens: 20 } }));
  };
  try {
    const research = createResearcher({ apiKey: "test", model: "mock", maxRequests: 1, timeoutMs: 1000,
      reserve: async (_kind, retry) => { reservations.push(!!retry); return true; } });
    const result = await research({ ...request, kind: "normalization_light", allowNetwork: false, context: { items: [
      { itemKey: "person_identity:2021", allowedIds: ["p"], evidence: [{ key: "result:real" }] },
      { itemKey: "person_identity:2103", allowedIds: ["p2"], evidence: [{ key: "result:other" }] },
    ] } }, metrics);
    assert.equal(result.batchAnswer?.items.length, 2);
    assert.equal(calls, 3);
    assert.equal(metrics.inputTokens, 300);
    assert.equal(metrics.outputTokens, 60);
    assert.deepEqual(reservations, [false, true, true]);
    assert.deepEqual(metrics.researchCalls?.map(c => c.attemptNo), [1, 2, 3]);
    assert.equal(metrics.researchCalls?.[1].diagnostic?.issues?.[0].path.join("."), "items.0.evidenceRefs");
  } finally { globalThis.fetch = original; }
});

test("person triage rejects missing, duplicate, foreign and contradictory candidate assessments", async () => {
  const original = globalThis.fetch;
  try {
    for (const scenario of ["missing", "duplicate", "foreign", "contradictory"] as const) {
      let calls = 0;
      const assessment = { candidateId: "p", nameRelation: "possible_transcription", samePersonPlausibility: "medium", reason: "姓名仅差一字" };
      globalThis.fetch = async () => {
        calls++;
        const item = { itemKey: "person_identity:r", verdict: scenario === "contradictory" ? "distinct" : "unresolved",
          targetId: null, evidenceRefs: ["source:r"], reason: "候选比较",
          ...(scenario === "missing" ? {} : { personAssessments: scenario === "duplicate" ? [assessment, assessment]
            : [{ ...assessment, candidateId: scenario === "foreign" ? "outside" : "p" }] }) };
        return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ items: [item] }) }] }] }));
      };
      const outcome = await createResearcher({ apiKey: "test", model: "mock", maxRequests: 1, timeoutMs: 1000 })({
        ...request, kind: "normalization_light", context: { items: [{ itemKey: "person_identity:r", allowedIds: ["p"], evidence: [{ key: "source:r" }] }] },
      }, emptyMetrics());
      assert.equal(outcome.stopReason, "research_unusable_response", scenario);
      assert.equal(outcome.retryExhausted, true);
      assert.equal(calls, 3);
    }
  } finally { globalThis.fetch = original; }
});
test("all LLM request kinds retry transient failures within the same finite boundary", async () => {
  const original = globalThis.fetch;
  try {
    for (const kind of ["normalization_light", "normalization_cross_check", "organization_adjudication", "person_identity", "organization_identity", "membership_conflict"] as const) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        if (calls === 1) throw new DOMException("timeout", "TimeoutError");
        if (calls === 2) return new Response("temporary", { status: 503 });
        const value = kind === "normalization_cross_check" ? { issues: [] }
          : ["normalization_light", "organization_adjudication"].includes(kind) ? { items: [] }
          : { ...answer, verdict: "unresolved", targetId: null, evidence: [] };
        return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }] }));
      };
      const metrics = emptyMetrics();
      const result = await createResearcher({ apiKey: "test", model: "mock", maxRequests: 1, timeoutMs: 1000 })({ ...request, kind, context: { items: [] } }, metrics);
      assert.equal(result.stopReason, undefined, kind);
      assert.equal(calls, 3, kind);
      assert.equal(metrics.llmCalls, 3);
      assert.match(metrics.researchCalls![1].retryReason!, /request_timeout/);
    }
  } finally { globalThis.fetch = original; }
});

test("permanent API failures and valid unresolved do not retry; transient exhaustion is explicit", async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [400, 401, 403, 429, 500]) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return new Response("error", { status }); };
      const metrics = emptyMetrics();
      const result = await createResearcher({ apiKey: "test", model: "mock", maxRequests: 1, timeoutMs: 1000 })(request, metrics);
      assert.equal(calls, status < 429 ? 1 : 3);
      assert.equal(result.retryExhausted === true, status >= 429);
      assert.equal(metrics.researchCalls?.at(-1)?.retryExhausted === true, status >= 429);
    }
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ ...answer, verdict: "unresolved", targetId: null, evidence: [] }) }] }] })); };
    const result = await createResearcher({ apiKey: "test", model: "mock", maxRequests: 1, timeoutMs: 1000 })(request, emptyMetrics());
    assert.equal(calls, 1);
    assert.equal(result.answer?.verdict, "unresolved");
  } finally { globalThis.fetch = original; }
});

test("HTTP diagnostics capture One API errors, correlation, request envelope and safe headers without prompt/auth dumps", async () => {
  const original = globalThis.fetch, originalLog = console.info;
  const logs: string[] = [];
  console.info = value => logs.push(String(value));
  let sentId = '';
  globalThis.fetch = async (_url, init) => {
    sentId = new Headers(init?.headers).get('x-client-request-id')!;
    assert.match(sentId, /^[a-f0-9-]{36}$/);
    return new Response(JSON.stringify({ error: { code: 'invalid_json_schema', type: 'invalid_request_error', param: 'text.format.schema',
      message: 'Schema unsupported; api_key=very-private-key Bearer abc123 https://user:pass@relay.test/v1?token=secret' },
      request_id: 'relay-body-id', input: 'PRIVATE_PROMPT', arbitrary: 'PRIVATE_DUMP' }),
      { status: 400, headers: { 'content-type': 'application/json', 'x-oneapi-request-id': 'relay-header-id', 'retry-after': '15', 'set-cookie': 'PRIVATE_COOKIE', authorization: 'PRIVATE_AUTH' } });
  };
  try {
    const metrics = emptyMetrics();
    const result = await createResearcher({ apiKey: 'very-private-key', baseUrl: 'https://relay.test/v1', model: 'mock', timeoutMs: 1234, maxRequests: 1 })(request, metrics);
    assert.equal(result.stopReason, 'research_http_400');
    assert.equal(metrics.llmCalls, 1);
    const call = metrics.researchCalls![0];
    assert.equal(call.clientRequestId, sentId);
    assert.equal(call.providerRequestId, 'relay-header-id');
    assert.equal(call.endpoint, 'https://relay.test/v1/responses');
    assert.equal(call.httpStatus, 400);
    assert.equal(call.timeoutMs, 1234);
    assert.ok(call.requestBytes! > 1000);
    assert.ok(call.headersReceivedMs! >= 0);
    assert.ok(call.startedAt);
    assert.equal(call.usageReported, false);
    assert.equal(call.responseHeaders?.['retry-after'], '15');
    assert.equal(call.diagnostic?.upstream?.code, 'invalid_json_schema');
    assert.equal(call.diagnostic?.upstream?.param, 'text.format.schema');
    assert.equal(call.diagnostic?.upstream?.requestId, 'relay-body-id');
    const persisted = JSON.stringify(metrics) + logs.join('');
    for (const secret of ['very-private-key', 'abc123', 'user:pass', '?token=', 'PRIVATE_PROMPT', 'PRIVATE_COOKIE', 'PRIVATE_AUTH', 'PRIVATE_DUMP']) assert.equal(persisted.includes(secret), false, secret);
    assert.equal(JSON.parse(logs[0]).event, 'governance_research_request');
    assert.equal(JSON.parse(logs[1]).event, 'governance_research_call');
  } finally { globalThis.fetch = original; console.info = originalLog; }
});

test("HTTP error body collection handles relay variants, HTML, empty, truncation and broken reads", async () => {
  const { httpErrorDiagnostic } = await import('../api-diagnostics.js');
  for (const envelope of [{ message: 'relay error' }, { error: { message: '' }, message: 'relay error' }, { msg: 'relay error' }, { err: 'relay error' }, { error_msg: 'relay error' }, { header: { message: 'relay error' } }, { response: { error: { message: 'relay error' } } }, { error: 'relay error' }]) {
    const d = await httpErrorDiagnostic(new Response(JSON.stringify(envelope), { status: 400 }), []);
    assert.equal(d.upstream?.message, 'relay error');
    assert.equal(d.bodyFormat, 'json');
  }
  const html = await httpErrorDiagnostic(new Response('<html><head><title>502 Bad Gateway</title></head><body>PRIVATE_BODY</body></html>', { status: 502 }), []);
  assert.equal(html.upstream?.message, '502 Bad Gateway');
  assert.equal(html.bodyFormat, 'html');
  const empty = await httpErrorDiagnostic(new Response(null, { status: 401 }), []);
  assert.equal(empty.bodyFormat, 'empty');
  const text = await httpErrorDiagnostic(new Response('upstream token expired; sk-secret123', { status: 403 }), []);
  assert.equal(text.upstream?.message, 'upstream token expired; [REDACTED]');
  let cancelled = false;
  const large = await httpErrorDiagnostic(new Response(new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode('x'.repeat(65536))); }, cancel() { cancelled = true; } }), { status: 413 }), []);
  assert.equal(large.bodyBytesRead, 32768);
  assert.equal(large.bodyTruncated, true);
  assert.equal(large.upstream?.message?.length, 1500);
  assert.equal(cancelled, true);
  const broken = await httpErrorDiagnostic(new Response(new ReadableStream({ start(c) { c.error(new DOMException('PRIVATE', 'TimeoutError')); } }), { status: 429 }), []);
  assert.equal(broken.code, 'http_429');
  assert.equal(broken.bodyReadError, 'TimeoutError');
});

test("failed and incomplete SSE preserve error metadata, early response IDs and usage exactly once per attempt", async () => {
  const original = globalThis.fetch;
  try {
    for (const type of ['response.failed', 'response.incomplete', 'error']) {
      globalThis.fetch = async () => new Response([
        'data: ' + JSON.stringify({ type: 'response.created', response: { id: 'resp_failure_123', status: 'in_progress' } }),
        'data: ' + JSON.stringify({ type, sequence_number: 9,
          ...(type === 'error' ? { error: { code: 'server_error', message: 'upstream unavailable', type: 'upstream_error', param: 'model' } }
            : { response: { id: 'resp_failure_123', status: type === 'response.failed' ? 'failed' : 'incomplete', error: { code: 'server_error', message: 'upstream unavailable' }, incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 10, output_tokens: 2 } } }) }),
        '',
      ].join('\n\n'), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_sse' } });
      const metrics = emptyMetrics();
      const result = await createResearcher({ apiKey: 'test', model: 'mock', timeoutMs: 1000, maxRequests: 1 })(request, metrics);
      assert.equal(result.retryExhausted, true);
      assert.equal(metrics.researchCalls!.length, 3);
      assert.equal(metrics.inputTokens, type === 'error' ? 0 : 30);
      assert.equal(metrics.outputTokens, type === 'error' ? 0 : 6);
      assert.equal(metrics.costKnown, false);
      for (const call of metrics.researchCalls!) {
        assert.equal(call.responseId, 'resp_failure_123');
        assert.equal(call.httpStatus, 200);
        assert.equal(call.diagnostic?.upstream?.code, 'server_error');
        assert.equal(call.diagnostic?.upstream?.message, 'upstream unavailable');
        assert.equal(call.diagnostic?.eventType, type);
        assert.equal(call.diagnostic?.sequenceNumber, 9);
        assert.equal(call.usageReported, type !== 'error');
      }
      assert.equal(new Set(metrics.researchCalls!.map(c => c.clientRequestId)).size, 3);
    }
  } finally { globalThis.fetch = original; }
});

test("HTTP 200 JSON failures and truncated SSE retain actionable diagnostics", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ id: 'resp_json_failure', status: 'failed', error: { code: 'model_not_found', message: 'No model available' } }));
    const metrics = emptyMetrics();
    assert.equal((await createResearcher({ apiKey: 'test', model: 'mock', timeoutMs: 1000, maxRequests: 1 })(request, metrics)).stopReason, 'research_response_failed');
    assert.equal(metrics.researchCalls![0].diagnostic?.upstream?.code, 'model_not_found');
    globalThis.fetch = async () => new Response('data: {"type":"response.created","response":{"id":"resp_truncated","status":"in_progress"}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    const truncated = emptyMetrics();
    await createResearcher({ apiKey: 'test', model: 'mock', timeoutMs: 1000, maxRequests: 1 })(request, truncated);
    assert.equal(truncated.researchCalls![0].responseId, 'resp_truncated');
    assert.equal(truncated.researchCalls![0].diagnostic?.code, 'stream_missing_completion');
  } finally { globalThis.fetch = original; }
});
