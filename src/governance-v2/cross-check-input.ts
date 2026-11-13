import type { BatchInput, Context, Resolution } from "./contracts.js";
import type { NormalizationState } from "./normalization.js";
import { normalizeName, normalizeOrganizationName } from "./rules.js";

// Relevance is recall, never an identity verdict: retain conflicting same-name
// people and every candidate already considered by the normalization stages.
export function buildCrossCheckInput(input: BatchInput, ctx: Context,
  state: NormalizationState, resolution: Resolution) {
  const requests = Object.values(state.requests);
  const peopleIds = new Set(Object.values(resolution.personMap));
  const organizationIds = new Set(Object.values(resolution.organizationMap));
  const items = requests.map(r => {
    const ids = r.kind === "organization_identity" ? organizationIds : peopleIds;
    r.allowedIds.forEach(id => ids.add(id));
    const d = state.decisions[`${r.kind}:${r.subjectRef}`];
    if (d?.answer?.targetId) ids.add(d.answer.targetId);
    return { itemKey: `${r.kind}:${r.subjectRef}`, candidateIds: [...new Set(r.allowedIds)],
      verdict: d?.answer?.verdict ?? "pending", targetId: d?.answer?.targetId ?? null,
      reason: d?.answer?.reason, evidence: d?.evidence ?? [], stopReason: d?.stopReason };
  });
  const rows = input.rows.map(row => {
    const names = [row.name, row.kana, row.roman].filter((n): n is string => !!n).map(normalizeName);
    const candidates = ctx.people.filter(p => [p.displayNameJa, ...(p.aliases ?? [])].some(n => names.includes(normalizeName(n))));
    candidates.forEach(p => peopleIds.add(p.id));
    return { ...row, evidenceRef: `source:${row.key}`, provisionalPersonId: resolution.personMap[row.key], candidateIds: candidates.map(p => p.id) };
  });
  const organizations = input.organizations.map(org => {
    const name = normalizeName(org.name);
    const candidates = ctx.organizations.filter(o =>
      (org.type === "unknown" || o.type === "unknown" || o.type === org.type) &&
      ([o.nameJa, ...(o.aliases ?? [])].some(n => normalizeOrganizationName(n) === normalizeOrganizationName(org.name)) ||
        (!!org.slug && o.slug === org.slug) || (!!name && normalizeName(o.nameJa).startsWith(name.slice(0, 2)))));
    candidates.forEach(o => organizationIds.add(o.id));
    return { ...org, evidenceRef: `source:${org.key}`, provisionalOrganizationId: resolution.organizationMap[org.key], candidateIds: candidates.map(o => o.id) };
  });
  const evidence = new Map<string, { key: string; kind: string; value: unknown }>();
  const add = (key: string, kind: string, value: unknown) => evidence.set(key, { key, kind, value });
  // Source facts live once in rows/organizations; evidence entries reference them.
  for (const org of input.organizations) add(`source:${org.key}`, "source", { organizationKey: org.key, sourceId: input.sourceId, sourceKey: org.sourceKey });
  for (const row of input.rows) add(`source:${row.key}`, "source", { rowKey: row.key, sourceId: input.sourceId, sourceKey: row.sourceKey, url: row.sourceUrl });
  for (const r of requests) {
    const key = `source:${r.subjectRef}`;
    const current = evidence.get(key);
    add(key, "source", { source: current?.value, providedEvidence: r.providedEvidence ?? [] });
  }
  for (const m of ctx.memberships.filter(m => peopleIds.has(m.personId))) {
    organizationIds.add(m.organizationId); add(`membership:${m.id}`, "membership", m);
  }
  for (const h of ctx.historicalResults ?? []) if (peopleIds.has(h.personId)) {
    if (h.organizationId) organizationIds.add(h.organizationId);
    add(`result:${h.id}`, "historical_result", h);
  }
  for (const h of ctx.historicalReferences ?? []) if (peopleIds.has(h.personId)) add(`reference:${h.id}`, "source_reference", h);
  const people = ctx.people.filter(p => peopleIds.has(p.id));
  const catalogOrganizations = ctx.organizations.filter(o => organizationIds.has(o.id));
  return {
    overview: { raceSlug: input.raceSlug, raceDate: ctx.raceDate, sourceId: input.sourceId,
      unitType: input.unitType, unitKey: input.unitKey, rowCount: rows.length, organizationCount: organizations.length,
      loadedPeopleCount: ctx.people.length, includedPeopleCount: people.length,
      loadedOrganizationCount: ctx.organizations.length, includedOrganizationCount: catalogOrganizations.length,
      historyScope: "Relevant records from loaded context only; not full database history. No evidence is fetched by this node.",
      historyLimitPerPerson: 10,
      historyMayBeTruncatedFor: people.filter(p => (ctx.historicalResults?.filter(h => h.personId === p.id).length ?? 0) > 10 ||
        (ctx.historicalReferences?.filter(h => h.personId === p.id).length ?? 0) > 10).map(p => p.id),
    },
    rows, organizations, items,
    catalog: { people, organizations: catalogOrganizations, evidence: [...evidence.values()],
      sourceMappings: ctx.sourceMappings.filter(m => (m.personId && peopleIds.has(m.personId)) || (m.organizationId && organizationIds.has(m.organizationId))) },
  };
}
