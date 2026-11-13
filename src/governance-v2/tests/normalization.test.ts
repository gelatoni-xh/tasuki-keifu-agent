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
    rows: ["a", "b"].map(key => ({ key, name: `選手${key}`, organizationKey: "o", notes: "" })),
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
const match: Researcher = async r => r.kind === "person_identity"
  ? { answer: { verdict: "unresolved", targetId: null, duplicateIds: [], reason: "独立冲突需保留待确认", evidence: [], corrections: [], split: null }, evidence: [] }
  : r.kind === "normalization_cross_check" ? { crossAnswer: { issues: [] }, evidence: [] } : {
  batchAnswer: { items: items(r).map(i => ({ itemKey: i.itemKey, verdict: "match", targetId: i.allowedIds[0], evidenceRefs: i.evidence.map(e => e.key), reason: "来源与历史资料一致" })) }, evidence: [],
};
test("person light triage routes a single plausible transcription to research and excludes weak homophones", async () => {
  for (const scenario of ["near_name", "different_name", "weak_unresolved", "cross_conflict"] as const) {
    const data = input(), ctx = context();
    data.rows = data.rows.slice(0, 1);
    data.rows[0].name = "吉田悠騎"; data.rows[0].kana = "ヨシダユウキ";
    ctx.people = [{ id: "pa", slug: "a", displayNameJa: scenario === "near_name" ? "吉田悠基" : "義多祐樹", displayNameKana: "ヨシダユウキ" }];
    if (scenario === "weak_unresolved") ctx.people.push({ id: "pb", slug: "b", displayNameJa: "芳田勇紀", displayNameKana: "ヨシダユウキ" });
    let deepCalls = 0, crossSawAssessment = false;
    const research: Researcher = async r => {
      if (r.kind === "person_identity") {
        deepCalls++;
        assert.equal(r.allowNetwork, true);
        assert.ok((r.context as { lightAssessment?: unknown }).lightAssessment);
        return { answer: { verdict: "unresolved", targetId: null, duplicateIds: [], reason: "联网后仍不足", evidence: [], corrections: [], split: null }, evidence: [] };
      }
      if (r.kind === "normalization_cross_check") {
        crossSawAssessment = JSON.stringify(r.context).includes("samePersonPlausibility");
        return { crossAnswer: { issues: scenario === "cross_conflict" ? [{ issueKey: "conflict", issueType: "mapping_conflict", organizationKey: "o", personKeys: ["a"], evidenceRefs: ["source:a"], reason: "独立履历冲突", suggestedAction: "research" }] : [] }, evidence: [] };
      }
      assert.match(r.question, /OCR/);
      return { batchAnswer: { items: items(r).map(i => ({ itemKey: i.itemKey,
        verdict: scenario === "different_name" ? "distinct" : "unresolved", targetId: null,
        reason: scenario === "near_name" ? "只差一同音字，可能误录，需核查" : "汉字差异大且无独立关联",
        evidenceRefs: i.evidence.map(e => e.key), personAssessments: i.allowedIds.map(candidateId => ({ candidateId,
          nameRelation: scenario === "near_name" ? "possible_transcription" : "different",
          samePersonPlausibility: scenario === "near_name" ? "medium" : "low", reason: "逐候选分析姓名及来源差异" })) })) }, evidence: [] };
    };
    const result = await buildBatchGraph({ loadContext: async () => ctx, research }).invoke({ batchId: "b", input: data, mode: "dry_run" });
    assert.equal(deepCalls, ["near_name", "cross_conflict"].includes(scenario) ? 1 : 0, scenario);
    assert.equal(crossSawAssessment, true);
    assert.equal(result.normalization.decisions["person_identity:a"].personAssessments?.length, ctx.people.length);
    assert.equal(result.resolution.metrics.personIdentityTriage?.[0].assessments.length, ctx.people.length);
    if (scenario === "different_name") {
      assert.ok(result.plan.changes.some(c => c.operation.kind === "create_person"));
      assert.equal(result.plan.findings.filter(f => f.status === "unresolved").length, 0);
    }
    if (scenario === "weak_unresolved") assert.equal(result.resolution.metrics.personResearchRouting?.[0].reason, "low_identity_plausibility");
  }
});
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

