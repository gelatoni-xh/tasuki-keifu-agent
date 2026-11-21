import assert from "node:assert/strict";
import test from "node:test";
import { BusinessWriter } from "../writer.js";
import type { GovernanceDB } from "../database.js";
import type { PoolClient } from "pg";
import { MemorySaver } from "@langchain/langgraph";
import { normalizePeople, governMemberships, buildPlan } from "../agents.js";
import { buildBatchGraph } from "../graph.js";
import { manifestSchema, CONTRACT_VERSION, emptyMetrics, type Context } from "../contracts.js";
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
test("ekiden snapshot-only teams retain all individual results without organization-backed team writes", () => {
  const data = input();
  data.organizations = [
    { key: "known", name: "花王", type: "corporate_team" },
    ...(["unknown", "club", "company"] as const).map(type => ({ key: type, name: `仮称${type}`, type })),
  ];
  data.rows = data.organizations.map(o => ({ key: o.key, name: `選手${o.key}`, organizationKey: o.key, mark: "24:00", memberships: [], pbs: [] }));
  data.teams = data.organizations.map(o => ({ organizationKey: o.key, leg: 1, cumulativeMark: "24:00" }));
  const resolution = { organizationMap: { known: "o1" }, personMap: Object.fromEntries(data.rows.map(r => [r.key, `p-${r.key}`])), findings: [], changes: [], metrics: emptyMetrics() };
  const emptyAgent = (agentKey: string) => ({ agentKey, skipped: true, findings: [], changes: [], metrics: emptyMetrics() });
  const plan = buildPlan("batch", data, context(), resolution, emptyAgent("membership"), emptyAgent("person_facts"), "apply");
  assert.equal(plan.changes.filter(c => c.operation.kind === "race_result").length, 4);
  const teams = plan.changes.filter(c => c.operation.kind === "team_result");
  assert.equal(teams.length, 1);
  assert.equal(teams[0].operation.kind === "team_result" && teams[0].operation.organizationId, "o1");
  for (const type of ["unknown", "club", "company"]) {
    const result = plan.changes.find(c => c.operation.kind === "race_result" && c.operation.row.key === type)!.operation;
    assert.ok(result.kind === "race_result");
    assert.equal(result.organizationNameSnapshot, `仮称${type}`);
    assert.equal(result.organizationId, undefined);
  }
  assert.throws(() => buildPlan("batch", data, context(), { ...resolution, organizationMap: {} }, emptyAgent("membership"), emptyAgent("person_facts"), "apply"), /requires a normalized organization/);
});
test("person graph plans compact kanji names and preserves non-kanji separators", async () => {
  const data = input();
  data.rows = [
    { key: "han", name: "山田　太郎", organizationKey: "o", memberships: [], pbs: [] },
    { key: "katakana", name: "ジョンソン モゲニ", organizationKey: "o", memberships: [], pbs: [] },
    { key: "roman", name: "John Smith", organizationKey: "o", memberships: [], pbs: [] },
  ];
  const ctx = context();
  ctx.people = [];
  const result = await normalizePeople(
    "b",
    data,
    ctx,
    { organizationMap: { o: "o1" }, personMap: {}, findings: [], changes: [], metrics: emptyMetrics() },
    async () => ({ evidence: [] }),
  );
  assert.deepEqual(
    result.changes
      .filter((c) => c.operation.kind === "create_person")
      .map((c) => c.operation.kind === "create_person" && c.operation.entity.displayNameJa),
    ["山田太郎", "ジョンソン モゲニ", "John Smith"],
  );
});

