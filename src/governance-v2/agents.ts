// 修改履历或个人事实的规则、冲突分组与裁决门槛时，主动提醒用户评估观测页三语节点说明。
// 未形成待发布版本时可暂缓更新图例，发布前须按实际规则 diff 再核对。
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
  isDnsRow,
  academicWindow,
  adjacentSchoolWindow,
  fillUnknownDates,
  fingerprint,
  markMillis,
  membershipConflict,
  normalizeName,
  normalizeOrganizationName,
  normalizePersonDisplayNameJa,
  isMembershipOrganizationType,
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
  forceReview: ReadonlySet<string> = new Set(),
): Promise<Resolution> {
  // 组织归一化先建立稳定映射，后续人物和 Membership 判断都依赖这个映射。
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
    if (["unknown", "club", "company"].includes(org.type)) continue;
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
    let id: string | undefined =
      overrides[org.key] ?? mapped ??
      resolved.get(identity) ??
      (candidates.length === 1 ? candidates[0].id : undefined);
    if (forceReview.has(org.key)) id = undefined;
    if (!id && (candidates.length === 0 || forceReview.has(org.key))) {
      const recalled = ctx.organizations.filter(
        (o) =>
          (o.slug === org.slug ||
            [o.nameJa, ...(o.aliases ?? [])].some(n => normalizeName(n).startsWith(name.slice(0, 2)))) &&
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
      if (r.answer?.verdict === "match" && r.answer.targetId && candidates.some(c => c.id === r.answer!.targetId)) {
        id = r.answer.targetId;
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
    if (candidates.length > 1) out.findings.push({
      key: `organization_duplicate_candidates:${org.key}`, code: "organization_duplicate_candidates",
      subjectRef: org.key, severity: "info", status: "informational",
      reason: "发现多个存量组织候选；仅判断本次输入映射，存量组织合并留给独立维护，不触发循环重判。",
      evidence: candidates.map(c => ({ sourceKey: `organization:${c.id}`, quote: c.nameJa })),
    });
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
  // 人物归一化只提出带证据的 change；不确定身份必须保留为 finding，而不是猜测合并。
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
    const sourceOrganization = row.organizationKey
      ? input.organizations.find((o) => o.key === row.organizationKey)
      : undefined;
    // A corporate-team affiliation does not conflict with a school history.
    // When every competing same-name profile is therefore non-conflicting and
    // one profile is already tied to the source team, keep the profile with
    // the strongest stored footprint and merge the redundant profiles. This
    // prevents ordinary university-to-company transitions from falling into
    // expensive identity research.
    const nonConflictingCandidates = (() => {
      if (!orgId || sourceOrganization?.type !== "corporate_team" || candidates.length < 1)
        return undefined;
      const memberships = new Map(
        candidates.map((p) => [p.id, ctx.memberships.filter((m) => m.personId === p.id)]),
      );
      if (!candidates.every(p => normalizeName(p.displayNameJa) === normalizeName(row.name)))
        return undefined;
      // Different corporate teams require adjudication even with incomplete dates.
      if (candidates.some(p => memberships.get(p.id)!.some(m =>
        m.organizationType === "corporate_team" && m.organizationId !== orgId)))
        return undefined;
      const births = new Set(candidates.map(p => p.birthDate).filter(Boolean));
      if (births.size > 1) return undefined;
      const hasConflict = candidates.some((a, index) =>
        candidates.slice(index + 1).some((b) =>
          memberships.get(a.id)!.some((ma) => memberships.get(b.id)!.some((mb) => membershipConflict(ma, { ...mb, personId: ma.personId }))),
        ),
      );
      if (hasConflict) return undefined;
      return [...candidates].sort((a, b) => {
        const aResults = (ctx.historicalResults ?? []).filter((h) => h.personId === a.id).length;
        const bResults = (ctx.historicalResults ?? []).filter((h) => h.personId === b.id).length;
        return bResults - aResults ||
          (memberships.get(b.id)?.length ?? 0) - (memberships.get(a.id)?.length ?? 0) ||
          a.id.localeCompare(b.id);
      });
    })();
    // An unconfirmed club/federation label must not block a unique person.
    // Keep the label only on RaceResult; it cannot create Membership evidence.
    const uniqueUnconfirmedOrganizationMatch =
      !orgId &&
      !!sourceOrganization &&
      ["unknown", "club", "company"].includes(sourceOrganization.type) &&
      input.rows.filter((r) => r.organizationKey === row.organizationKey).length === 1 &&
      candidates.length === 1 &&
      normalizeName(candidates[0].displayNameJa) === normalizeName(row.name) &&
      (!row.birthDate || !candidates[0].birthDate || row.birthDate === candidates[0].birthDate);
    let confirmedDistinct = false;
    let id =
      (nonConflictingCandidates && !forceReview.has(row.key)
        ? nonConflictingCandidates[0].id
        : undefined) ??
      mapped ??
      stableMatches.get(sourceKey) ??
      historicalMatch?.person.id ??
      (historical.length === 0 && contextual.length === 1
        ? contextual[0].id
        : uniqueUnconfirmedOrganizationMatch
          ? candidates[0].id
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
    if (id && nonConflictingCandidates && !forceReview.has(row.key)) {
      out.metrics.normalizationRuleMatches!.push({
        subjectRef: row.key,
        targetId: id,
        rule: "non_conflicting_corporate_team_identity_merge",
        evidenceRefs: [`source:${row.key}`],
        weakerCandidateIds: nonConflictingCandidates.filter((p) => p.id !== id).map((p) => p.id),
      });
      for (const duplicate of nonConflictingCandidates.filter((p) => p.id !== id)) {
        out.changes.push({
          ...change(
            batchId,
            `merge_person:${duplicate.id}`,
            {
              kind: "merge_person",
              canonicalId: id,
              duplicateId: duplicate.id,
              evidence: [{ sourceKey: `source:${row.key}` }],
            },
            "normalization",
            "教育阶段与实业团阶段不构成身份冲突，重复同名档案归并",
            versions(ctx, [id, duplicate.id]),
          ),
          evidence: [{ sourceKey: `source:${row.key}` }],
        });
      }
    }
    if (id && historicalMatch?.person.id === id && !mapped && !forceReview.has(row.key)) {
      out.metrics.normalizationRuleMatches!.push({ subjectRef: row.key, targetId: id,
        rule: "exact_name_kana_historical_organization",
        evidenceRefs: [`source:${row.key}`, ...historicalMatch.records.map(h => `result:${h.id}`)],
        weakerCandidateIds: candidates.filter(p => p.id !== id).map(p => p.id) });
    }
    if (id && uniqueUnconfirmedOrganizationMatch && !mapped && !forceReview.has(row.key)) {
      out.metrics.normalizationRuleMatches!.push({ subjectRef: row.key, targetId: id,
        rule: "unique_person_under_unconfirmed_organization",
        evidenceRefs: [`source:${row.key}`],
        weakerCandidateIds: [] });
    }
    const temporary = ctx.people.find(p => p.id === mapped);
    const formal = candidates.find(p => !p.id.startsWith("gov_") && p.id !== mapped &&
      normalizeName(p.displayNameJa) === normalizeName(row.name) &&
      (!row.kana || !p.displayNameKana || normalizeName(p.displayNameKana) === normalizeName(row.kana)) &&
      (!row.birthDate || !p.birthDate || row.birthDate === p.birthDate) &&
      !contradictoryCohort(p) && (ctx.historicalResults ?? []).some(h =>
        h.personId === p.id && h.organizationId === orgId && h.raceId !== ctx.raceId && !!h.sourceId));
    if (mapped?.startsWith("gov_") && temporary && formal && !forceReview.has(row.key) &&
        normalizeName(temporary.displayNameJa) === normalizeName(formal.displayNameJa) &&
        (!temporary.birthDate || !formal.birthDate || temporary.birthDate === formal.birthDate) &&
        !ctx.memberships.some(m => m.personId === mapped && !!orgId && m.organizationId !== orgId)) {
      id = formal.id;
      if (!out.changes.some(c => c.operation.kind === "merge_person" && c.operation.duplicateId === mapped)) {
        const evidence = [{ sourceId: input.sourceId, sourceKey },
          ...(ctx.historicalResults ?? []).filter(h => h.personId === id && h.organizationId === orgId)
            .map(h => ({ sourceId: h.sourceId, sourceKey: h.id }))];
        out.changes.push({ ...change(batchId, `merge_person:${mapped}`, {
          kind: "merge_person", canonicalId: id, duplicateId: mapped, evidence,
        }, "normalization", "临时人物与正式人物姓名、来源及历史所属一致", versions(ctx, [id, mapped])), evidence });
      }
    }
    if (id && !out.metrics.normalizationRuleMatches!.some(m => m.subjectRef === row.key) &&
        !forceReview.has(row.key)) {
      out.metrics.normalizationRuleMatches!.push({ subjectRef: row.key, targetId: id,
        rule: mapped === id ? "source_mapping" : mapped ? "deterministic_merge" : "membership_or_birthdate",
        evidenceRefs: [`source:${row.key}`],
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
          displayNameJa: normalizePersonDisplayNameJa(split.name),
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
              displayNameJa: normalizePersonDisplayNameJa(row.name),
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
        mapping.reason += `；规则：${ruleMatch.rule}`;
        mapping.evidence = ruleMatch.evidenceRefs.map(sourceKey => ({ sourceKey }));
      }
    }
  }
  out.metrics.durationMs += Date.now() - started;
  return out;
}
// Serializable stage state: no Map/Set instances are stored in checkpoints.
export type MembershipWork = {
  memberships: Membership[];
  affectedPersonIds: string[];
  result: AgentResult;
  groups: Array<{ personId: string; findingKeys: string[]; membershipIds: string[] }>;
  outcomes: Array<{ personId: string; outcome: import("./research.js").ResearchOutcome }>;
};
function membershipPersonId(key: string, name: string, ctx: Context, res: Resolution) {
  if (res.personMap[key]) return res.personMap[key];
  const candidates = ctx.people.filter(p => normalizeName(p.displayNameJa) === normalizeName(name));
  return candidates.length === 1 ? candidates[0].id : undefined;
}
function membershipIdentityBlocked(key: string, res: Resolution) {
  return res.findings.some(f => f.subjectRef === key && f.status === "unresolved" &&
    ["identity_unresolved", "mapping_conflict", "circular_evidence"].includes(f.code));
}
export function prepareMembershipContext(input: BatchInput, ctx: Context, res: Resolution): MembershipWork {
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
  return {
    memberships: [...all.values()],
    affectedPersonIds: [...new Set(input.rows
      .filter(row => !membershipIdentityBlocked(row.key, res))
      .map(row => membershipPersonId(row.key, row.name, ctx, res)).filter((id): id is string => !!id))],
    result: { agentKey: "membership", skipped: false, findings: [], changes: [], metrics: emptyMetrics() },
    groups: [], outcomes: [],
  };
}
export function deduplicateMemberships(batchId: string, state: MembershipWork): MembershipWork {
  const work = structuredClone(state), out = work.result;
  const all = new Map(work.memberships.map(m => [m.id, m]));
  const affected = new Set(work.affectedPersonIds);
  const buckets = new Map<string, Membership[]>();
  for (const m of all.values()) {
    if (!affected.has(m.personId)) continue;
    const key = fingerprint([m.personId, m.organizationId, m.type, m.role, m.faculty, m.department, m.cohort,
      m.startDate, m.endDate, m.startYear, m.endYear, m.startBasis, m.endBasis, m.endState, m.exclusivityGroup]);
    buckets.set(key, [...(buckets.get(key) ?? []), m]);
  }
  for (const records of buckets.values()) {
    if (records.length < 2) continue;
    const [keep, ...duplicates] = records.sort((a, b) => Number(!!b.evidence) - Number(!!a.evidence) || a.id.localeCompare(b.id));
    for (const duplicate of duplicates) {
      out.changes.push(change(batchId, `delete_membership:${duplicate.id}`,
        { kind: "delete_membership", membershipId: duplicate.id, personId: keep.personId,
          organizationId: keep.organizationId, retainedId: keep.id },
        "membership", "规范人物下相同组织、关系、角色及时间的重复履历去重",
        duplicate.updatedAt ? { [`membership:${duplicate.id}`]: duplicate.updatedAt } : {}));
      keep.evidence = { ...keep.evidence, deduplicatedMemberships: [
        ...((keep.evidence?.deduplicatedMemberships as unknown[]) ?? []), duplicate,
      ] };
      all.delete(duplicate.id);
    }
  }
  work.memberships = [...all.values()];
  return work;
}
export function resolveMembershipRules(batchId: string, input: BatchInput, ctx: Context,
  res: Resolution, state: MembershipWork): MembershipWork {
  const started = Date.now(), work = structuredClone(state), out = work.result;
  const all = new Map(work.memberships.map(m => [m.id, m]));
  const orgTypes = new Map([
    ...ctx.organizations.map(o => [o.id, o.type] as const),
    ...input.organizations.map(o => [res.organizationMap[o.key], ctx.organizations.find(c => c.id === res.organizationMap[o.key])?.type ?? o.type] as const),
  ]);
  const affected = new Set(work.affectedPersonIds);
  for (const row of input.rows) {
    if (membershipIdentityBlocked(row.key, res)) continue;
    // Membership-only reruns may lack the historical source mapping created by
    // the original import. Reuse the canonical name match before deriving a
    // provisional ID; the latter is not a valid business Person reference.
    const personId = membershipPersonId(row.key, row.name, ctx, res);
    const implicitOrganization = row.organizationKey
      ? input.organizations.find(o => o.key === row.organizationKey)
      : undefined;
    const implicitOrganizationId = implicitOrganization
      ? res.organizationMap[implicitOrganization.key]
      : undefined;
    const hints = [...row.memberships];
    if (implicitOrganization && implicitOrganizationId &&
        isMembershipOrganizationType(implicitOrganization.type) &&
        !hints.some(h => h.organizationKey === implicitOrganization.key)) {
      hints.push({
        organizationKey: implicitOrganization.key,
        type: implicitOrganization.type === "corporate_team" ? "affiliated" : "enrolled",
        // Race representation is an observation, never a joining date or proof
        // of ongoing employment. Unknown dates stay unknown, including DNS/DNF.
        endState: "unknown",
      });
    }
    if (hints.length) {
      out.metrics.membershipRowsConsidered = (out.metrics.membershipRowsConsidered ?? 0) + 1;
      if (hints.length > row.memberships.length)
        out.metrics.membershipImplicitHints = (out.metrics.membershipImplicitHints ?? 0) + 1;
      if (isDnsRow(row))
        out.metrics.membershipDnsRowsIncluded = (out.metrics.membershipDnsRowsIncluded ?? 0) + 1;
    }
    if (!personId) {
      out.findings.push(unresolved(
        `membership_person_missing:${row.key}`,
        row.key,
        "无法从既有来源映射或规范姓名找到已导入选手，Membership 暂不写入。",
        "membership_unresolved",
      ));
      continue;
    }
    for (const hint of hints) {
      out.metrics.ruleDecisions++;
      const organizationId = res.organizationMap[hint.organizationKey] ??
        ctx.organizations.find((o) => normalizeOrganizationName(o.nameJa) === normalizeOrganizationName(
          input.organizations.find((x) => x.key === hint.organizationKey)?.name ?? "",
        ))?.id;
      if (!organizationId) {
        out.findings.push(unresolved(
          `membership_organization_missing:${row.key}:${hint.organizationKey}`,
          row.key,
          "无法从既有来源映射或规范名称找到已导入组织，Membership 暂不写入。",
          "membership_unresolved",
        ));
        continue;
      }
      const organizationType = orgTypes.get(organizationId);
      if (!isMembershipOrganizationType(organizationType)) continue;
      let existing = [...all.values()].filter(
        (m) =>
          m.personId === personId &&
          m.organizationId === organizationId &&
          m.type === hint.type,
      );
      if (existing.length > 1) {
        out.findings.push(unresolved(`membership_duplicate:${personId}:${organizationId}`, personId,
          "同一组织存在日期或关系字段不同的多段履历，不能自动折叠；保留现有记录与来源线索。", "membership_unresolved"));
        continue;
      }
      let window: Window = {
        startDate: hint.startDate,
        endDate: hint.endDate,
        startYear: hint.startYear,
        endYear: hint.endYear,
        startBasis: hint.startDate || hint.startYear !== undefined ? "source" : "unknown",
        endBasis: hint.endDate || hint.endYear !== undefined ? "source" : "unknown",
        endState: hint.endState,
        evidence: { raceObservations: [{ sourceId: input.sourceId, rowKey: row.key, raceDate: ctx.raceDate }] },
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
        role: existing[0]?.role,
        faculty: existing[0]?.faculty, department: existing[0]?.department, cohort: existing[0]?.cohort,
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
            existing[0].endBasis !== "inferred") ||
          (hint.startYear !== undefined &&
            (existing[0].startYear ?? (existing[0].startDate ? Number(existing[0].startDate.slice(0, 4)) : undefined)) !== undefined &&
            hint.startYear !== (existing[0].startYear ?? Number(existing[0].startDate?.slice(0, 4))) && existing[0].startBasis !== "inferred") ||
          (hint.endYear !== undefined &&
            (existing[0].endYear ?? (existing[0].endDate ? Number(existing[0].endDate.slice(0, 4)) : undefined)) !== undefined &&
            hint.endYear !== (existing[0].endYear ?? Number(existing[0].endDate?.slice(0, 4))) && existing[0].endBasis !== "inferred")
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
  work.memberships = [...all.values()];
  out.metrics.durationMs += Date.now() - started;
  return work;
}
export function inferMembershipTimeline(state: MembershipWork, ctx: Context): MembershipWork {
  const work = structuredClone(state), out = work.result;
  const all = new Map(work.memberships.map(m => [m.id, m]));
  const affected = new Set(work.affectedPersonIds);
  // A historical starter is an observation of a relationship, not proof of its joining date.
  for (const result of ctx.historicalResults ?? []) {
    if (!affected.has(result.personId) || !result.isStarter || !result.raceDate || !result.organizationId) continue;
    const org = ctx.organizations.find(o => o.id === result.organizationId);
    if (!org || !isMembershipOrganizationType(org.type)) continue;
    const kind = org.type === "corporate_team" ? "affiliated" : "enrolled";
    const same = [...all.values()].filter(m => m.personId === result.personId &&
      m.organizationId === org.id && m.type === kind);
    if (same.length > 1) continue;
    const m: Membership = same[0] ?? {
      id: stableId(result.personId, org.id, kind), personId: result.personId,
      organizationId: org.id, organizationType: org.type, type: kind,
      startBasis: "unknown", endBasis: "unknown", endState: "unknown",
    };
    if (m.startDate && m.startDate > result.raceDate) {
      m.startDate = undefined;
      m.startYear = undefined;
      m.startBasis = "unknown";
    }
    m.evidence = { ...m.evidence, historicalStarterObservations: [
      ...new Set([...(m.evidence?.historicalStarterObservations as string[] ?? []), result.id]),
    ].sort() };
    all.set(m.id, m);
  }
  for (const m of all.values()) {
    if (!affected.has(m.personId)) continue;
    if (m.organizationType === "corporate_team" && !m.startDate && m.startYear === undefined) {
      const ends = [...new Set([...all.values()].filter(x => x.personId === m.personId &&
        ["university", "high_school"].includes(x.organizationType) && x.endDate?.endsWith("03-31") &&
        ["source", "inferred"].includes(x.endBasis)).map(x => x.endDate!))];
      if (ends.length === 1)
        m.evidence = { ...m.evidence, schoolEndBeforeCorporateObservation: ends[0] };
    }
    if ((!m.startDate || !m.endDate) && [...all.values()].filter(x =>
      x.personId === m.personId && x.type === m.type && x.organizationType === m.organizationType).length === 1) {
      const inferred = adjacentSchoolWindow(m.organizationType,
        [...all.values()].filter(x => x.personId === m.personId));
      if (inferred) Object.assign(m, fillUnknownDates(m, inferred));
    }
  }
  work.memberships = [...all.values()];
  return work;
}
export function collectMembershipConflicts(state: MembershipWork): MembershipWork {
  const work = structuredClone(state);
  const affected = new Set(work.affectedPersonIds);
  for (const m of work.memberships) {
    if (!affected.has(m.personId)) continue;
    if (!validMembershipWindow(m))
      work.result.findings.push(unresolved(`membership_invalid:${m.id}`, m.id,
        "履历起止顺序无效，需要来源核验；不应用无效时间窗口。", "membership_conflict"));
    for (const other of work.memberships)
      if (m.id < other.id && membershipConflict(m, other))
        work.result.findings.push(unresolved(`membership_overlap:${m.id}:${other.id}`, m.personId,
          "同一学段不同学校或明确互斥关系的来源时间重叠，需要核验。", "membership_conflict"));
  }
  const groups = new Map<string, MembershipWork["groups"][number]>();
  for (const f of work.result.findings.filter(f => f.code === "membership_conflict")) {
    const personId = work.memberships.find(m => m.id === f.subjectRef)?.personId ?? f.subjectRef;
    const memberships = work.memberships.filter(m => m.personId === personId);
    if (!memberships.length) continue;
    const group = groups.get(personId) ?? { personId, findingKeys: [], membershipIds: memberships.map(m => m.id) };
    group.findingKeys.push(f.key); groups.set(personId, group);
  }
  work.groups = [...groups.values()];
  work.result.metrics.membershipResearchPeople = work.groups.length;
  work.result.metrics.membershipConflictFindings = work.groups.reduce((n, g) => n + g.findingKeys.length, 0);
  return work;
}
export async function researchMembershipConflicts(input: BatchInput, ctx: Context, res: Resolution,
  state: MembershipWork, research: Researcher): Promise<MembershipWork> {
  const started = Date.now(), work = structuredClone(state);
  for (const group of work.groups) {
    const memberships = work.memberships.filter(m => m.personId === group.personId);
    const outcome = await research({ kind: "membership_conflict", allowNetwork: true,
      subjectRef: group.personId, allowedIds: group.membershipIds,
      question: "按一个人完整履历一次处理所有冲突。赛事日期只证明当时代表关系，不是入队日，也不能证明持续所属。大学到实业团不是互斥关系。同队更名不代表个人转会。同一集团不证明同队。可以keep_membership维持原状并结案；确认转会顺序但日期不明时保留空日期，仅有年份则填写年份，不得将公告日或赛事日当入离队日。correct_membership只修改有证据的字段；null日期默认不修改，清除错误具体日需clearStartDate/clearEndDate=true。年份级证据可设置startYear/endYear并清除错误精确日。endState可为unknown/ended/ongoing，ongoing必须有明确证据。必须解释每个冲突，不足则unresolved。",
      context: { person: ctx.people.find(p => p.id === group.personId), memberships,
        event: { raceSlug: input.raceSlug, raceDate: ctx.raceDate, source: ctx.source },
        organizations: [...new Map([
          ...input.organizations.map(o => ({ id: res.organizationMap[o.key], nameJa: o.name, type: o.type })),
          ...ctx.organizations,
        ].filter(o => memberships.some(m => m.organizationId === o.id)).map(o => [o.id, o])).values()],
        sourceOrganizations: input.organizations.filter(o => memberships.some(m => m.organizationId === res.organizationMap[o.key])),
        conflicts: work.result.findings.filter(f => group.findingKeys.includes(f.key)),
        inputHints: input.rows.filter(row => membershipPersonId(row.key, row.name, ctx, res) === group.personId),
        historicalResults: ctx.historicalResults?.filter(r => r.personId === group.personId),
        historicalReferences: ctx.historicalReferences?.filter(r => r.personId === group.personId),
      },
    }, work.result.metrics);
    if (!outcome.answer && !["research_budget_exhausted", "research_not_configured", "research_scope_too_large", "identity_footprint_too_large", "research_has_no_verified_source_reference"].includes(outcome.stopReason ?? ""))
      throw new Error(`Membership research model failure: ${outcome.stopReason ?? "missing_answer"}`);
    work.outcomes.push({ personId: group.personId, outcome });
  }
  work.result.metrics.durationMs += Date.now() - started;
  return work;
}
function validMembershipWindow(m: Membership) {
  const lower = m.startDate ?? (m.startYear !== undefined ? `${m.startYear}-01-01` : undefined);
  const upper = m.endDate ?? (m.endYear !== undefined ? `${m.endYear}-12-31` : undefined);
  return !(lower && upper && lower > upper) &&
    !(m.startYear !== undefined && m.endYear !== undefined && m.startYear > m.endYear) &&
    !(m.startDate && m.startYear !== undefined && Number(m.startDate.slice(0, 4)) !== m.startYear) &&
    !(m.endDate && m.endYear !== undefined && Number(m.endDate.slice(0, 4)) !== m.endYear);
}
export function validateMembershipDecisions(state: MembershipWork): MembershipWork {
  const started = Date.now(), work = structuredClone(state);
  for (const { personId, outcome } of work.outcomes) {
    const group = work.groups.find(g => g.personId === personId)!;
    const findings = work.result.findings.filter(f => group.findingKeys.includes(f.key));
    const answer = outcome.answer;
    const proposed = new Map(work.memberships.filter(m => m.personId === personId).map(m => [m.id, m]));
    let accepted = !!answer && outcome.evidence.some(e => !!e.url && !!e.quote) &&
      !answer.targetId && !answer.duplicateIds.length && !answer.split &&
      ["keep_membership", "correct_membership"].includes(answer.verdict);
    if (answer?.verdict === "keep_membership" && answer.corrections.length) accepted = false;
    if (answer?.verdict === "correct_membership") {
      if (!answer.corrections.length) accepted = false;
      const seen = new Set<string>();
      for (const correction of answer.corrections) {
        const m = proposed.get(correction.membershipId);
        if (!m || seen.has(m.id)) { accepted = false; break; }
        seen.add(m.id);
        const next = { ...m };
        for (const side of ["start", "end"] as const) {
          const dateKey = `${side}Date` as const, yearKey = `${side}Year` as const, basisKey = `${side}Basis` as const;
          const clear = side === "start" ? correction.clearStartDate : correction.clearEndDate;
          const date = correction[dateKey], year = correction[yearKey];
          if (clear && date) { accepted = false; break; }
          if (clear) { next[dateKey] = undefined; next[yearKey] = undefined; next[basisKey] = "unknown"; }
          if (date) { next[dateKey] = date; next[yearKey] = Number(date.slice(0, 4)); next[basisKey] = correction[basisKey] ?? "source"; }
          if (year !== undefined && year !== null) {
            next[yearKey] = year;
            if (!date) next[dateKey] = undefined;
            next[basisKey] = correction[basisKey] ?? "source";
          }
        }
        if (correction.endState) next.endState = correction.endState;
        next.evidence = { ...m.evidence, research: outcome.evidence, decisionReason: answer.reason };
        if (!validMembershipWindow(next)) accepted = false;
        proposed.set(m.id, next);
      }
      // An atomic decision may not leave the person's actual exclusive overlaps unresolved.
      if ([...proposed.values()].some((m, i, a) => a.slice(i + 1).some(other => membershipConflict(m, other)))) accepted = false;
    }
    if ([...proposed.values()].some(m => !validMembershipWindow(m))) accepted = false;
    if (answer?.verdict === "keep_membership" && [...proposed.values()].some((m, i, a) =>
      a.slice(i + 1).some(other => membershipConflict(m, other)))) accepted = false;
    for (const f of findings) {
      f.evidence = outcome.evidence;
      if (accepted) { f.status = "resolved"; f.reason = answer!.reason; }
      else f.reason += ` 研究未通过校验：${answer?.reason ?? outcome.stopReason ?? "证据不足"}。`;
    }
    if (accepted && answer?.verdict === "correct_membership")
      work.memberships = work.memberships.map(m => proposed.get(m.id) ?? m);
  }
  work.result.metrics.durationMs += Date.now() - started;
  return work;
}
export function finalizeMemberships(batchId: string, ctx: Context, state: MembershipWork): AgentResult {
  const started = Date.now(), work = structuredClone(state), out = work.result;
  const all = new Map(work.memberships.map(m => [m.id, m])), affected = new Set(work.affectedPersonIds);
  for (const m of all.values())
    if (affected.has(m.personId)) {
      const old = ctx.memberships.find((x) => x.id === m.id);
      if (!validMembershipWindow(m)) continue;
      if (
        !old ||
        fingerprint([
          old.startDate,
          old.endDate,
          old.startYear, old.endYear, old.evidence,
          old.startBasis,
          old.endBasis,
          old.endState,
          old.exclusivityGroup,
        ]) !==
          fingerprint([
            m.startDate,
            m.endDate,
            m.startYear, m.endYear, m.evidence,
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
  out.metrics.membershipChangesPlanned = out.changes.filter(c => c.operation.kind === "membership").length;
  out.skipped = !out.changes.length && !out.findings.length;
  out.metrics.durationMs += Date.now() - started;
  return out;
}

// Compatibility entry point for membership-only callers and rule tests.
export async function governMemberships(batchId: string, input: BatchInput, ctx: Context,
  res: Resolution, research: Researcher): Promise<AgentResult> {
  let work = deduplicateMemberships(batchId, prepareMembershipContext(input, ctx, res));
  work = resolveMembershipRules(batchId, input, ctx, res, work);
  work = collectMembershipConflicts(inferMembershipTimeline(work, ctx));
  work = validateMembershipDecisions(await researchMembershipConflicts(input, ctx, res, work, research));
  return finalizeMemberships(batchId, ctx, work);
}
export function verifyFacts(
  batchId: string,
  input: BatchInput,
  ctx: Context,
  res: Resolution,
): AgentResult {
  // 人物事实验证只比较输入明确提供的字段，不能把缺失信息当作事实冲突。
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
    if (res.findings.some(f => f.subjectRef === row.key && f.status === "unresolved")) continue;
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
  // Plan 是 graph 与 writer 之间的稳定契约：它描述拟议变更，但不执行业务副作用。
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
        organizationNameSnapshot: row.organizationKey
          ? input.organizations.find((o) => o.key === row.organizationKey)?.name
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
  // 未确认组织仅保存个人成绩上的参赛名称；队伍表要求真实组织外键。
  const teams = input.teams.filter((t) => !["unknown", "club", "company"].includes(
    input.organizations.find((o) => o.key === t.organizationKey)!.type,
  )).map((t) => {
    if (!res.organizationMap[t.organizationKey])
      throw new Error(`Team result requires a normalized organization: ${t.organizationKey}`);
    return change(
      batchId,
      `team:${t.organizationKey}:${t.leg}`,
      {
        kind: "team_result",
        organizationId: res.organizationMap[t.organizationKey],
        team: t,
      },
      "import",
      "保存队伍及分区累计成绩",
    );
  });
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

export async function buildMembershipOnlyPlan(
  batchId: string,
  input: BatchInput,
  ctx: Context,
  res: Resolution,
  mode: Manifest["mode"],
  research: Researcher,
  result?: AgentResult,
): Promise<Plan> {
  const membership = result ?? await governMemberships(batchId, input, ctx, res, research);
  const skipped = (agentKey: string): AgentResult => ({
    agentKey, skipped: true, findings: [], changes: [], metrics: emptyMetrics(),
  });
  const changes = membership.changes;
  return {
    batchId,
    raceId: ctx.raceId,
    sourceId: input.sourceId,
    editionId: ctx.editionId,
    mode,
    changes,
    findings: membership.findings,
    agents: [skipped("normalization"), membership, skipped("person_facts")],
    summary: {
      mode,
      agentMode: "membership_only",
      importedRows: 0,
      plannedRows: 0,
      changes: changes.length,
      repairs: mode === "apply" ? changes.length : 0,
      plannedRepairs: changes.length,
      unresolved: membership.findings.filter(f => f.status === "unresolved").length,
      metrics: [ { agentKey: "membership", ...membership.metrics } ],
    },
  };
}