test("another candidate's evidence downgrades only that item and reaches cross-check", async () => {
  const ctx = context();
  ctx.people.push({ id: "wrong", slug: "wrong", displayNameJa: "選手a" });
  ctx.historicalResults!.push({ ...ctx.historicalResults![0], id: "wrong-history", personId: "wrong" });
  let crossChecked = false;
  const research: Researcher = async (r,m) => {
    if (r.kind === "person_identity") return { answer: { verdict: "unresolved", targetId: null, duplicateIds: [], reason: "独立证据不足", evidence: [], corrections: [], split: null }, evidence: [] };
    const out = await match(r,m);
    if (out.batchAnswer) out.batchAnswer.items[0].evidenceRefs = ["result:wrong-history"];
    if (r.kind === "normalization_cross_check") {
      crossChecked = true;
      const payload = r.context as { validationWarnings: Array<{ code: string }> };
      assert.equal(payload.validationWarnings[0].code, "person_match_missing_independent_evidence");
    }
    return out;
  };
  const result = await buildBatchGraph({ loadContext: async () => ctx, research }).invoke({ batchId: "b", input: input(), mode: "dry_run" });
  assert.ok(crossChecked);
  assert.notEqual(result.resolution.personMap.a, "pa");
  assert.equal(result.resolution.personMap.b, "pb");
  assert.equal(result.normalization.decisions["person_identity:a"].answer?.verdict, "unresolved");
});

