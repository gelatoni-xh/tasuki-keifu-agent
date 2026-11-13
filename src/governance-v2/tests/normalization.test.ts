import assert from "node:assert/strict";
import test from "node:test";
import { MemorySaver } from "@langchain/langgraph";
import { buildBatchGraph } from "../graph.js";
import { manifestSchema, CONTRACT_VERSION, type Context } from "../contracts.js";
import type { Researcher, ResearchRequest } from "../research.js";

function input() {
  return manifestSchema.parse({ version: CONTRACT_VERSION, requestKey: "new-run", eventEditionId: "e", mode: "dry_run", batches: [{
    unitType: "group", unitKey: "1", sequence: 0, sourceId: "s", raceSlug: "ordinary-333-heat-1",
    organizations: [{ key: "o", name: "試験高校", type: "high_school" }],
    rows: ["a", "b"].map(key => ({ key, name: `選手${key}`, organizationKey: "o", notes: "DNS" })),
  }] }).batches[0];
}
function context(): Context {
  return { raceId: "r", editionId: "e", raceDate: "2026-11-01", source: { id: "s", reliability: 4 }, sources: [],
    organizations: [{ id: "o1", slug: "school", nameJa: "試験高校", type: "high_school" }],
    people: ["a", "b"].map(k => ({ id: `p${k}`, slug: k, displayNameJa: `選手${k}` })), memberships: [], pbs: [], sourceMappings: [],
    historicalResults: ["a", "b"].map(k => ({ id: `h${k}`, personId: `p${k}`, organizationId: "o1", organizationName: "試験高校", raceId: "old", raceSlug: "ordinary-332-heat-1", raceName: "普通", notes: "DNS", isStarter: false })),
  };
}
function items(r: ResearchRequest) { return (r.context as { items: Array<{ itemKey: string; allowedIds: string[]; evidence: Array<{ key: string }> }> }).items; }
const match: Researcher = async r => r.kind === "normalization_cross_check" ? { crossAnswer: { issues: [] }, evidence: [] } : {
  batchAnswer: { items: items(r).map(i => ({ itemKey: i.itemKey, verdict: "match", targetId: i.allowedIds[0], evidenceRefs: i.evidence.map(e => e.key), reason: "来源与历史资料一致" })) }, evidence: [],
};
test("whole unresolved group uses one person call; source plans are replaced; DNS creates no membership", async () => {
  const calls: ResearchRequest[] = [];
  const graph = buildBatchGraph({ loadContext: async () => context(), research: async (r,m) => { calls.push(r); m.llmCalls++; return match(r,m); } });
  const result = await graph.invoke({ batchId: "b", input: input(), mode: "dry_run" });
  assert.deepEqual(calls.map(r => r.kind), ["normalization_light", "normalization_cross_check"]);
  assert.equal(items(calls[0]).length, 2);
  assert.ok(JSON.stringify(calls[0]).includes('"isStarter":false'));
  assert.deepEqual(result.resolution.personMap, { a: "pa", b: "pb" });
  assert.equal(result.plan.changes.filter(c => c.operation.kind === "create_person").length, 0);
  assert.equal(result.plan.changes.filter(c => c.operation.kind === "membership").length, 0);
  assert.ok(result.plan.changes.filter(c => c.operation.kind === "source_mapping").every(c => c.operation.kind === "source_mapping" && !c.operation.targetId.startsWith("person-")));
  assert.equal(result.resolution.metrics.llmCalls, 2);
});
test("missing, duplicate, foreign target and fabricated evidence cannot authorize plans", async () => {
  for (const mutation of ["missing", "duplicate", "foreign", "evidence"] as const) {
    const research: Researcher = async (r,m) => {
      const out = await match(r,m); if (!out.batchAnswer) return out;
      if (mutation === "missing") out.batchAnswer.items.pop();
      if (mutation === "duplicate") out.batchAnswer.items[1] = out.batchAnswer.items[0];
      if (mutation === "foreign") out.batchAnswer.items[0].targetId = "other";
      if (mutation === "evidence") out.batchAnswer.items[0].evidenceRefs = ["invented"];
      return out;
    };
    await assert.rejects(buildBatchGraph({ loadContext: async () => context(), research }).invoke({ batchId: "b", input: input(), mode: "dry_run" }), /normalization batch/i);
  }
});
test("unresolved batch items ignore stray target ids without losing the original response", async () => {
  const original = { itemKey: "organization_identity:o", verdict: "unresolved" as const, targetId: "o1", evidenceRefs: ["source:o"], reason: "证据不足" };
  const research: Researcher = async r => r.kind === "normalization_cross_check"
    ? { crossAnswer: { issues: [] }, evidence: [] }
    : { batchAnswer: { items: items(r).map(i => ({ ...original, itemKey: i.itemKey, evidenceRefs: i.evidence.map(e => e.key) })) }, evidence: [] };
  const result = await buildBatchGraph({ loadContext: async () => context(), research }).invoke({ batchId: "b", input: input(), mode: "dry_run" });
  assert.ok(Object.values(result.normalization.decisions).every(d => d.answer?.verdict === "unresolved" && d.answer.targetId === null));
  assert.equal(result.resolution.metrics.normalizationWarnings?.length, 2);
  assert.equal(result.resolution.metrics.normalizationWarnings?.[0]?.code, "ignored_target_for_non_match");
  assert.equal(original.targetId, "o1");
});
test("independent org adjudication triggers one affected-only reassessment and no graph loop", async () => {
  const data = input(), ctx = context();
  data.organizations.push({ key: "other", name: "別高校", type: "high_school" });
  data.rows[1].organizationKey = "other";
  ctx.organizations.push({ id: "o2", slug: "school2", nameJa: "試験第1高校", type: "high_school" }, { id: "o3", slug: "other", nameJa: "別試高校", type: "high_school" });
  const calls: ResearchRequest[] = [];
  const research: Researcher = async (r,m) => {
    calls.push(r);
    if (r.kind === "normalization_cross_check") return { crossAnswer: { issues: [{ issueKey: "org-variant", issueType: "organization_variant", organizationKey: "o", personKeys: ["a"], evidenceRefs: ["source:o"], reason: "独立组织名称变体", suggestedAction: "review_organization" }] }, evidence: [] };
    if (r.kind === "organization_adjudication") {
      assert.ok(!JSON.stringify(r.context).includes("personMap"));
      const i = items(r)[0];
      return { batchAnswer: { items: [{ itemKey: i.itemKey, verdict: "match", targetId: "o2", evidenceRefs: ["source:o"], reason: "组织独立证据" }] }, evidence: [] };
    }
    return match(r,m);
  };
  const result = await buildBatchGraph({ loadContext: async () => ctx, research }).invoke({ batchId: "b", input: data, mode: "dry_run" });
  assert.deepEqual(result.normalization.affectedPersonKeys, ["a"]);
  const reassess = calls.filter(r => r.subjectRef === "affected_person_reassessment");
  assert.equal(reassess.length, 1);
  assert.deepEqual(items(reassess[0]).map(i => i.itemKey), ["person_identity:a"]);
  assert.equal(result.resolution.organizationMap.o, "o2");
  assert.equal(calls.filter(r => r.kind === "normalization_cross_check").length, 1);
  assert.equal(result.plan.changes.filter(c => c.operation.kind === "create_person").length, 0);
});
test("checkpoint restart reuses completed lightweight stage", async () => {
  const saver = new MemorySaver(); let calls = 0;
  const research: Researcher = async (r,m) => { calls++; return match(r,m); };
  const config = { configurable: { thread_id: "fresh-first-group" } };
  const graph = buildBatchGraph({ loadContext: async () => context(), research, checkpointer: saver });
  await graph.invoke({ batchId: "b", input: input(), mode: "dry_run" }, { ...config, interruptAfter: ["person_light_batch"] });
  assert.equal(calls, 1);
  const resumed = buildBatchGraph({ loadContext: async () => context(), research, checkpointer: saver });
  const result = await resumed.invoke(null, config);
  assert.equal(calls, 2);
  assert.deepEqual(result.resolution.personMap, { a: "pa", b: "pb" });
});
test("timeout is technical failure; insufficient evidence remains unresolved", async () => {
  await assert.rejects(buildBatchGraph({ loadContext: async () => context(), research: async () => ({ stopReason: "research_timeout", evidence: [] }) }).invoke({ batchId: "b", input: input(), mode: "dry_run" }), /model failure: research_timeout/);
  const research: Researcher = async r => r.kind === "normalization_cross_check" ? { crossAnswer: { issues: [] }, evidence: [] } : { batchAnswer: { items: items(r).map(i => ({ itemKey: i.itemKey, verdict: "unresolved", targetId: null, evidenceRefs: [], reason: "同名不足确认" })) }, evidence: [] };
  const result = await buildBatchGraph({ loadContext: async () => context(), research }).invoke({ batchId: "b", input: input(), mode: "dry_run" });
  assert.equal(result.plan.findings.filter(f => f.status === "unresolved").length, 2);
});