test("unknown, club, and company entries stay as race-name snapshots", async () => {
  const data = input();
  data.organizations[0].type = "unknown";
  data.organizations[0].name = "試験クラブ";
  data.rows = [data.rows[0]];
  data.rows[0].organizationKey = "o";
  const ctx = context();
  ctx.organizations[0].type = "unknown";
  ctx.organizations[0].nameJa = "試験クラブ";
  const result = await buildBatchGraph({
    loadContext: async () => ctx,
    research: async (request) => request.kind === "normalization_cross_check"
      ? { crossAnswer: { issues: [] }, evidence: [] }
      : { batchAnswer: { items: (request.context as { items: Array<{ itemKey: string; allowedIds: string[]; evidence: Array<{ key: string }> }> }).items.map(item => ({
          itemKey: item.itemKey, verdict: "distinct" as const, targetId: null,
          evidenceRefs: item.evidence.map(e => e.key), reason: "组织未确认，不建立组织关联",
        })) }, evidence: [] },
  }).invoke({ batchId: "unknown-org", input: data, mode: "dry_run" });
  assert.equal(result.resolution.organizationMap.o, undefined);
  assert.equal(result.resolution.personMap.a, "pa");
  assert.equal(result.resolution.metrics.normalizationRuleMatches?.[0]?.rule, "unique_person_under_unconfirmed_organization");
  const raceResult = result.plan.changes.find(
    (change) => change.operation.kind === "race_result",
  );
  assert.ok(raceResult && raceResult.operation.kind === "race_result");
  assert.equal(raceResult.operation.organizationId, undefined);
  assert.equal(raceResult.operation.organizationNameSnapshot, "試験クラブ");
  assert.equal(result.plan.changes.some((change) => change.operation.kind === "create_organization"), false);
  assert.equal(result.plan.changes.some((change) => change.operation.kind === "membership"), false);
});

