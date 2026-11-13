import {
  emptyMetrics,
  type AgentResult,
  type BatchInput,
  type Change,
  type Context,
  type Finding,
  type Manifest,
  type Membership,
  type Operation,
  type Plan,
  type Resolution,
  type Window,
} from "./contracts.js";
import {
  academicWindow,
  adjacentSchoolWindow,
  fillUnknownDates,
  fingerprint,
  markMillis,
  membershipConflict,
  normalizeName,
  normalizeOrganizationName,
  shouldUpdatePB,
  stableId,
} from "./rules.js";
import type { Researcher } from "./research.js";

function change(
  batchId: string,
  key: string,
  operation: Operation,
  agentKey: string,
  reason: string,
  versions: Record<string, string> = {},
): Change {
  return {
    key,
    idempotencyKey: fingerprint({ batchId, key, operation }),
    operation,
    expectedVersions: versions,
    reason,
    evidence: [],
    agentKey,
  };
}
function unresolved(
  key: string,
  subjectRef: string,
  reason: string,
  code = "identity_unresolved",
): Finding {
  return {
    key,
    subjectRef,
    code,
    severity: "serious",
    status: "unresolved",
    reason,
    evidence: [],
  };
}
function versions(
  context: Context,
  personIds: string[] = [],
  orgIds: string[] = [],
) {
  return Object.fromEntries(
    [
      ...context.people
        .filter((p) => personIds.includes(p.id))
        .map((p) => [`person:${p.id}`, p.updatedAt]),
      ...context.organizations
        .filter((o) => orgIds.includes(o.id))
        .map((o) => [`organization:${o.id}`, o.updatedAt]),
    ].filter((p): p is [string, string] => !!p[1]),
  );
}
function canonicalEntity(
  res: Resolution,
  id: string,
  kind: "person" | "organization",
): string {
  let current = id;
  for (const change of res.changes) {
    const op = change.operation;
    if (
      op.kind === `merge_${kind}` &&
      "duplicateId" in op &&
      op.duplicateId === current
    )
      current = op.canonicalId;
  }
  return current;
}
export async function normalizeOrganizations(
  batchId: string,
  input: BatchInput,
  ctx: Context,
  research: Researcher,
  light = false,
  overrides: Record<string, string> = {},
): Promise<Resolution> {
  const started = Date.now(),
    out: Resolution = {
      organizationMap: {},
      personMap: {},
      findings: [],
      changes: [],
      metrics: emptyMetrics(),
    };
  const resolved = new Map<string, string>();
  for (const org of input.organizations) {
    out.metrics.ruleDecisions++;
    const name = normalizeName(org.name),
      identity = `${name}:${org.type}`;
    const mapped = ctx.sourceMappings.find(
      (m) =>
        m.sourceId === input.sourceId &&
        m.entityType === "organization" &&
        m.sourceKey === (org.sourceKey ?? `org:${name}`),
    )?.organizationId;
    const candidates = ctx.organizations.filter(
      (o) =>
        [o.nameJa, ...(o.aliases ?? [])].some(
          (n) =>
            normalizeOrganizationName(n) ===
            normalizeOrganizationName(org.name),
        ) &&
        (org.type === "unknown" || o.type === "unknown" || o.type === org.type),
    );
    let id =
      overrides[org.key] ?? mapped ??
      resolved.get(identity) ??
      (candidates.length === 1 ? candidates[0].id : undefined);
    if (!id && candidates.length === 0) {
      const recalled = ctx.organizations.filter(
        (o) =>
          (o.slug === org.slug ||
            normalizeName(o.nameJa).startsWith(name.slice(0, 2))) &&
          (org.type === "unknown" || o.type === org.type),
      );
      if (recalled.length && (light || recalled.length <= 8)) {
        const r = await research(
          {
            kind: "organization_identity",
            subjectRef: org.key,
            question:
              "判断来源名称是否是候选组织的普通简称或变体；只使用现有资料，不联网。",
            context: { input: org, candidates: recalled },
            allowedIds: recalled.map((o) => o.id),
            allowNetwork: false,
            providedEvidence: [
              { sourceId: input.sourceId, sourceKey: org.sourceKey ?? org.key },
            ],
          },
          out.metrics,
        );
        if (r.answer?.verdict === "match" && r.answer.targetId)
          id = r.answer.targetId;
        else if (r.answer?.verdict !== "distinct")
          out.findings.push(
            unresolved(
              `org:${org.key}`,
              org.key,
              `${r.answer?.reason ?? r.stopReason ?? "普通名称匹配无法确定"}；先保存来源组织，不为简称自动联网。`,
            ),
          );
      }
    }
    if (
      !id &&
      candidates.length > 1 &&
      new Set(candidates.map((c) => c.type)).size === 1
    ) {
      const r = await research(
        {
          kind: "organization_identity",
          subjectRef: org.key,
          question:
            "同名同类型组织存在多个档案，误合并或误拆分会影响所属和成绩，请确定规范组织或保持不同组织。",
          context: { input: org, candidates },
          allowedIds: candidates.map((c) => c.id),
        },
        out.metrics,
      );
      if (
        r.answer &&
        ["match", "merge"].includes(r.answer.verdict) &&
        r.answer.targetId
      ) {
        id = r.answer.targetId;
        if (r.answer.verdict === "merge")
          for (const duplicateId of r.answer.duplicateIds)
            if (duplicateId !== id)
              out.changes.push({
                ...change(
                  batchId,
                  `merge_org:${duplicateId}`,
                  {
                    kind: "merge_organization",
                    canonicalId: id,
                    duplicateId,
                    evidence: r.evidence,
                  },
                  "normalization",
                  "研究证据支持组织归一",
                  versions(ctx, [], [id, duplicateId]),
                ),
                evidence: r.evidence,
              });
      } else
        out.findings.push({
          ...unresolved(
            `org:${org.key}`,
            org.key,
            `${r.answer?.reason ?? r.stopReason ?? "无法确定组织"}；保留独立来源组织，不任意归入候选。`,
          ),
          evidence: r.evidence,
        });
    }
    if (!id) {
      id = stableId(input.sourceId, "organization", org.sourceKey ?? identity);
      const entity = {
        id,
        slug: org.slug ?? `organization-${id}`,
        nameJa: org.name,
        type: org.type,
      };
      out.changes.push(
        change(
          batchId,
          `create_org:${id}`,
          { kind: "create_organization", entity },
          "normalization",
          "来源明确提供的组织，无可确定的现有归属",
        ),
      );
    }
    const canonical = ctx.organizations.find((o) => o.id === id);
    if (
      canonical &&
      normalizeName(canonical.nameJa) !== name &&
      !canonical.aliases?.some((v) => normalizeName(v) === name)
    )
      out.changes.push(
        change(
          batchId,
          `org_alias:${id}:${name}`,
          {
            kind: "name_variant",
            entityType: "organization",
            targetId: id,
            value: org.name,
          },
          "normalization",
          "保留已确认组织名称变体",
        ),
      );
    out.organizationMap[org.key] = id;
    resolved.set(identity, id);
    if (mapped !== id)
      out.changes.push(
        change(
          batchId,
          `org_ref:${org.sourceKey ?? name}`,
          {
            kind: "source_mapping",
            entityType: "organization",
            sourceKey: org.sourceKey ?? `org:${name}`,
            targetId: id,
          },
          "normalization",
          "保存组织来源映射",
        ),
      );
  }
  out.metrics.durationMs = Date.now() - started;
  return out;
}
export async function normalizePeople(
  batchId: string,
  input: BatchInput,
  ctx: Context,
  orgs: Resolution,
  research: Researcher,
  light = false,
  forceReview: ReadonlySet<string> = new Set(),
): Promise<Resolution> {
  const started = Date.now(),
    out: Resolution = {
      organizationMap: orgs.organizationMap,
      personMap: {},
      findings: [...orgs.findings],
      changes: [...orgs.changes],
      metrics: {
        ...orgs.metrics,
        stoppedReasons: [...orgs.metrics.stoppedReasons],
        normalizationRuleMatches: [],
      },
    };
  const stableMatches = new Map<string, string>();
  for (const row of input.rows) {
    out.metrics.ruleDecisions++;
    let sourceKey = row.sourceKey ?? `${input.raceSlug}:${row.key}`,
      entityType: "person" | "governance_person_observation" = row.sourceKey
        ? "person"
        : "governance_person_observation";
    const mapped = ctx.sourceMappings.find(
      (m) =>
        m.sourceId === input.sourceId &&
        m.entityType === entityType &&
        m.sourceKey === sourceKey,
    )?.personId;
    let candidates = ctx.people.filter((p) =>
      [p.displayNameJa, p.displayNameKana, ...(p.aliases ?? [])].filter((n): n is string => !!n).some((n) =>
        [row.name, row.kana, row.roman]
          .filter((v): v is string => !!v)
          .some((v) => normalizeName(n) === normalizeName(v)),
      ),
    );
    if (row.birthDate)
      candidates = candidates.filter(
        (p) => !p.birthDate || p.birthDate === row.birthDate,
      );
    if (mapped && !candidates.some((p) => p.id === mapped)) {
      const mappedPerson = ctx.people.find((p) => p.id === mapped);
      if (mappedPerson) candidates.push(mappedPerson);
    }
    const orgId = row.organizationKey
      ? orgs.organizationMap[row.organizationKey]
      : undefined;
    // Historical schools identify a person even when the current race is at university.
    const hintedOrganizations = new Set(
      [
        orgId,
        ...row.memberships.map((m) => orgs.organizationMap[m.organizationKey]),
      ].filter((id): id is string => !!id),
    );
    const contradictoryCohort = (p: Context["people"][number]) => {
      const memberships = ctx.memberships.filter((m) => m.personId === p.id);
      return memberships.some((m) => {
        if (m.organizationId !== orgId || m.organizationType !== "university")
          return false;
        const hint = row.memberships.find(
          (h) => orgs.organizationMap[h.organizationKey] === orgId,
        );
        const window = academicWindow(
          "university",
          hint?.grade ?? row.grade,
          ctx.raceDate,
        );
        if (
          m.startBasis === "source" &&
          m.startDate &&
          window?.startDate &&
          m.startDate !== window.startDate
        )
          return true;
        return (
          !!ctx.raceDate &&
          ((m.startBasis === "source" &&
            !!m.startDate &&
            m.startDate > ctx.raceDate) ||
            (m.endBasis === "source" &&
              !!m.endDate &&
              m.endDate < ctx.raceDate))
        );
      });
    };
    const contextual = candidates.filter(p => !contradictoryCohort(p) &&
      ctx.memberships.some(m => m.personId === p.id && hintedOrganizations.has(m.organizationId)));
    // A historical entry is identity evidence even for DNS. It never proves a
    // start, grade or Membership. Only compare independently canonicalized IDs.
    const exactNameKana = candidates.filter(p => row.kana && normalizeName(p.displayNameJa) === normalizeName(row.name) &&
      [p.displayNameKana, ...(p.aliases ?? [])].some(v => !!v && normalizeName(v) === normalizeName(row.kana!)));
    const historical = (exactNameKana.length === 1 ? exactNameKana : []).flatMap(p => {
      if (contradictoryCohort(p) || !orgId || !ctx.organizations.some(o => o.id === orgId)) return [];
      const records = (ctx.historicalResults ?? []).filter(h => h.personId === p.id &&
        h.organizationId === orgId && h.raceId !== ctx.raceId && !!h.sourceId &&
        !!h.raceDate && !!ctx.raceDate && h.raceDate <= ctx.raceDate);
      return records.length ? [{ person: p, records }] : [];
    });
    const historicalMatch = historical.length === 1 &&
      contextual.every(p => p.id === historical[0].person.id) ? historical[0] : undefined;
    let confirmedDistinct = false;
    let id =
      mapped ??
      stableMatches.get(sourceKey) ??
      historicalMatch?.person.id ??
      (historical.length === 0 && contextual.length === 1
        ? contextual[0].id
        : row.birthDate &&
            candidates.filter((p) => p.birthDate === row.birthDate).length === 1
          ? candidates.find((p) => p.birthDate === row.birthDate)!.id
          : undefined);
    if (
      mapped &&
      row.birthDate &&
      ctx.people.find((p) => p.id === mapped)?.birthDate &&
      ctx.people.find((p) => p.id === mapped)?.birthDate !== row.birthDate
    )
      id = undefined;
    if (forceReview.has(row.key)) id = undefined;
    if (id && historicalMatch?.person.id === id && !mapped && !forceReview.has(row.key)) {
      out.metrics.normalizationRuleMatches!.push({ subjectRef: row.key, targetId: id,
        rule: "exact_name_kana_historical_organization",
        evidenceRefs: [`source:${row.key}`, ...historicalMatch.records.map(h => `result:${h.id}`)],
        weakerCandidateIds: candidates.filter(p => p.id !== id).map(p => p.id) });
    }
    // Research requires an actual competing attribution, not a mere empty field/name variation.
    if (
      !id &&
      (candidates.length || forceReview.has(row.key)) &&
      (light || contextual.length > 1 ||
        !!mapped ||
        (candidates.length === 1 &&
          ctx.memberships.some(
            (m) =>
              m.personId === candidates[0].id &&
              m.organizationType === "university",
          ) &&
          input.rows.some(
            (r) =>
              r.key === row.key &&
              r.memberships.some(
                (m) =>
                  input.organizations.find((o) => o.key === m.organizationKey)
                    ?.type === "university",
              ),
          )))
    ) {
      const r = await research(
        {
          kind: "person_identity",
          subjectRef: row.key,
          question:
            "来源身份与存量履历存在竞争归属，确认同人或不同人；不要仅凭同名合并。",
          context: {
            row,
            affiliation: { source: input.organizations.find(o => o.key === row.organizationKey),
              organizationId: orgId, canonical: ctx.organizations.find(o => o.id === orgId) },
            candidates,
            memberships: ctx.memberships.filter((m) =>
              candidates.some((p) => p.id === m.personId),
            ),
          },
          allowedIds: candidates.map((p) => p.id),
        },
        out.metrics,
      );
      if (r.answer?.targetId && ["match", "merge"].includes(r.answer.verdict)) {
        id = r.answer.targetId;
        if (r.answer.verdict === "merge")
          for (const duplicateId of r.answer.duplicateIds)
            if (duplicateId !== id)
              out.changes.push({
                ...change(
                  batchId,
                  `merge_person:${duplicateId}`,
                  {
                    kind: "merge_person",
                    canonicalId: id,
                    duplicateId,
                    evidence: r.evidence,
                  },
                  "normalization",
                  "研究证据支持同人归一",
                  versions(ctx, [id, duplicateId]),
                ),
                evidence: r.evidence,
              });
      } else if (r.answer?.verdict === "split" && r.answer.split) {
        const split = r.answer.split;
        id = stableId(input.sourceId, "split", sourceKey);
        const target = {
          id,
          slug: `person-${id}`,
          displayNameJa: split.name,
          birthDate: row.birthDate,
        };
        out.changes.push({
          ...change(
            batchId,
            `split_person:${split.fromPersonId}:${id}`,
            {
              kind: "split_person",
              fromPersonId: split.fromPersonId,
              target,
              raceResultIds: split.raceResultIds,
              membershipIds: split.membershipIds,
              sourceReferenceIds: split.sourceReferenceIds,
              evidence: r.evidence,
            },
            "normalization",
            "研究证据支持拆分混合人物档案",
            versions(ctx, [split.fromPersonId]),
          ),
          evidence: r.evidence,
        });
      } else if (r.answer?.verdict === "distinct") {
        confirmedDistinct = true;
      } else
        out.findings.push({
          ...unresolved(
            `person:${row.key}`,
            row.key,
            `${r.answer?.reason ?? r.stopReason ?? "无法确定身份"}；采用独立来源档案，保留后续修正依据。`,
          ),
          evidence: r.evidence,
        });
    }
    if (mapped && id !== mapped) {
      sourceKey = `${input.raceSlug}:${row.key}`;
      entityType = "governance_person_observation";
    }
    if (!id) {
      id = stableId(input.sourceId, "person", sourceKey);
      out.changes.push(
        change(
          batchId,
          `create_person:${id}`,
          {
            kind: "create_person",
            entity: {
              id,
              slug: row.slug ?? `person-${id}`,
              displayNameJa: row.name,
              birthDate: row.birthDate,
            },
          },
          "normalization",
          "来源选手没有可确定的存量归属",
        ),
      );
      if (
        candidates.length &&
        !confirmedDistinct &&
        !out.findings.some((f) => f.subjectRef === row.key)
      )
        out.findings.push(
          unresolved(
            `person:${row.key}`,
            row.key,
            "同名资料不足以确认同人，先保留独立来源档案，不为普通所属补查网络。",
          ),
        );
    }
    const canonical = ctx.people.find((p) => p.id === id);
    if (
      canonical &&
      normalizeName(canonical.displayNameJa) !== normalizeName(row.name) &&
      !canonical.aliases?.some(
        (v) => normalizeName(v) === normalizeName(row.name),
      )
    )
      out.changes.push(
        change(
          batchId,
          `person_alias:${id}:${normalizeName(row.name)}`,
          {
            kind: "name_variant",
            entityType: "person",
            targetId: id,
            value: row.name,
          },
          "normalization",
          "保留已确认人物名称变体",
        ),
      );
    out.personMap[row.key] = id;
    stableMatches.set(sourceKey, id);
    if (mapped !== id || row.sourceUrl)
      out.changes.push(
        change(
          batchId,
          `person_ref:${sourceKey}`,
          {
            kind: "source_mapping",
            entityType,
            sourceKey,
            targetId: id,
            sourceUrl: row.sourceUrl,
          },
          "normalization",
          "保存来源身份映射",
        ),
      );
    const ruleMatch = out.metrics.normalizationRuleMatches!.find(m => m.subjectRef === row.key);
    if (ruleMatch) {
      const mapping = out.changes.find(c => c.operation.kind === "source_mapping" &&
        c.operation.sourceKey === sourceKey && c.operation.targetId === id);
      if (mapping) {
        mapping.reason += "；规则：姓名及假名一致，唯一强候选的历史报名所属一致（DNS亦可作为身份依据）";
        mapping.evidence = ruleMatch.evidenceRefs.map(sourceKey => ({ sourceKey }));
      }
    }
  }
  out.metrics.durationMs += Date.now() - started;
  return out;
}
export async function governMemberships(
  batchId: string,
  input: BatchInput,
  ctx: Context,
  res: Resolution,
  research: Researcher,
): Promise<AgentResult> {
  const started = Date.now(),
    out: AgentResult = {
      agentKey: "membership",
      skipped: false,
      findings: [],
      changes: [],
      metrics: emptyMetrics(),
    };
  const orgTypes = new Map([
    ...ctx.organizations.map((o) => [o.id, o.type] as const),
    ...input.organizations.map(
      (o) => [res.organizationMap[o.key], o.type] as const,
    ),
  ]);
  const all = new Map(
    ctx.memberships.map((m) => {
      const split = res.changes
        .map((c) => c.operation)
        .find(
          (o) => o.kind === "split_person" && o.membershipIds.includes(m.id),
        );
      return [
        m.id,
        {
          ...m,
          personId:
            split?.kind === "split_person"
              ? split.target.id
              : canonicalEntity(res, m.personId, "person"),
          organizationId: canonicalEntity(
            res,
            m.organizationId,
            "organization",
          ),
        },
      ];
    }),
  );
  const affected = new Set(Object.values(res.personMap));
  for (const row of input.rows) {
    const personId = res.personMap[row.key];
    for (const hint of row.memberships) {
      out.metrics.ruleDecisions++;
      const organizationId = res.organizationMap[hint.organizationKey];
      const existing = [...all.values()].filter(
        (m) =>
          m.personId === personId &&
          m.organizationId === organizationId &&
          m.type === hint.type,
      );
      if (existing.length > 1) {
        out.findings.push(
          unresolved(
            `membership_duplicate:${personId}:${organizationId}`,
            personId,
            "同一组织存在多段履历，不能仅凭组织相同折叠或覆盖；保留现有记录与来源线索。",
            "membership_unresolved",
          ),
        );
        continue;
      }
      let window: Window = {
        startDate: hint.startDate,
        endDate: hint.endDate,
        startBasis: hint.startDate ? "source" : "unknown",
        endBasis: hint.endDate ? "source" : "unknown",
        endState: hint.endState,
        evidence: { sourceId: input.sourceId, rowKey: row.key },
      };
      const inferred = academicWindow(
        orgTypes.get(organizationId) ?? "unknown",
        hint.grade ??
          (row.organizationKey === hint.organizationKey
            ? row.grade
            : undefined),
        ctx.raceDate,
      );
      if (inferred) window = fillUnknownDates(window, inferred);
      const m: Membership = {
        id: existing[0]?.id ?? stableId(personId, organizationId, hint.type),
        personId,
        organizationId,
        type: hint.type,
        organizationType: orgTypes.get(organizationId) ?? "unknown",
        exclusivityGroup:
          hint.exclusivityGroup ?? existing[0]?.exclusivityGroup,
        ...window,
      };
      if (existing[0]) {
        if (
          (hint.startDate &&
            existing[0].startDate &&
            hint.startDate !== existing[0].startDate &&
            existing[0].startBasis !== "inferred") ||
          (hint.endDate &&
            existing[0].endDate &&
            hint.endDate !== existing[0].endDate &&
            existing[0].endBasis !== "inferred")
        ) {
          out.findings.push(
            unresolved(
              `membership_date:${m.id}`,
              m.id,
              "新来源日期与现有履历不一致；保留既有时间线，交由冲突研究处理。",
              "membership_conflict",
            ),
          );
        }
        Object.assign(m, fillUnknownDates(existing[0], window));
      }
      all.set(m.id, m);
    }
  }
  // New anchors improve the involved stored memberships as well as this batch's new relation.
  for (const m of all.values())
    if (affected.has(m.personId)) {
      if (
        (!m.startDate || !m.endDate) &&
        [...all.values()].filter(
          (x) =>
            x.personId === m.personId &&
            x.type === m.type &&
            x.organizationType === m.organizationType,
        ).length === 1
      ) {
        const inferred = adjacentSchoolWindow(
          m.organizationType,
          [...all.values()].filter((x) => x.personId === m.personId),
        );
        if (inferred) Object.assign(m, fillUnknownDates(m, inferred));
      }
      if (m.startDate && m.endDate && m.startDate > m.endDate)
        out.findings.push(
          unresolved(
            `membership_invalid:${m.id}`,
            m.id,
            "履历起止顺序无效，需要来源核验；不应用无效时间窗口。",
            "membership_conflict",
          ),
        );
      for (const other of all.values())
        if (m.id < other.id && membershipConflict(m, other))
          out.findings.push(
            unresolved(
              `membership_overlap:${m.id}:${other.id}`,
              m.personId,
              "同一学段不同学校的明确来源时间重叠，现有规则无法解释。",
              "membership_conflict",
            ),
          );
    }
  const conflicts = out.findings.filter(
    (f) => f.code === "membership_conflict",
  );
  for (const f of conflicts) {
    const relevant = [...all.values()].filter(
      (m) => m.personId === f.subjectRef || m.id === f.subjectRef,
    );
    const r = await research(
      {
        kind: "membership_conflict",
        subjectRef: f.subjectRef,
        question: f.reason,
        context: {
          memberships: relevant,
          inputHints: input.rows.filter((row) =>
            relevant.some((m) => m.personId === res.personMap[row.key]),
          ),
        },
        allowedIds: relevant.map((m) => m.id),
      },
      out.metrics,
    );
    if (
      r.answer?.verdict === "correct_membership" &&
      r.answer.corrections.length
    ) {
      let applied = false;
      for (const correction of r.answer.corrections) {
        const m = all.get(correction.membershipId);
        if (!m || !relevant.some((x) => x.id === m.id)) continue;
        const start = correction.startDate ?? m.startDate,
          end = correction.endDate ?? m.endDate;
        if (start && end && start > end) continue;
        all.set(m.id, {
          ...m,
          startDate: start,
          endDate: end,
          startBasis: correction.startDate ? "source" : m.startBasis,
          endBasis: correction.endDate ? "source" : m.endBasis,
          evidence: { research: r.evidence },
        });
        applied = true;
      }
      if (
        applied &&
        ![...all.values()].some((m, i, a) =>
          a.slice(i + 1).some((other) => membershipConflict(m, other)),
        )
      ) {
        f.status = "resolved";
        f.reason = r.answer.reason;
        f.evidence = r.evidence;
      }
    } else {
      f.reason += ` 停止原因：${r.answer?.reason ?? r.stopReason ?? "证据不足"}。`;
      f.evidence = r.evidence;
    }
  }
  for (const m of all.values())
    if (affected.has(m.personId)) {
      const old = ctx.memberships.find((x) => x.id === m.id);
      if (m.startDate && m.endDate && m.startDate > m.endDate) continue;
      if (
        !old ||
        fingerprint([
          old.startDate,
          old.endDate,
          old.startBasis,
          old.endBasis,
          old.endState,
          old.exclusivityGroup,
        ]) !==
          fingerprint([
            m.startDate,
            m.endDate,
            m.startBasis,
            m.endBasis,
            m.endState,
            m.exclusivityGroup,
          ])
      )
        out.changes.push(
          change(
            batchId,
            `membership:${m.id}`,
            { kind: "membership", membership: m },
            "membership",
            "按所属证据及学制规则补全履历；推算只补空",
            {
              ...versions(ctx, [m.personId], [m.organizationId]),
              ...(old?.updatedAt
                ? { [`membership:${m.id}`]: old.updatedAt }
                : {}),
            },
          ),
        );
    }
  out.skipped = !out.changes.length && !out.findings.length;
  out.metrics.durationMs = Date.now() - started;
  return out;
}
export function verifyFacts(
  batchId: string,
  input: BatchInput,
  ctx: Context,
  res: Resolution,
): AgentResult {
  const started = Date.now(),
    out: AgentResult = {
      agentKey: "person_facts",
      skipped: true,
      findings: [],
      changes: [],
      metrics: emptyMetrics(),
    };
  const chosen = new Map<
    string,
    { markMillis: number; reliability: number; change: Change }
  >();
  for (const row of input.rows) {
    const personId = res.personMap[row.key];
    if (row.hometown) {
      out.metrics.ruleDecisions++;
      const old =
        ctx.people.find((p) => p.id === personId)?.hometown ??
        ctx.people.find(
          (p) =>
            canonicalEntity(res, p.id, "person") === personId && p.hometown,
        )?.hometown;
      if (!old && ctx.source.reliability >= 3)
        out.changes.push(
          change(
            batchId,
            `hometown:${personId}`,
            {
              kind: "person_fact",
              personId,
              field: "hometown",
              value: row.hometown,
            },
            "person_facts",
            "可靠来源补空出身地",
            versions(ctx, [personId]),
          ),
        );
    }
    for (const pb of row.pbs) {
      out.metrics.ruleDecisions++;
      if (
        ![
          "m800",
          "m1500",
          "m2000sc",
          "m3000",
          "m3000sc",
          "m5000",
          "m10000",
          "ten_mile",
          "half_marathon",
          "marathon",
        ].includes(pb.discipline)
      )
        continue;
      const mark = markMillis(pb.mark),
        source = ctx.sources.find(
          (s) => s.id === (pb.sourceId ?? input.sourceId),
        );
      if (!source) continue;
      const key = `pb:${personId}:${pb.discipline}`,
        existing =
          chosen.get(key) ??
          ctx.pbs
            .filter(
              (p) =>
                canonicalEntity(res, p.personId, "person") === personId &&
                p.discipline === pb.discipline,
            )
            .sort(
              (a, b) => (a.markMillis ?? Infinity) - (b.markMillis ?? Infinity),
            )[0];
      if (shouldUpdatePB(mark, source.reliability, existing))
        chosen.set(key, {
          markMillis: mark!,
          reliability: source.reliability,
          change: change(
            batchId,
            key,
            {
              kind: "personal_best",
              personId,
              discipline: pb.discipline,
              mark: pb.mark,
              markMillis: mark!,
              sourceId: source.id,
            },
            "person_facts",
            "同项目可比且来源可信的更好 PB",
            versions(ctx, [personId]),
          ),
        });
    }
  }
  out.changes.push(...[...chosen.values()].map((v) => v.change));
  out.skipped = !out.changes.length;
  out.metrics.durationMs = Date.now() - started;
  return out;
}
export function buildPlan(
  batchId: string,
  input: BatchInput,
  ctx: Context,
  res: Resolution,
  membership: AgentResult,
  facts: AgentResult,
  mode: Manifest["mode"],
): Plan {
  const normalization: AgentResult = {
    agentKey: "normalization",
    skipped: false,
    findings: res.findings,
    changes: res.changes,
    metrics: res.metrics,
  };
  const results = input.rows.map((row) =>
    change(
      batchId,
      `result:${row.key}`,
      {
        kind: "race_result",
        personId: res.personMap[row.key],
        organizationId: row.organizationKey
          ? res.organizationMap[row.organizationKey]
          : undefined,
        row: {
          key: row.key,
          mark: row.mark,
          rank: row.rank,
          teamRank: row.teamRank,
          grade: row.grade,
          notes: row.notes,
        },
      },
      "import",
      "保存原始比赛成绩及年级快照",
    ),
  );
  const teams = input.teams.map((t) =>
    change(
      batchId,
      `team:${t.organizationKey}:${t.leg}`,
      {
        kind: "team_result",
        organizationId: res.organizationMap[t.organizationKey],
        team: t,
      },
      "import",
      "保存队伍及分区累计成绩",
    ),
  );
  const agents = [normalization, membership, facts],
    changes = [
      ...new Map(
        [...agents.flatMap((a) => a.changes), ...results, ...teams].map((c) => [
          c.key,
          c,
        ]),
      ).values(),
    ];
  return {
    batchId,
    raceId: ctx.raceId,
    sourceId: input.sourceId,
    editionId: ctx.editionId,
    mode,
    agents,
    changes,
    findings: agents.flatMap((a) => a.findings),
    summary: {
      mode,
      importedRows: mode === "apply" ? input.rows.length : 0,
      plannedRows: input.rows.length,
      changes: changes.filter(
        (c) =>
          !["source_mapping", "race_result", "team_result"].includes(
            c.operation.kind,
          ),
      ).length,
      repairs:
        mode === "apply"
          ? changes.filter(
              (c) =>
                ![
                  "create_person",
                  "create_organization",
                  "source_mapping",
                  "race_result",
                  "team_result",
                ].includes(c.operation.kind),
            ).length
          : 0,
      plannedRepairs: changes.filter(
        (c) =>
          ![
            "create_person",
            "create_organization",
            "source_mapping",
            "race_result",
            "team_result",
          ].includes(c.operation.kind),
      ).length,
      unresolved: agents
        .flatMap((a) => a.findings)
        .filter((f) => f.status === "unresolved").length,
      metrics: agents.map((a) => ({ agentKey: a.agentKey, ...a.metrics })),
    },
  };
}