test("all unresolved organizations share one request; unchanged adjudication skips reassessment", async () => {
  const data = input(), ctx = context();
  data.organizations[0].name = "試験第1高校";
  data.organizations.push({ key: "x", name: "別試第1高校", type: "high_school" });
  ctx.organizations.push({ id: "x1", slug: "x", nameJa: "別試高校", type: "high_school" });
  const calls: ResearchRequest[] = [];
  const research: Researcher = async (r,m) => {
    calls.push(r);
    if (r.kind === "normalization_cross_check") return { crossAnswer: { issues: [{ issueKey: "check", issueType: "organization_variant", organizationKey: "o", personKeys: ["a"], evidenceRefs: ["source:o"], reason: "复核组织", suggestedAction: "review_organization" }] }, evidence: [] };
    return match(r,m);
  };
  const result = await buildBatchGraph({ loadContext: async () => ctx, research }).invoke({ batchId: "b", input: data, mode: "dry_run" });
  const orgCalls = calls.filter(r => r.kind === "normalization_light" && r.subjectRef === "organization");
  assert.equal(orgCalls.length, 1);
  assert.equal(items(orgCalls[0]).length, 2);
  assert.deepEqual(result.normalization.affectedPersonKeys, []);
  assert.equal(calls.filter(r => r.subjectRef === "affected_person_reassessment").length, 0);
});