test("corporate-team identity merge ignores non-conflicting university history", async () => {
  const data = input();
  data.organizations = [{ key: "o", name: "花王", type: "corporate_team" }];
  data.rows = [{ key: "ledama", name: "KISAISA LEDAMA", organizationKey: "o", memberships: [], pbs: [] }];
  const ctx = context();
  ctx.organizations = [
    { id: "team", slug: "kao", nameJa: "花王", type: "corporate_team" },
    { id: "university", slug: "school", nameJa: "試験大学", type: "university" },
  ];
  ctx.people = [
    { id: "canonical", slug: "canonical", displayNameJa: "KISAISA LEDAMA" },
    { id: "duplicate", slug: "duplicate", displayNameJa: "KISAISA LEDAMA" },
  ];
  ctx.memberships = [
    { id: "m1", personId: "canonical", organizationId: "team", organizationType: "corporate_team", type: "affiliated", startBasis: "unknown", endBasis: "unknown", endState: "unknown" },
    { id: "m2", personId: "duplicate", organizationId: "university", organizationType: "university", type: "enrolled", startBasis: "source", endBasis: "source", startDate: "2020-04-01", endDate: "2024-03-31", endState: "ended" },
  ];
  ctx.historicalResults = [
    { id: "h1", personId: "canonical", organizationId: "team", raceId: "old1", raceSlug: "old1", raceName: "旧赛", raceDate: "2025-01-01" },
    { id: "h2", personId: "canonical", organizationId: "team", raceId: "old2", raceSlug: "old2", raceName: "旧赛", raceDate: "2025-02-01" },
    { id: "h3", personId: "duplicate", organizationId: "university", raceId: "old3", raceSlug: "old3", raceName: "旧赛", raceDate: "2024-01-01" },
  ];
  const result = await normalizePeople(
    "b", data, ctx,
    { organizationMap: { o: "team" }, personMap: {}, findings: [], changes: [], metrics: emptyMetrics() },
    async () => { throw new Error("non-conflicting identities must not call research"); },
  );
  assert.equal(result.personMap.ledama, "canonical");
  assert.ok(result.changes.some(c => c.operation.kind === "merge_person" && c.operation.duplicateId === "duplicate"));
  assert.equal(result.metrics.normalizationRuleMatches?.[0]?.rule, "non_conflicting_corporate_team_identity_merge");
});

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
    assert.equal(deepCalls, scenario === "near_name" ? 1 : 0, scenario);
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
test("whole unresolved group uses one person call; source plans are replaced; membership uses race representation", async () => {
  const calls: ResearchRequest[] = [];
  const graph = buildBatchGraph({ loadContext: async () => context(), research: async (r,m) => { calls.push(r); m.llmCalls++; return match(r,m); } });
  const result = await graph.invoke({ batchId: "b", input: input(), mode: "dry_run" });
  assert.deepEqual(calls.map(r => r.kind), ["normalization_light", "normalization_cross_check"]);
  assert.equal(items(calls[0]).length, 2);
  assert.ok(JSON.stringify(calls[0]).includes('"isStarter":false'));
  assert.deepEqual(result.resolution.personMap, { a: "pa", b: "pb" });
  assert.equal(result.plan.changes.filter(c => c.operation.kind === "create_person").length, 0);
  assert.equal(result.plan.changes.filter(c => c.operation.kind === "membership").length, 2);
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
  assert.equal(result.plan.changes.filter(c => c.operation.kind === "membership").length, 2);
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

test("unsupported cross-check claim preserves a historical rule match", async () => {
  const { data, ctx } = historicalFixture();
  const calls: ResearchRequest[] = [];
  const result = await buildBatchGraph({ loadContext: async () => ctx, research: async (r,m) => {
    calls.push(r);
    if (r.kind === "normalization_cross_check") return { crossAnswer: { issues: [{ issueKey: "conflict", issueType: "mapping_conflict", organizationKey: "o", personKeys: ["a"], evidenceRefs: ["result:ha"], reason: "发现独立身份矛盾", suggestedAction: "unresolved" }] }, evidence: [] };
    return match(r,m);
  } }).invoke({ batchId: "b", input: data, mode: "dry_run" });
  assert.equal(result.resolution.personMap.a, "pa");
  assert.ok(result.resolution.metrics.normalizationRuleMatches?.some(m => m.subjectRef === "a"));
  assert.equal(calls.filter(r => r.kind === "normalization_cross_check").length, 1);
  assert.equal(calls.filter(r => r.kind === "normalization_light").length, 1);
});

test("same-race duplicate can overturn a rule-confirmed person", async () => {
  const data = input(), ctx = context();
  data.rows[0].sourceKey = "first";
  data.rows[1].sourceKey = "second";
  ctx.sourceMappings.push(
    { sourceId: "s", entityType: "person", sourceKey: "first", personId: "pa" },
    { sourceId: "s", entityType: "person", sourceKey: "second", personId: "pa" },
  );
  const result = await buildBatchGraph({ loadContext: async () => ctx, research: async (r, m) => {
    if (r.kind === "normalization_cross_check") return { crossAnswer: { issues: [{
      issueKey: "duplicate", issueType: "mapping_conflict", organizationKey: "o",
      personKeys: ["a", "b"], evidenceRefs: ["source:a", "source:b"],
      reason: "同场两行映射同一人物", suggestedAction: "unresolved",
    }] }, evidence: [] };
    return match(r, m);
  } }).invoke({ batchId: "duplicate", input: data, mode: "dry_run" });
  assert.ok(result.plan.findings.some(f => f.code === "mapping_conflict" && f.status === "unresolved"));
});

test("temporary person merges into a formal historical identity in the rule stage", async () => {
  const data = input(), ctx = context();
  data.rows = [data.rows[0]];
  data.rows[0].sourceKey = "temporary-source";
  ctx.people.push({ id: "gov_temporary", slug: "temporary", displayNameJa: "選手a" });
  ctx.sourceMappings.push({ sourceId: "s", entityType: "person", sourceKey: "temporary-source",
    personId: "gov_temporary" });
  ctx.historicalResults![0].raceDate = "2025-11-01";
  ctx.historicalResults![0].sourceId = "s";
  const result = await buildBatchGraph({ loadContext: async () => ctx, research: match })
    .invoke({ batchId: "merge", input: data, mode: "dry_run" });
  assert.equal(result.resolution.personMap.a, "pa");
  assert.ok(result.plan.changes.some(c => c.operation.kind === "merge_person" &&
    c.operation.canonicalId === "pa" && c.operation.duplicateId === "gov_temporary"));
});

test("current DNS follows the same identity path and retains source-backed membership", async () => {
  const data = input(), ctx = context(), calls: ResearchRequest[] = [];
  data.rows[0].notes = "DNS";
  data.rows[0].memberships = [{ organizationKey: "o", type: "enrolled", grade: 3, endState: "unknown" }];
  const result = await buildBatchGraph({ loadContext: async () => ctx, research: async (r,m) => { calls.push(r); return match(r,m); } }).invoke({ batchId: "b", input: data, mode: "dry_run" });
  assert.deepEqual(items(calls.find(r => r.subjectRef === "person")!).map(i => i.itemKey), ["person_identity:a", "person_identity:b"]);
  assert.equal(result.resolution.personMap.a, "pa");
  assert.equal(result.resolution.personMap.b, "pb");
  assert.equal(result.plan.changes.filter(c => c.operation.kind === "membership").length, 2);
  assert.equal(calls.filter(r => r.kind === "person_identity").length, 0);
  assert.deepEqual(result.resolution.metrics.normalizationDnsSkipped, []);
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


test("a university graduate entering a corporate team resolves without research", async () => {
  const data = input(), ctx = context();
  data.organizations[0].type = "corporate_team";
  data.rows = [data.rows[0]];
  ctx.people = [ctx.people[0]];
  ctx.memberships = [{ id: "school-history", personId: "pa", organizationId: "university",
    organizationType: "university", type: "enrolled", startBasis: "unknown",
    endBasis: "unknown", endState: "unknown" }];
  const result = await normalizePeople("b", data, ctx,
    { organizationMap: { o: "team" }, personMap: {}, findings: [], changes: [], metrics: emptyMetrics() },
    async () => { throw new Error("no research expected"); });
  assert.equal(result.personMap.a, "pa");
  assert.equal(result.changes.some(c => c.operation.kind === "create_person"), false);
});

test("different corporate teams and contradictory birthdays prevent automatic duplicate merging", async () => {
  for (const scenario of ["team", "birthday", "homophone", "school"]) {
    const data = input(), ctx = context();
    data.organizations[0].type = "corporate_team";
    data.rows = [data.rows[0]];
    data.rows[0].kana = "センシュ";
    ctx.people = [
      { id: "pa", slug: "a", displayNameJa: data.rows[0].name, displayNameKana: "センシュ", birthDate: "1998-01-01" },
      { id: "pb", slug: "b", displayNameJa: scenario === "homophone" ? "別漢字" : data.rows[0].name,
        displayNameKana: "センシュ", birthDate: scenario === "birthday" ? "1999-01-01" : "1998-01-01" },
    ];
    ctx.memberships = [
      { id: "m1", personId: "pa", organizationId: scenario === "school" ? "u1" : "team", organizationType: scenario === "school" ? "university" : "corporate_team", type: scenario === "school" ? "enrolled" : "affiliated", startBasis: "source", endBasis: "source", startDate: "2020-04-01", endDate: "2024-03-31", endState: "ended" },
      { id: "m2", personId: "pb", organizationId: scenario === "team" ? "other-team" : "u2", organizationType: scenario === "team" ? "corporate_team" : "university", type: scenario === "team" ? "affiliated" : "enrolled", startBasis: "source", endBasis: "source", startDate: "2020-04-01", endDate: "2024-03-31", endState: "ended" },
    ];
    const result = await normalizePeople("b", data, ctx,
      { organizationMap: { o: "team" }, personMap: {}, findings: [], changes: [], metrics: emptyMetrics() },
      async () => ({ evidence: [] }), true);
    assert.equal(result.changes.some(c => c.operation.kind === "merge_person"), false, scenario);
  }
});

test("identical membership duplicates produce executable deletion; dated separate spells stay for review", async () => {
  for (const separate of [false, true]) {
    const data = input(), ctx = context();
    data.rows = [data.rows[0]];
    ctx.memberships = ["m1", "m2"].map(id => ({
      id, personId: "pa", organizationId: "o1", organizationType: "high_school", type: "enrolled",
      startDate: separate && id === "m2" ? "2021-04-01" : undefined,
      startBasis: "unknown", endBasis: "unknown", endState: "unknown",
    }));
    const result = await governMemberships("b", data, ctx,
      { organizationMap: { o: "o1" }, personMap: { a: "pa" }, findings: [], changes: [], metrics: emptyMetrics() },
      async () => { throw new Error("duplicate cleanup needs no LLM"); });
    assert.equal(result.changes.filter(c => c.operation.kind === "delete_membership").length, separate ? 0 : 1);
    assert.equal(result.findings.some(f => f.code === "membership_unresolved"), separate);
  }
});

test("confirmed organization aliases reuse existing IDs; duplicate candidates never authorize stored organization merges", async () => {
  const { normalizeOrganizations } = await import("../agents.js");
  const data = input(), ctx = context();
  data.organizations[0].name = "旧称高校";
  ctx.organizations[0].aliases = ["旧称高校"];
  const first = await normalizeOrganizations("alias", data, ctx, async () => assert.fail("Exact alias should be deterministic"));
  assert.equal(first.organizationMap.o, ctx.organizations[0].id);
  assert.equal(first.changes.some(c => c.operation.kind === "create_organization"), false);
  ctx.organizations.push({ ...ctx.organizations[0], id: "duplicate-org", slug: "duplicate-org" });
  const second = await normalizeOrganizations("duplicates", data, ctx, async () => ({ answer: {
    verdict: "merge", targetId: ctx.organizations[0].id, duplicateIds: ["duplicate-org"], reason: "不能授权存量合并",
    corrections: [], split: null, evidence: [{ url: "https://example.com/history", quote: "沿革" }],
  }, evidence: [{ url: "https://example.com/history", quote: "沿革" }] }));
  assert.equal(second.changes.some(c => c.operation.kind === "merge_organization"), false);
  assert.ok(second.findings.some(f => f.code === "organization_duplicate_candidates" && f.status === "informational"));
});


test("qualifier team totals have no synthetic leg and reject legless cumulative snapshots", () => {
  const data = input();
  const raw = { ...data, teams: [{ organizationKey: "o", finalRank: 1, finalMark: "10:32:23" }] };
  const parsed = manifestSchema.parse({ version: CONTRACT_VERSION, requestKey: "qualifier", eventEditionId: "e", mode: "apply", batches: [raw] }).batches[0];
  const resolution = { organizationMap: { o: "o1" }, personMap: { a: "pa", b: "pb" }, findings: [], changes: [], metrics: emptyMetrics() };
  const emptyAgent = (agentKey: string) => ({ agentKey, skipped: true, findings: [], changes: [], metrics: emptyMetrics() });
  const plan = buildPlan("batch", parsed, context(), resolution, emptyAgent("membership"), emptyAgent("person_facts"), "apply");
  const team = plan.changes.find(c => c.operation.kind === "team_result")!;
  assert.equal(team.operation.kind === "team_result" && team.operation.team.leg, undefined);
  assert.match(team.key, /overall/);
  assert.throws(() => manifestSchema.parse({ version: CONTRACT_VERSION, requestKey: "bad", eventEditionId: "e", batches: [{ ...raw, teams: [{ ...raw.teams[0], cumulativeMark: "10:32:23" }] }] }), /require a leg/);
});


test("team writer stores qualifier totals without snapshots and preserves ekiden snapshots", async () => {
  for (const leg of [undefined, 1]) {
    const data = input();
    data.teams = [{ organizationKey: "o", finalRank: 1, finalMark: "10:32:23", ...(leg ? { leg, cumulativeMark: "1:00:00" } : {}) }];
    const resolution = { organizationMap: { o: "o1" }, personMap: { a: "pa", b: "pb" }, findings: [], changes: [], metrics: emptyMetrics() };
    const emptyAgent = (agentKey: string) => ({ agentKey, skipped: true, findings: [], changes: [], metrics: emptyMetrics() });
    const plan = buildPlan("batch", data, context(), resolution, emptyAgent("membership"), emptyAgent("person_facts"), "apply");
    const team = plan.changes.find(c => c.operation.kind === "team_result")!;
    const queries: string[] = [];
    const client = { query: async (sql: string) => { queries.push(sql); return { rows: [{ id: "team-id" }] }; } } as unknown as PoolClient;
    const writer = new BusinessWriter({} as GovernanceDB, true);
    await writer["execute"](client, plan, team);
    assert.equal(queries.filter(sql => sql.startsWith('INSERT INTO public."TeamCompetitionResult"')).length, 1);
    assert.equal(queries.filter(sql => sql.startsWith('INSERT INTO public."TeamCompetitionLegSnapshot"')).length, leg ? 1 : 0);
    assert.equal(queries.filter(sql => sql.startsWith('INSERT INTO public."AuditLog"')).length, 1);
  }
});
