import type { BatchInput, Context, Metrics, Resolution } from "./contracts.js";
import { emptyMetrics } from "./contracts.js";
import { normalizeOrganizations, normalizePeople } from "./agents.js";
import type { Researcher, ResearchOutcome, ResearchRequest } from "./research.js";
import { batchAnswerSchema, crossAnswerSchema } from "./research.js";
import { normalizeName } from "./rules.js";

export const NORMALIZATION_POLICY_VERSION = "whole-group-cross-check/1";
export type NormalizationState = {
  requests: Record<string, ResearchRequest>;
  decisions: Record<string, ResearchOutcome>;
  organizationOverrides: Record<string, string>;
  issues: NonNullable<ResearchOutcome["crossAnswer"]>["issues"];
  affectedPersonKeys: string[];
};
export const initialNormalization = (): NormalizationState => ({
  requests: {}, decisions: {}, organizationOverrides: {}, issues: [], affectedPersonKeys: [],
});
const keyOf = (r: ResearchRequest) => `${r.kind}:${r.subjectRef}`;
const clone = <T>(v: T): T => structuredClone(v);

// Re-project a plan from immutable input and accepted decisions. Provisional creates,
// aliases and references are replaced together, never patched onto an old plan.
export async function projectNormalization(batchId: string, input: BatchInput, ctx: Context,
  state: NormalizationState, metrics: Metrics, people: boolean): Promise<Resolution> {
  const replay: Researcher = async (r) => {
    state.requests[keyOf(r)] = r;
    return state.decisions[keyOf(r)] ?? { stopReason: "pending_normalization", evidence: [] };
  };
  const orgs = await normalizeOrganizations(batchId, input, ctx, replay, true, state.organizationOverrides);
  const forceReview = new Set(state.issues.filter(i => ["unresolved", "research"].includes(i.suggestedAction) || i.issueType === "circular_evidence").flatMap(i => i.personKeys));
  const result = people ? await normalizePeople(batchId, input, ctx, orgs, replay, true, forceReview) : orgs;
  metrics.durationMs += result.metrics.durationMs;
  for (const change of result.changes) {
    const op = change.operation;
    if (op.kind !== "source_mapping" && op.kind !== "name_variant") continue;
    const decision = Object.values(state.decisions).find(d => d.answer?.verdict === "match" && d.answer.targetId === op.targetId);
    if (decision?.answer) { change.reason += `；${decision.answer.reason}`; change.evidence = decision.evidence; }
  }
  result.metrics = metrics;
  result.metrics.normalizationPolicyVersion = NORMALIZATION_POLICY_VERSION;
  return result;
}