test("evidence from another candidate cannot confirm identity", async () => {
  const ctx = context();
  ctx.people.push({ id: "wrong", slug: "wrong", displayNameJa: "選手a" });
  ctx.historicalResults!.push({ ...ctx.historicalResults![0], id: "wrong-history", personId: "wrong" });
  const research: Researcher = async (r,m) => {
    const out = await match(r,m);
    if (out.batchAnswer) out.batchAnswer.items[0].evidenceRefs = ["result:wrong-history"];
    return out;
  };
  await assert.rejects(buildBatchGraph({ loadContext: async () => ctx, research }).invoke({ batchId: "b", input: input(), mode: "dry_run" }), /independent identity evidence/);
});

test("explicit birthday conflict cannot be overridden with historical evidence", async () => {
  const ctx = context(), data = input();
  data.rows[0].sourceKey = "known-a"; data.rows[0].birthDate = "2004-01-01";
  ctx.people[0].birthDate = "2003-01-01";
  ctx.sourceMappings.push({ sourceId: "s", entityType: "person", sourceKey: "known-a", personId: "pa" });
  await assert.rejects(buildBatchGraph({ loadContext: async () => ctx, research: match }).invoke({ batchId: "b", input: data, mode: "dry_run" }), /contradicts explicit birth date/);
});

test("cross-check can invalidate a rule match without looping or inventing membership", async () => {
  const ctx = context();
  ctx.memberships.push({ id: "ma", personId: "pa", organizationId: "o1", type: "enrolled", organizationType: "high_school", startBasis: "unknown", endBasis: "unknown", endState: "unknown", evidence: {} });
  const research: Researcher = async (r,m) => {
    if (r.kind === "normalization_cross_check") return { crossAnswer: { issues: [{ issueKey: "circular", issueType: "circular_evidence", organizationKey: "o", personKeys: ["a"], evidenceRefs: ["source:o", "membership:ma"], reason: "所属判断依赖待确认组织", suggestedAction: "unresolved" }] }, evidence: [] };
    return match(r,m);
  };
  const result = await buildBatchGraph({ loadContext: async () => ctx, research }).invoke({ batchId: "b", input: input(), mode: "dry_run" });
  assert.notEqual(result.resolution.personMap.a, "pa");
  assert.ok(result.plan.findings.some(f => f.subjectRef === "a" && f.status === "unresolved"));
});

