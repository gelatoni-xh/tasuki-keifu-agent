import assert from "node:assert/strict";
import test from "node:test";
import { MemorySaver } from "@langchain/langgraph";
import { batchInputSchema, emptyMetrics, type Context, type Membership, type Resolution } from "../contracts.js";
import { buildPersonFactsOnlyPlan, governMemberships, prepareMembershipContext, resolveMembershipRules, collectMembershipConflicts, verifyFacts } from "../agents.js";
import { buildMembershipGraph, route_person_facts_agent } from "../graph.js";
import { fillUnknownDates } from "../rules.js";
import type { Researcher, ResearchAnswer } from "../research.js";

const evidence = [{ url: "https://official.example/transfer", quote: "2024年に入部。" }];
function fixture() {
  const input = batchInputSchema.parse({ unitType: "leg", unitKey: "1", sequence: 0, sourceId: "s", raceSlug: "race",
    organizations: [{ key: "o", name: "実業団", type: "corporate_team" }],
    rows: [{ key: "r", name: "選手", organizationKey: "o" }],
  });
  const ctx: Context = { raceId: "race", raceDate: "2025-11-03", editionId: "e", source: { id: "s", reliability: 5 },
    sources: [], organizations: [{ id: "o", slug: "o", nameJa: "実業団", type: "corporate_team" }],
    people: [{ id: "p", slug: "p", displayNameJa: "選手" }], memberships: [], pbs: [], sourceMappings: [] };
  const res: Resolution = { organizationMap: { o: "o" }, personMap: { r: "p" }, findings: [], changes: [], metrics: emptyMetrics() };
  return { input, ctx, res };
}
function mem(overrides: Partial<Membership> = {}): Membership {
  return { id: "m", personId: "p", organizationId: "o", type: "affiliated", organizationType: "corporate_team",
    startBasis: "unknown", endBasis: "unknown", endState: "unknown", ...overrides };
}
const noResearch: Researcher = async () => assert.fail("Rule-resolvable membership must not call LLM");
function answer(overrides: Partial<ResearchAnswer> = {}): ResearchAnswer {
  return { verdict: "keep_membership", targetId: null, duplicateIds: [], reason: "现有履历合理，无需修改", evidence,
    corrections: [], split: null, ...overrides };
}
function conflictFixture() {
  const f = fixture();
  f.ctx.memberships = [mem({ startDate: "2020-04-01", startYear: 2020, startBasis: "source" })];
  f.input.rows[0].memberships = [{ organizationKey: "o", type: "affiliated", startDate: "2024-04-01", endState: "unknown" }];
  return f;
}

test("race observation does not invent a corporate joining date or ongoing employment", async () => {
  const { input, ctx, res } = fixture();
  input.rows[0].notes = "DNS";
  const result = await governMemberships("b", input, ctx, res, noResearch);
  const change = result.changes.find(c => c.operation.kind === "membership")!;
  assert.equal(change.operation.kind, "membership");
  if (change.operation.kind !== "membership") return;
  assert.equal(change.operation.membership.startDate, undefined);
  assert.equal(change.operation.membership.startYear, undefined);
  assert.equal(change.operation.membership.endState, "unknown");
  assert.equal(result.metrics.membershipDnsRowsIncluded, 1);
  ctx.memberships = [mem({ startDate: "2020-04-01", startBasis: "source" })];
  assert.equal((await governMemberships("b", input, ctx, res, noResearch)).findings.length, 0);
});

test("DNS row still verifies source-backed person facts", () => {
  const { input, ctx, res } = fixture();
  input.rows[0].notes = "DNS";
  input.rows[0].hometown = "東京";
  const result = verifyFacts("b", input, ctx, res);
  assert.ok(result.changes.some(c => c.operation.kind === "person_fact" && c.operation.personId === "p"));
});

test("hometown and registered prefecture are independent facts", () => {
  const { input, ctx, res } = fixture();
  input.rows[0].hometown = "東京";
  input.rows[0].registeredPrefecture = "長野";
  const result = verifyFacts("b", input, ctx, res);
  const facts = result.changes.filter(c => c.operation.kind === "person_fact");
  assert.deepEqual(facts.map(c => c.operation.kind === "person_fact" && c.operation.field).sort(), ["hometown", "registeredPrefecture"]);
});