function itemsFor(requests: ResearchRequest[], ctx: Context) {
  return requests.map(r => ({
    itemKey: keyOf(r), allowedIds: r.allowedIds,
    context: r.context,
    // Catalog keys are record IDs scoped to the item; the final sentinel exposes truncation.
    evidence: [
      { key: `source:${r.subjectRef}`, kind: "source", value: r.providedEvidence ?? [] },
      ...ctx.historicalResults?.filter(h => r.allowedIds.includes(h.personId)).map(h => ({ key: `result:${h.id}`, kind: "historical_result", value: h })) ?? [],
      ...ctx.historicalReferences?.filter(h => r.allowedIds.includes(h.personId)).map(h => ({ key: `reference:${h.id}`, kind: "source_reference", value: h })) ?? [],
      ...ctx.memberships.filter(m => r.allowedIds.includes(m.personId)).map(m => ({ key: `membership:${m.id}`, kind: "membership", value: m })),
    ],
    historyLimitPerPerson: 10,
    historyMayBeTruncated: r.allowedIds.some(id => (ctx.historicalResults?.filter(h => h.personId === id).length ?? 0) > 10 || (ctx.historicalReferences?.filter(h => h.personId === id).length ?? 0) > 10),
  }));
}
function stage(metrics: Metrics, name: string, inputCount: number, resolvedCount: number, started: number) {
  metrics.durationMs += Date.now() - started;
  (metrics.normalizationStages ??= []).push({ stage: name, inputCount, resolvedCount, remainingCount: Math.max(0, inputCount - resolvedCount), durationMs: Date.now() - started });
}
function requireBatch(outcome: ResearchOutcome, requests: ResearchRequest[], ctx: Context) {
  if (!outcome.batchAnswer) {
    if (["research_budget_exhausted", "research_not_configured"].includes(outcome.stopReason ?? "")) return [];
    throw new Error(`Normalization model failure: ${outcome.stopReason ?? "missing_batch_answer"}`);
  }
  const answer = batchAnswerSchema.parse(outcome.batchAnswer);
  const scopes = itemsFor(requests, ctx);
  const seen = new Set<string>();
  for (const item of answer.items) {
    const scope = scopes.find(s => s.itemKey === item.itemKey);
    if (!scope || seen.has(item.itemKey) ||
      (item.verdict === "match" ? !item.targetId || !scope.allowedIds.includes(item.targetId) : item.targetId !== null) ||
      item.evidenceRefs.some(ref => !scope.evidence.some(e => e.key === ref)) ||
      (item.verdict !== "unresolved" && !item.evidenceRefs.length))
      throw new Error("Invalid normalization batch scope/evidence");
    if (item.verdict === "match") {
      const request = requests.find(r => keyOf(r) === item.itemKey)!;
      const context = request.context as { row?: { birthDate?: string }; candidates?: Array<{ id: string; birthDate?: string }> };
      const candidate = context.candidates?.find(c => c.id === item.targetId);
      if (request.kind === "person_identity" &&
          !item.evidenceRefs.some(ref =>
            ctx.historicalResults?.some(h => ref === `result:${h.id}` && h.personId === item.targetId) ||
            ctx.memberships.some(m => ref === `membership:${m.id}` && m.personId === item.targetId) ||
            ctx.historicalReferences?.some(h => ref === `reference:${h.id}` && h.personId === item.targetId)) &&
          !(context.row?.birthDate && candidate?.birthDate === context.row.birthDate))
        throw new Error("Normalization person match has no independent identity evidence");
      if (context.row?.birthDate && candidate?.birthDate && context.row.birthDate !== candidate.birthDate)
        throw new Error("Normalization match contradicts explicit birth date");
    }
    seen.add(item.itemKey);
  }
  if (seen.size !== requests.length) throw new Error("Incomplete normalization batch response");
  return answer.items;
}
function saveItems(state: NormalizationState, requests: ResearchRequest[], items: ReturnType<typeof requireBatch>) {
  for (const item of items) {
    const r = requests.find(r => keyOf(r) === item.itemKey)!;
    state.decisions[item.itemKey] = { answer: {
      verdict: item.verdict, targetId: item.targetId, duplicateIds: [], reason: item.reason,
      evidence: [], corrections: [], split: null,
    }, evidence: [
      ...(r.providedEvidence ?? []),
      ...item.evidenceRefs.map(sourceKey => ({ sourceKey })),
    ] };
  }
}
export async function lightBatch(domain: "organization" | "person", state: NormalizationState,
  resolution: Resolution, ctx: Context, research: Researcher): Promise<NormalizationState> {
  const next = clone(state), metrics = resolution.metrics, started = Date.now();
  const requests = Object.values(next.requests).filter(r => r.kind === `${domain}_identity`);
  if (requests.length) {
    const outcome = await research({ kind: "normalization_light", subjectRef: domain,
      question: "整组全量 unresolved，一次逐项判断。仅基于证据匹配普通变体/身份；同名或同所属本身不足以确认同人；不同出生日期不可match；不合并拆分。",
      context: { items: itemsFor(requests, ctx) }, allowedIds: [], allowNetwork: false,
    }, metrics);
    const items = requireBatch(outcome, requests, ctx);
    saveItems(next, requests, items);
    stage(metrics, `${domain}_light_batch`, requests.length, items.filter(i => i.verdict !== "unresolved").length, started);
  } else stage(metrics, `${domain}_light_batch`, 0, 0, started);
  return next;
}
export async function crossCheck(input: BatchInput, ctx: Context, state: NormalizationState,
  resolution: Resolution, research: Researcher): Promise<NormalizationState> {
  const next = clone(state), started = Date.now();
  if (!input.rows.length && !input.organizations.length) {
    stage(resolution.metrics, "normalization_cross_check", 0, 0, started); return next;
  }
  const outcome = await research({ kind: "normalization_cross_check", subjectRef: input.raceSlug,
    question: "检查暂定组织与人物结论的矛盾/循环证据。只提出问题，不作合并拆分。组织问题引用source:组织key，人物列出该组织的来源行key。没有问题返回issues空数组。",
    context: { organizations: input.organizations, rows: input.rows,
      organizationMap: resolution.organizationMap, personMap: resolution.personMap,
      decisions: state.decisions, items: itemsFor(Object.values(state.requests), ctx),
      organizationEvidence: input.organizations.map(o => ({ key: `source:${o.key}`, input: o, candidates: ctx.organizations })),
    }, allowedIds: [], allowNetwork: false,
  }, resolution.metrics);
  if (!outcome.crossAnswer) {
    if (!["research_budget_exhausted", "research_not_configured"].includes(outcome.stopReason ?? ""))
      throw new Error(`Cross-check model failure: ${outcome.stopReason ?? "missing_cross_answer"}`);
    next.issues = [];
  } else next.issues = crossAnswerSchema.parse(outcome.crossAnswer).issues;
  stage(resolution.metrics, "normalization_cross_check", input.rows.length, 0, started);
  return next;
}
export function validateCrossCheck(input: BatchInput, state: NormalizationState, ctx?: Context): NormalizationState {
  const next = clone(state);
  const seen = new Set<string>();
  const refs = new Set([
    ...input.organizations.map(o => `source:${o.key}`),
    ...Object.values(state.requests).map(r => `source:${r.subjectRef}`),
    ...(ctx?.historicalResults ?? []).map(h => `result:${h.id}`),
    ...(ctx?.historicalReferences ?? []).map(h => `reference:${h.id}`),
    ...input.rows.map(r => `source:${r.key}`),
    ...(ctx?.memberships ?? []).map(m => `membership:${m.id}`),
  ]);
  for (const issue of state.issues) {
    if (seen.has(issue.issueKey) || !input.organizations.some(o => o.key === issue.organizationKey) ||
      issue.personKeys.some(k => !input.rows.some(r => r.key === k && r.organizationKey === issue.organizationKey)) ||
      !issue.evidenceRefs.length || issue.evidenceRefs.some(ref => !refs.has(ref)))
      throw new Error("Cross-check returned unsupported issue scope/evidence");
    seen.add(issue.issueKey);
    if (["unresolved", "research"].includes(issue.suggestedAction) || issue.issueType === "circular_evidence") {
      for (const personKey of issue.personKeys) {
        const key = `person_identity:${personKey}`;
        if (next.requests[key]) next.decisions[key] = { answer: {
          verdict: "unresolved", targetId: null, duplicateIds: [], reason: issue.reason,
          evidence: [], corrections: [], split: null,
        }, evidence: [] };
      }
    }
  }
  return next;
}
export async function adjudicate(input: BatchInput, ctx: Context, state: NormalizationState,
  resolution: Resolution, research: Researcher): Promise<NormalizationState> {
  const next = clone(state), started = Date.now();
  const orgKeys = [...new Set(state.issues.filter(i => i.suggestedAction === "review_organization").map(i => i.organizationKey))];
  const requests: ResearchRequest[] = orgKeys.map(key => {
    const org = input.organizations.find(o => o.key === key)!;
    // Independent organization-only evidence. No tentative person assignments are supplied.
    const candidates = ctx.organizations.filter(o =>
      (org.type === "unknown" || o.type === "unknown" || o.type === org.type) &&
      normalizeName(o.nameJa).slice(0, 2) === normalizeName(org.name).slice(0, 2));
    return { kind: "organization_identity", subjectRef: key, question: "组织独立证据裁决",
      context: { input: org, candidates }, allowedIds: candidates.map(o => o.id),
      providedEvidence: [{ sourceId: input.sourceId, sourceKey: org.sourceKey ?? key }] };
  });
  if (requests.length) {
    const outcome = await research({ kind: "organization_adjudication", subjectRef: input.raceSlug,
      question: "一次组织补充裁决。仅根据组织名称及独立来源确认普通变体；不能使用选手同人判断作为组织相同的证据；不足则unresolved。",
      context: { items: itemsFor(requests, { ...ctx, memberships: [], historicalResults: [], historicalReferences: [] }) }, allowedIds: [], allowNetwork: false,
    }, resolution.metrics);
    const items = requireBatch(outcome, requests, { ...ctx, memberships: [], historicalResults: [], historicalReferences: [] });
    saveItems(next, requests, items);
    for (const item of items) {
      const r = requests.find(r => keyOf(r) === item.itemKey)!;
      if (item.verdict === "match" && item.targetId && resolution.organizationMap[r.subjectRef] !== item.targetId)
        next.organizationOverrides[r.subjectRef] = item.targetId;
    }
  }
  const changed = Object.keys(next.organizationOverrides).filter(k => resolution.organizationMap[k] !== next.organizationOverrides[k]);
  next.affectedPersonKeys = input.rows.filter(r => r.organizationKey && changed.includes(r.organizationKey)).map(r => r.key);
  for (const personKey of next.affectedPersonKeys) {
    delete next.decisions[`person_identity:${personKey}`];
    delete next.requests[`person_identity:${personKey}`];
  }
  stage(resolution.metrics, "organization_adjudication", requests.length, changed.length, started);
  return next;
}
export async function reassess(input: BatchInput, ctx: Context, state: NormalizationState,
  resolution: Resolution, research: Researcher): Promise<NormalizationState> {
  const next = clone(state), started = Date.now();
  const requests = Object.values(state.requests).filter(r => r.kind === "person_identity" && state.affectedPersonKeys.includes(r.subjectRef));
  if (requests.length) {
    const outcome = await research({ kind: "normalization_light", subjectRef: "affected_person_reassessment",
      question: "组织已由独立证据修正，只重评受影响选手一次；仍不能仅同名同所属确认同人。",
      context: { items: itemsFor(requests, ctx), organizationMap: resolution.organizationMap }, allowedIds: [], allowNetwork: false,
    }, resolution.metrics);
    const items = requireBatch(outcome, requests, ctx);
    saveItems(next, requests, items);
    stage(resolution.metrics, "affected_person_reassessment", requests.length, items.filter(i => i.verdict !== "unresolved").length, started);
  } else stage(resolution.metrics, "affected_person_reassessment", 0, 0, started);
  return next;
}
export async function deepResearch(state: NormalizationState, resolution: Resolution, research: Researcher): Promise<NormalizationState> {
  const next = clone(state), started = Date.now(); let count = 0;
  for (const r of Object.values(state.requests)) {
    const answer = state.decisions[keyOf(r)]?.answer;
    // Network research stays restricted to actual competing identities, not empty profiles.
    if (answer && answer.verdict !== "unresolved") continue;
    const candidates = (r.context as { candidates?: unknown[] }).candidates ?? [];
    const context = r.context as { row?: { birthDate?: string }; candidates?: Array<{ birthDate?: string }> };
    const birthConflict = context.row?.birthDate && context.candidates?.some(c => c.birthDate && c.birthDate !== context.row!.birthDate);
    if (candidates.length < 2 && !birthConflict) continue;
    const outcome = await research({ ...r, allowNetwork: true }, resolution.metrics);
    if (!outcome.answer && !["research_budget_exhausted", "research_not_configured", "research_scope_too_large", "identity_footprint_too_large"].includes(outcome.stopReason ?? ""))
      throw new Error(`Deep research model failure: ${outcome.stopReason ?? "missing_answer"}`);
    next.decisions[keyOf(r)] = outcome; count++;
  }
  stage(resolution.metrics, "normalization_deep_research", count, 0, started);
  return next;
}