test("cross-check deduplicates large unrelated catalogs while retaining full group and conflicting evidence", async () => {
  const { buildCrossCheckInput } = await import("../cross-check-input.js");
  const { initialNormalization, validateCrossCheck } = await import("../normalization.js");
  const { emptyMetrics } = await import("../contracts.js");
  const data = input(), ctx = context(), state = initialNormalization();
  data.rows = Array.from({ length: 44 }, (_, i) => ({ ...data.rows[i % 2], key: `row-${i}` }));
  data.organizations.push({ key: "other", name: "別高校", type: "high_school" });
  ctx.organizations.push(...Array.from({ length: 3000 }, (_, i) => ({ id: `unrelated-${i}`, slug: `unrelated-${i}`, nameJa: `無関係組織${i}`, type: "high_school" as const })));
  ctx.people.push({ id: "conflict", slug: "conflict", displayNameJa: "選手a", birthDate: "2000-01-01" });
  data.rows[0].birthDate = "2001-01-01";
  ctx.memberships.push({ id: "ma", personId: "pa", organizationId: "o1", type: "enrolled", organizationType: "high_school", startBasis: "unknown", endBasis: "unknown", endState: "unknown" });
  ctx.memberships.push({ ...ctx.memberships[0], id: "mb", personId: "pb" });
  ctx.historicalResults!.push({ ...ctx.historicalResults![0], id: "ncg", raceSlug: "ncg-333", raceName: "NCG", isStarter: true });
  ctx.historicalReferences = Array.from({ length: 11 }, (_, i) => ({ id: `ref-${i}`, personId: "pa", sourceId: "s", sourceKey: `${i}`, entityType: "person" }));
  state.requests["person_identity:row-0"] = { kind: "person_identity", subjectRef: "row-0", question: "identity", context: {}, allowedIds: ["pa", "conflict"], providedEvidence: [{ sourceId: "s", url: "https://example.com/result" }] };
  const resolution = { organizationMap: { o: "o1" }, personMap: Object.fromEntries(data.rows.map((r, i) => [r.key, i % 2 ? "pb" : "pa"])), findings: [], changes: [], metrics: emptyMetrics() };
  const compact = buildCrossCheckInput(data, ctx, state, resolution);
  const legacy = { rows: data.rows, organizationEvidence: data.organizations.map(o => ({ input: o, candidates: ctx.organizations })) };
  assert.ok(JSON.stringify(legacy).length > 512000);
  assert.ok(JSON.stringify(compact).length < 512000);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(legacy).length / 10);
  assert.equal(compact.rows.length, 44);
  assert.equal(compact.organizations.length, 2);
  assert.ok(compact.rows.every(r => r.notes === "DNS"));
  assert.ok(compact.catalog.people.some(p => p.id === "conflict"));
  assert.equal(compact.catalog.organizations.length, 1);
  assert.equal(compact.catalog.evidence.filter(e => e.key === "membership:ma").length, 1);
  assert.equal(compact.catalog.evidence.filter(e => e.key === "membership:mb").length, 1); // Rule-selected, no research request.
  assert.ok(JSON.stringify(compact).includes('"isStarter":false'));
  assert.ok(JSON.stringify(compact).includes('"raceSlug":"ncg-333"'));
  assert.ok(JSON.stringify(compact).includes("https://example.com/result"));
  assert.deepEqual(compact.overview.historyMayBeTruncatedFor, ["pa"]);
  state.crossCheckEvidenceRefs = compact.catalog.evidence.map(e => e.key);
  state.issues = [{ issueKey: "foreign", issueType: "circular_evidence", organizationKey: "o", personKeys: ["row-0"], evidenceRefs: ["membership:not-supplied"], reason: "unsupported", suggestedAction: "unresolved" }];
  assert.throws(() => validateCrossCheck(data, state, ctx), /unsupported/);
});