test("birth date is added when missing and an existing mismatch stays unresolved", () => {
  const { input, ctx, res } = fixture();
  input.rows[0].birthDate = "2004-12-07";
  const filled = verifyFacts("b", input, ctx, res);
  const birthChange = filled.changes.find(c => c.operation.kind === "person_fact" && c.operation.field === "birthDate");
  assert.ok(birthChange);
  if (birthChange?.operation.kind === "person_fact") {
    assert.equal(birthChange.operation.value, "2004-12-07");
    assert.equal(birthChange.reason, "可靠来源补空出生日期");
  }

  ctx.people[0].birthDate = "2004-12-08";
  const conflict = verifyFacts("b", input, ctx, res);
  assert.ok(conflict.findings.some(f => f.code === "person_fact_conflict" && f.reason.includes("出生日期")));
  assert.equal(conflict.changes.some(c => c.operation.kind === "person_fact" && c.operation.field === "birthDate"), false);
});

test("birth date from a low-reliability source remains unresolved", () => {
  const { input, ctx, res } = fixture();
  input.rows[0].birthDate = "2004-12-07";
  ctx.source.reliability = 2;
  const result = verifyFacts("b", input, ctx, res);
  assert.ok(result.findings.some(f => f.code === "insufficient_evidence" && f.reason.includes("出生日期")));
  assert.equal(result.changes.some(c => c.operation.kind === "person_fact" && c.operation.field === "birthDate"), false);
});

test("birth-date-only input routes to the person facts graph", () => {
  const { input, ctx, res } = fixture();
  input.rows[0].birthDate = "2004-12-07";
  assert.equal(route_person_facts_agent({ input, context: ctx, resolution: res } as never), "verify_person_facts");
});

test("person facts plan retains identity unresolved findings", () => {
  const { input, ctx, res } = fixture();
  const facts = verifyFacts("b", input, ctx, res);
  const identityFinding = {
    key: "person_facts_identity:r", code: "identity_unresolved", subjectRef: "r",
    severity: "serious" as const, status: "unresolved" as const,
    reason: "缺少唯一映射", evidence: [{ sourceId: "s", sourceKey: "r" }],
  };
  const plan = buildPersonFactsOnlyPlan("b", input, ctx, res, "dry_run", facts, [identityFinding]);
  assert.deepEqual(plan.findings, [identityFinding]);
  assert.equal(plan.summary.unresolved, 1);
});

test("conflicting existing person facts are unresolved and never overwritten", () => {
  const { input, ctx, res } = fixture();
  ctx.people[0].hometown = "東京";
  ctx.people[0].registeredPrefecture = "長野";
  input.rows[0].hometown = "大阪";
  input.rows[0].registeredPrefecture = "新潟";

  const result = verifyFacts("b", input, ctx, res);

  assert.equal(result.findings.length, 2);
  assert.ok(result.findings.every(f => f.status === "unresolved" && f.code === "person_fact_conflict"));
  assert.equal(result.changes.some(c => c.operation.kind === "person_fact"), false);
});

test("low-reliability person facts are unresolved instead of silently skipped", () => {
  const { input, ctx, res } = fixture();
  ctx.source.reliability = 2;
  input.rows[0].hometown = "東京";
  input.rows[0].registeredPrefecture = "長野";

  const result = verifyFacts("b", input, ctx, res);

  assert.equal(result.findings.length, 2);
  assert.ok(result.findings.every(f => f.status === "unresolved" && f.code === "insufficient_evidence"));
  assert.equal(result.changes.length, 0);
  const plan = buildPersonFactsOnlyPlan("b", input, ctx, res, "dry_run", result);
  assert.equal(plan.findings.length, 2);
  assert.equal(plan.summary.unresolved, 2);
});

test("unreliable or incomparable PB candidates are unresolved; slower marks are routine skips", () => {
  const { input, ctx, res } = fixture();
  ctx.sources = [{ id: "s", reliability: 4 }];
  ctx.pbs = [{ id: "pb", personId: "p", discipline: "m10000", mark: "28:00", markMillis: 1_680_000, reliability: 5, updatedAt: "2025-01-01" }];
  input.rows[0].pbs = [{ discipline: "m10000", mark: "27:00", sourceId: "s" }];

  const blockedUpdate = verifyFacts("b", input, ctx, res);
  assert.equal(blockedUpdate.findings.length, 1);
  assert.equal(blockedUpdate.findings[0].code, "insufficient_evidence");
  assert.equal(blockedUpdate.changes.length, 0);

  ctx.sources[0].reliability = 2;
  input.rows[0].pbs[0].mark = "29:00";
  const slowerMark = verifyFacts("b", input, ctx, res);
  assert.equal(slowerMark.findings.length, 0);
  assert.equal(slowerMark.changes.length, 0);
});