export function finalizeNormalization(input: BatchInput, state: NormalizationState, resolution: Resolution): Resolution {
  const result = clone(resolution);
  result.metrics.normalizationSummary = {
    crossCheckIssues: state.issues.length,
    organizationCorrections: Object.keys(state.organizationOverrides).length,
    affectedPeople: new Set(state.affectedPersonKeys).size,
    reassessedPeople: resolution.metrics.normalizationStages?.find(s => s.stage === "affected_person_reassessment")?.inputCount ?? 0,
    affectedPeopleResolved: state.affectedPersonKeys.filter(k => !result.findings.some(f => f.subjectRef === k && f.status === "unresolved")).length,
  };
  for (const issue of state.issues) {
    if (issue.suggestedAction === "keep") continue;
    const corrected = !!state.organizationOverrides[issue.organizationKey];
    const peopleResolved = issue.personKeys.every(k => !result.findings.some(f => f.subjectRef === k && f.status === "unresolved"));
    result.findings.push({ key: `cross:${issue.issueKey}`, code: issue.issueType,
      subjectRef: issue.organizationKey, severity: "serious",
      status: corrected && peopleResolved ? "resolved" : "unresolved",
      reason: issue.reason, evidence: issue.evidenceRefs.map(sourceKey => ({ sourceId: input.sourceId, sourceKey })),
    });
  }
  return result;
}