test("source-only or absent person citations retain valid peers without retrying or heavy research", async () => {
  for (const evidenceRefs of [["source:a"], []]) {
    const calls: string[] = [];
    let raw: unknown;
    const research: Researcher = async (r,m) => {
      calls.push(r.kind);
      const out = await match(r,m);
      if (out.batchAnswer) {
        out.batchAnswer.items[0].evidenceRefs = evidenceRefs;
        raw = structuredClone(out);
      }
      return out;
    };
    const result = await buildBatchGraph({ loadContext: async () => context(), research }).invoke({ batchId: "b", input: input(), mode: "dry_run" });
    assert.deepEqual(calls, ["normalization_light", "normalization_cross_check"]);
    assert.equal(result.resolution.personMap.b, "pb");
    assert.notEqual(result.resolution.personMap.a, "pa");
    const warning = result.resolution.metrics.normalizationWarnings?.[0];
    assert.ok(warning);
    assert.equal(warning.code, "person_match_missing_independent_evidence");
    assert.equal(warning.ignoredTargetId, "pa");
    assert.deepEqual(warning.evidenceRefs, evidenceRefs);
    assert.equal((raw as { batchAnswer: { items: Array<{ verdict: string }> } }).batchAnswer.items[0].verdict, "match");
    assert.ok(result.plan.findings.some(f => f.subjectRef === "a" && f.status === "unresolved"));
  }
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
  assert.ok(compact.rows.every(r => r.notes === ""));
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

function historicalFixture() {
  const data = input(), ctx = context();
  data.rows[0].name = "伊藤 亘輝"; data.rows[0].kana = "ｲﾄｳ ｺｳｷ";
  ctx.people[0].displayNameJa = "伊藤亘輝"; ctx.people[0].displayNameKana = "イトウ コウキ";
  ctx.historicalResults![0].raceDate = "2026-09-26";
  ctx.historicalResults![0].sourceId = "official-old";
  return { data, ctx };
}

test("historical DNS entry with exact name, kana and organization resolves by rule; retains weaker homophones", async () => {
  const { data, ctx } = historicalFixture();
  ctx.people.push({ id: "homophone", slug: "homophone", displayNameJa: "伊藤光輝", displayNameKana: "イトウコウキ" });
  let checked = false;
  const research: Researcher = async (r,m) => {
    if (r.kind === "normalization_light") assert.deepEqual(items(r).map(i => i.itemKey), ["person_identity:b"]);
    if (r.kind === "normalization_cross_check") {
      checked = true;
      const payload = r.context as { rows: Array<{ candidateIds: string[]; identityRule?: { evidenceRefs: string[] } }> };
      assert.ok(payload.rows[0].candidateIds.includes("homophone"));
      assert.ok(payload.rows[0].identityRule?.evidenceRefs.includes("result:ha"));
    }
    return match(r,m);
  };
  const result = await buildBatchGraph({ loadContext: async () => ctx, research }).invoke({ batchId: "b", input: data, mode: "dry_run" });
  assert.ok(checked);
  assert.equal(result.resolution.personMap.a, "pa");
  assert.deepEqual(result.resolution.metrics.normalizationRuleMatches?.[0].weakerCandidateIds, ["homophone"]);
  const refs = result.plan.changes.filter(c => c.operation.kind === "source_mapping" && c.operation.targetId === "pa");
  assert.ok(refs.some(c => c.evidence.some(e => e.sourceKey === "result:ha")));
  assert.equal(result.plan.changes.filter(c => c.operation.kind === "membership").length, 0);
  assert.equal(ctx.historicalResults![0].isStarter, false);
});

test("history rule rejects missing kana, different organization IDs, future/current-race history and untraceable sources", async () => {
  for (const mutation of ["kana", "org", "future", "race", "source", "duplicate", "cohort"] as const) {
    const { data, ctx } = historicalFixture();
    if (mutation === "kana") data.rows[0].kana = undefined;
    if (mutation === "org") ctx.historicalResults![0].organizationId = "similar-label-different-id";
    if (mutation === "future") ctx.historicalResults![0].raceDate = "2027-01-01";
    if (mutation === "race") ctx.historicalResults![0].raceId = ctx.raceId;
    if (mutation === "source") ctx.historicalResults![0].sourceId = undefined;
    if (mutation === "duplicate") ctx.people.push({ ...ctx.people[0], id: "other", slug: "other" });
    if (mutation === "cohort") {
      data.organizations[0].type = "university"; ctx.organizations[0].type = "university";
      ctx.memberships.push({ id: "old", personId: "pa", organizationId: "o1", organizationType: "university", type: "enrolled", startDate: "2010-04-01", endDate: "2014-03-31", startBasis: "source", endBasis: "source", endState: "ended" });
    }
    const calls: ResearchRequest[] = [];
    await buildBatchGraph({ loadContext: async () => ctx, research: async (r,m) => { calls.push(r); return match(r,m); } }).invoke({ batchId: "b", input: data, mode: "dry_run" });
    assert.ok(calls.some(r => r.kind === "normalization_light" && items(r).some(i => i.itemKey === "person_identity:a")), mutation);
  }
});

test("cross-check can reject a historical rule match without repeating lightweight or cross-check nodes", async () => {
  const { data, ctx } = historicalFixture();
  const calls: ResearchRequest[] = [];
  const result = await buildBatchGraph({ loadContext: async () => ctx, research: async (r,m) => {
    calls.push(r);
    if (r.kind === "normalization_cross_check") return { crossAnswer: { issues: [{ issueKey: "conflict", issueType: "mapping_conflict", organizationKey: "o", personKeys: ["a"], evidenceRefs: ["result:ha"], reason: "发现独立身份矛盾", suggestedAction: "unresolved" }] }, evidence: [] };
    return match(r,m);
  } }).invoke({ batchId: "b", input: data, mode: "dry_run" });
  assert.notEqual(result.resolution.personMap.a, "pa");
  assert.deepEqual(result.resolution.metrics.normalizationRuleMatches, []);
  assert.equal(calls.filter(r => r.kind === "normalization_cross_check").length, 1);
  assert.equal(calls.filter(r => r.kind === "normalization_light").length, 1);
});

test("current DNS bypasses identity calls and membership inference; historical DNS still identifies starters", async () => {
  const data = input(), ctx = context(), calls: ResearchRequest[] = [];
  data.rows[0].notes = "DNS";
  data.rows[0].memberships = [{ organizationKey: "o", type: "enrolled", grade: 3, endState: "unknown" }];
  const result = await buildBatchGraph({ loadContext: async () => ctx, research: async (r,m) => { calls.push(r); return match(r,m); } }).invoke({ batchId: "b", input: data, mode: "dry_run" });
  assert.deepEqual(items(calls.find(r => r.subjectRef === "person")!).map(i => i.itemKey), ["person_identity:b"]);
  assert.notEqual(result.resolution.personMap.a, "pa");
  assert.equal(result.resolution.personMap.b, "pb");
  assert.equal(result.plan.changes.filter(c => c.operation.kind === "membership").length, 0);
  assert.equal(calls.filter(r => r.kind === "person_identity").length, 0);
});

test("unresolved organization suspends all dependent matches even without canonical ID correction", async () => {
  const data = input(), ctx = context(), calls: ResearchRequest[] = [];
  const research: Researcher = async (r,m) => {
    calls.push(r);
    if (r.kind === "normalization_cross_check") return { crossAnswer: { issues: [{ issueKey: "org", issueType: "organization_variant", organizationKey: "o", personKeys: ["a"], evidenceRefs: ["source:o"], reason: "组织仍有疑问", suggestedAction: "review_organization" }] }, evidence: [] };
    if (r.kind === "organization_adjudication") return { batchAnswer: { items: items(r).map(i => ({ itemKey: i.itemKey, verdict: "unresolved", targetId: null, evidenceRefs: [], reason: "证据不足" })) }, evidence: [] };
    if (r.kind === "organization_identity") return { answer: { verdict: "unresolved", targetId: null, duplicateIds: [], reason: "官网无证据", evidence: [], corrections: [], split: null }, evidence: [] };
    return match(r,m);
  };
  const result = await buildBatchGraph({ loadContext: async () => ctx, research }).invoke({ batchId: "b", input: data, mode: "dry_run" });
  assert.deepEqual(result.normalization.pendingOrganizationKeys, ["o"]);
  assert.notEqual(result.resolution.organizationMap.o, "o1");
  assert.notEqual(result.resolution.personMap.a, "pa");
  assert.notEqual(result.resolution.personMap.b, "pb");
  assert.equal(calls.filter(r => r.subjectRef === "affected_person_reassessment").length, 0);
  assert.equal(calls.filter(r => r.kind === "person_identity").length, 0);
  assert.equal(result.resolution.metrics.normalizationSummary?.affectedPeople, 2);
});

test("unique weak organization candidate gets single-entity search before one dependent reassessment; checkpoint does not repeat search", async () => {
  const data = input(), ctx = context(), calls: ResearchRequest[] = [], saver = new MemorySaver();
  data.organizations[0].name = "試験第1高校";
  const research: Researcher = async (r,m) => {
    calls.push(r);
    if (r.kind === "normalization_light" && r.subjectRef === "organization") return { batchAnswer: { items: items(r).map(i => ({ itemKey: i.itemKey, verdict: "unresolved", targetId: null, evidenceRefs: [], reason: "唯一弱候选仍不足" })) }, evidence: [] };
    if (r.kind === "organization_identity") {
      assert.equal(r.allowNetwork, true);
      assert.deepEqual(r.allowedIds, ["o1"]);
      assert.ok(!JSON.stringify(r.context).includes("personMap"));
      return { answer: { verdict: "match", targetId: "o1", duplicateIds: [], reason: "官网校名", evidence: [{ url: "https://school.example/about", quote: "試験第1高校" }], corrections: [], split: null }, evidence: [{ url: "https://school.example/about", quote: "試験第1高校" }] };
    }
    return match(r,m);
  };
  const config = { configurable: { thread_id: "organization-search" }, interruptAfter: ["organization_network_research" as const] };
  const graph = buildBatchGraph({ loadContext: async () => ctx, research, checkpointer: saver });
  await graph.invoke({ batchId: "b", input: data, mode: "dry_run" }, config);
  const result = await graph.invoke(null, { configurable: config.configurable });
  assert.equal(calls.filter(r => r.kind === "organization_identity").length, 1);
  assert.equal(calls.filter(r => r.subjectRef === "affected_person_reassessment").length, 1);
  assert.equal(result.resolution.organizationMap.o, "o1");
  assert.deepEqual(result.resolution.personMap, { a: "pa", b: "pb" });
  assert.deepEqual(result.normalization.pendingOrganizationKeys, []);
  assert.equal(result.resolution.metrics.normalizationStages?.find(s => s.stage === "organization_network_research")?.resolvedCount, 1);
});

test("cross-check removes unrelated known evidence and keeps unsupported references blocking", async () => {
  const { initialNormalization, validateCrossCheck } = await import("../normalization.js");
  const data = input(), state = initialNormalization();
  data.organizations.push({ key: "unrelated", name: "別校", type: "high_school" });
  state.issues = [{ issueKey: "wrong", issueType: "organization_variant", organizationKey: "o", personKeys: ["a"], evidenceRefs: ["source:unrelated"], reason: "无关证据", suggestedAction: "review_organization" }];
  const checked = validateCrossCheck(data, state, context());
  assert.deepEqual(checked.issues[0].evidenceRefs, []);
  assert.equal(checked.issues[0].suggestedAction, "unresolved");
  assert.deepEqual(state.issues[0].evidenceRefs, ["source:unrelated"]);
  state.issues[0].evidenceRefs = ["invented"];
  assert.throws(() => validateCrossCheck(data, state, context()), /unsupported/);
});