test("local organization finding leaves a known membership relation actionable", async () => {
  const { input, ctx, res } = fixture();
  res.findings = [{ key: "local", code: "organization_variant", subjectRef: "r",
    severity: "serious", status: "unresolved", reason: "局部组织待核实", evidence: [] }];
  const result = await governMemberships("b", input, ctx, res, noResearch);
  assert.ok(result.changes.some(c => c.operation.kind === "membership" && c.operation.membership.personId === "p"));
});

test("historical starter and school ending inform the timeline without research", async () => {
  const { input, ctx, res } = fixture();
  ctx.organizations.push({ id: "u", slug: "u", nameJa: "大学", type: "university" });
  ctx.memberships = [mem({ id: "school", organizationId: "u", organizationType: "university",
    type: "enrolled", startDate: "2022-04-01", startYear: 2022, startBasis: "source",
    endDate: "2025-03-31", endYear: 2025, endBasis: "source" })];
  ctx.historicalResults = [{ id: "old", personId: "p", organizationId: "u",
    raceId: "old-race", raceSlug: "old", raceName: "旧大会",
    raceDate: "2021-11-01", isStarter: true }];
  const result = await governMemberships("b", input, ctx, res, noResearch);
  const school = result.changes.find(c => c.operation.kind === "membership" && c.operation.membership.id === "school");
  const team = result.changes.find(c => c.operation.kind === "membership" && c.operation.membership.organizationId === "o");
  assert.equal(school?.operation.kind === "membership" && school.operation.membership.startDate, undefined);
  assert.deepEqual(school?.operation.kind === "membership" &&
    school.operation.membership.evidence?.historicalStarterObservations, ["old"]);
  assert.equal(team?.operation.kind === "membership" && team.operation.membership.startDate, undefined);
  assert.equal(team?.operation.kind === "membership" &&
    team.operation.membership.evidence?.schoolEndBeforeCorporateObservation, "2025-03-31");
});

test("school and corporate stages coexist without external research; retired labels never create membership", async () => {
  const { input, ctx, res } = fixture();
  ctx.memberships = [mem({ id: "college", organizationId: "u", organizationType: "university", type: "enrolled",
    startDate: "2021-04-01", endDate: "2025-03-31", startBasis: "source", endBasis: "source" })];
  const result = await governMemberships("b", input, ctx, res, noResearch);
  assert.equal(result.findings.length, 0);
  assert.ok(result.changes.some(c => c.operation.kind === "membership" && c.operation.membership.organizationId === "o"));
  for (const type of ["club", "company", "unknown"] as const) {
    input.organizations[0].type = type; ctx.organizations[0].type = type;
    input.rows[0].memberships = [{ organizationKey: "o", type: "affiliated", endState: "unknown" }];
    assert.equal((await governMemberships("b", input, ctx, res, noResearch)).changes.some(c => c.operation.kind === "membership" && c.operation.membership.organizationId === "o"), false);
  }
});

test("all conflicts for one person are researched once with the complete career; keep can resolve without date edits", async () => {
  const { input, ctx, res } = conflictFixture();
  input.organizations.push({ key: "u", name: "大学", type: "university" }); res.organizationMap.u = "u";
  ctx.organizations.push({ id: "u", slug: "u", nameJa: "大学", type: "university" });
  ctx.memberships.push(mem({ id: "college", organizationId: "u", organizationType: "university", type: "enrolled", startDate: "2016-04-01", startBasis: "source" }));
  input.rows[0].memberships.push({ organizationKey: "u", type: "enrolled", startDate: "2017-04-01", endState: "unknown" });
  let calls = 0;
  const result = await governMemberships("b", input, ctx, res, async request => {
    calls++; assert.equal(request.kind, "membership_conflict");
    assert.deepEqual(request.allowedIds.sort(), ["college", "m"]);
    const context = request.context as { memberships: Membership[]; conflicts: unknown[]; organizations: Array<{ nameJa: string }> };
    assert.equal(context.memberships.length, 2); assert.equal(context.conflicts.length, 2);
    assert.deepEqual(context.organizations.map(o => o.nameJa).sort(), ["大学", "実業団"].sort());
    return { answer: answer(), evidence };
  });
  assert.equal(calls, 1);
  assert.equal(result.metrics.membershipResearchPeople, 1);
  assert.equal(result.findings.filter(f => f.status === "resolved").length, 2);
  for (const c of result.changes) if (c.operation.kind === "membership")
    assert.equal(c.operation.membership.startDate, (c.operation.membership.id === "m" ? "2020-04-01" : "2016-04-01"));
});

test("year-only research correction clears a false precise date and preserves source precision", async () => {
  const { input, ctx, res } = conflictFixture();
  const result = await governMemberships("b", input, ctx, res, async () => ({ evidence,
    answer: answer({ verdict: "correct_membership", corrections: [{ membershipId: "m", startDate: null, endDate: null, startYear: 2024 }] }),
  }));
  assert.equal(result.findings[0].status, "resolved");
  const change = result.changes.find(c => c.operation.kind === "membership")!;
  if (change.operation.kind !== "membership") return assert.fail();
  assert.equal(change.operation.membership.startDate, undefined);
  assert.equal(change.operation.membership.startYear, 2024);
  assert.equal(change.operation.membership.startBasis, "source");
  const preserved = fillUnknownDates(change.operation.membership, { startBasis: "unknown", endBasis: "unknown", endState: "unknown" });
  assert.equal(preserved.startYear, 2024); assert.equal(preserved.startBasis, "source");
});

test("explicit unknown dates can clear wrong dates without inventing replacements", async () => {
  const { input, ctx, res } = conflictFixture();
  const result = await governMemberships("b", input, ctx, res, async () => ({ evidence, answer: answer({ verdict: "correct_membership",
    corrections: [{ membershipId: "m", startDate: null, endDate: null, clearStartDate: true, endState: "ended" }] }) }));
  const op = result.changes.find(c => c.operation.kind === "membership")!.operation;
  if (op.kind !== "membership") return assert.fail();
  assert.equal(op.membership.startDate, undefined); assert.equal(op.membership.startYear, undefined);
  assert.equal(op.membership.startBasis, "unknown"); assert.equal(op.membership.endState, "ended");
});

test("foreign, inconsistent, duplicate or unsupported corrections never partially apply", async () => {
  const mutations: ResearchAnswer["corrections"][] = [
    [{ membershipId: "m", startDate: null, endDate: null, startYear: 2024 }, { membershipId: "foreign", startDate: null, endDate: null }],
    [{ membershipId: "m", startDate: "2024-04-01", endDate: null, startYear: 2023 }],
    [{ membershipId: "m", startDate: "2024-04-01", endDate: null, endYear: 2023 }],
    [{ membershipId: "m", startDate: "2024-04-01", endDate: null, clearStartDate: true }],
    [{ membershipId: "m", startDate: null, endDate: null }, { membershipId: "m", startDate: null, endDate: null }],
  ];
  for (const corrections of mutations) {
    const { input, ctx, res } = conflictFixture();
    const result = await governMemberships("b", input, ctx, res, async () => ({ evidence, answer: answer({ verdict: "correct_membership", corrections }) }));
    assert.equal(result.findings[0].status, "unresolved");
    for (const c of result.changes) if (c.operation.kind === "membership") assert.equal(c.operation.membership.startDate, "2020-04-01");
  }
  const { input, ctx, res } = conflictFixture();
  assert.equal((await governMemberships("b", input, ctx, res, async () => ({ evidence: [], answer: answer() }))).findings[0].status, "unresolved");
});

test("person merge deduplicates all exact memberships and preserves historical evidence", async () => {
  const { input, ctx, res } = fixture();
  ctx.memberships = [mem({ id: "old", personId: "duplicate", organizationId: "old-team", evidence: { sourceId: "first" } }),
    mem({ id: "canonical", organizationId: "old-team", evidence: { sourceId: "second" } })];
  res.changes.push({ key: "merge", idempotencyKey: "merge", operation: { kind: "merge_person", canonicalId: "p", duplicateId: "duplicate", evidence }, expectedVersions: {}, reason: "同人", evidence, agentKey: "normalization" });
  const result = await governMemberships("b", input, ctx, res, noResearch);
  assert.equal(result.changes.filter(c => c.operation.kind === "delete_membership").length, 1);
  assert.ok(result.changes.some(c => c.operation.kind === "membership" && c.operation.membership.organizationId === "o"));
  const retained = result.changes.find(c => c.operation.kind === "membership" && c.operation.membership.organizationId === "old-team")!;
  if (retained.operation.kind !== "membership") return assert.fail();
  assert.equal((retained.operation.membership.evidence?.deduplicatedMemberships as unknown[]).length, 1);
});

test("different roles and academic details are not duplicate memberships", async () => {
  const { input, ctx, res } = fixture();
  ctx.memberships = [mem({ id: "one", role: "athlete", cohort: "2021" }), mem({ id: "two", role: "coach", cohort: "2022" })];
  const result = await governMemberships("b", input, ctx, res, noResearch);
  assert.equal(result.changes.some(c => c.operation.kind === "delete_membership"), false);
});

test("membership graph skips LLM nodes without conflicts, and research survives validation restart", async () => {
  const f = fixture(), visited: string[] = [];
  await buildMembershipGraph({ research: noResearch, onNode: async name => { visited.push(name); } }).invoke({ batchId: "b", input: f.input, context: f.ctx, resolution: f.res });
  assert.deepEqual(visited, ["prepare_membership_context", "membership_deduplication", "membership_rules",
    "membership_timeline", "collect_membership_conflicts", "finalize_membership"]);
  const { input, ctx, res } = conflictFixture();
  const saver = new MemorySaver(); let calls = 0;
  const research: Researcher = async () => { calls++; return { answer: answer(), evidence }; };
  const config = { configurable: { thread_id: "membership-resume" } };
  const interrupted = buildMembershipGraph({ research, checkpointer: saver, failAfter: "validate_membership_decisions" });
  await assert.rejects(interrupted.invoke({ batchId: "b", input, context: ctx, resolution: res }, config), /Injected interruption/);
  const result = await buildMembershipGraph({ research, checkpointer: saver }).invoke(null, config);
  assert.equal(calls, 1); assert.equal(result.membership.findings[0].status, "resolved");
  const work = collectMembershipConflicts(resolveMembershipRules("b", input, ctx, res, prepareMembershipContext(input, ctx, res)));
  assert.deepEqual(JSON.parse(JSON.stringify(work)).groups[0].membershipIds, ["m"]);
});

test("race observations accumulate without replacing original membership sources", async () => {
  const { input, ctx, res } = fixture();
  ctx.memberships = [mem({ evidence: { sourceId: "original", raceObservations: [{ sourceId: "older", rowKey: "x", raceDate: "2024-01-01" }] } })];
  const result = await governMemberships("b", input, ctx, res, noResearch);
  const op = result.changes.find(c => c.operation.kind === "membership")!.operation;
  if (op.kind !== "membership") return assert.fail();
  assert.equal(op.membership.evidence?.sourceId, "original");
  assert.equal((op.membership.evidence?.raceObservations as unknown[]).length, 2);
  ctx.memberships = [op.membership];
  assert.equal((await governMemberships("b", input, ctx, res, noResearch)).changes.length, 0);
});

test("year-only contradictory input is reviewed and keep cannot dismiss genuine exclusive overlap", async () => {
  const { input, ctx, res } = conflictFixture();
  input.rows[0].memberships[0].startDate = undefined;
  input.rows[0].memberships[0].startYear = 2024;
  let calls = 0;
  const reviewed = await governMemberships("b", input, ctx, res, async () => { calls++; return { evidence, answer: answer() }; });
  assert.equal(calls, 1); assert.equal(reviewed.findings[0].status, "resolved");
  ctx.memberships = [mem({ startDate: "2020-04-01", startBasis: "source", endState: "ongoing", exclusivityGroup: "employment" }),
    mem({ id: "other", organizationId: "other", startDate: "2021-04-01", startBasis: "source", endState: "ongoing", exclusivityGroup: "employment" })];
  input.rows[0].memberships = [];
  const conflict = await governMemberships("b", input, ctx, res, async () => ({ evidence, answer: answer() }));
  assert.ok(conflict.findings.some(f => f.status === "unresolved"));
});
