import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Change, Operation, Plan } from "./contracts.js";
import { GovernanceDB, iso, StalePlanError, type Task } from "./database.js";
import { markMillis, normalizeName, stableId } from "./rules.js";

const tables = {
  person: "Person",
  organization: "Organization",
  membership: "Membership",
  pb: "PersonalBest",
} as const;
export class BusinessWriter {
  constructor(
    readonly db: GovernanceDB,
    readonly writeEnabled: boolean,
  ) {}
  async apply(
    task: Task,
    plan: Plan,
    beforeCommit?: (client: PoolClient) => Promise<void>,
  ) {
    if (plan.mode !== task.mode) throw new Error("Plan/task mode mismatch");
    if (task.mode === "apply" && !this.writeEnabled)
      throw new Error("GOVERNANCE_WRITE_ENABLED=true is required for apply");
    await this.db.fenced(task, async (c) => {
      const batch = (
        await c.query(
          'SELECT status,"eventTaskId" FROM governance."GovernanceBatch" WHERE id=$1 FOR UPDATE',
          [plan.batchId],
        )
      ).rows[0];
      if (!batch || batch.eventTaskId !== task.id)
        throw new Error("Batch is not owned by task");
      if (["completed", "completed_with_unresolved"].includes(batch.status))
        return;
      if (task.mode === "apply") {
        // Lock in a stable order, and validate once before any action modifies a target.
        const expected = Object.assign(
          {},
          ...plan.changes.map((x) => x.expectedVersions),
        ) as Record<string, string>;
        for (const [ref, version] of Object.entries(expected).sort(([a], [b]) =>
          a.localeCompare(b),
        )) {
          const [type, id] = ref.split(":");
          const table = tables[type as keyof typeof tables];
          if (!table || !id) throw new Error("Invalid version reference");
          const r = (
            await c.query(
              `SELECT "updatedAt" FROM public."${table}" WHERE id=$1 FOR UPDATE`,
              [id],
            )
          ).rows[0];
          if (!r || iso(r.updatedAt) !== version) throw new StalePlanError(ref);
        }
        const planned = (
          await c.query(
            'SELECT "idempotencyKey","patchAndEvidence",status FROM governance."GovernanceChange" WHERE "batchId"=$1 FOR UPDATE',
            [plan.batchId],
          )
        ).rows;
        for (const change of plan.changes) {
          const stored = planned.find(
            (r) => r.idempotencyKey === change.idempotencyKey,
          );
          if (!stored) throw new Error("Unsaved change plan");
          if (stored.status === "applied") continue;
          if (stored.status !== "planned")
            throw new Error("Change is not executable");
          const result = await this.execute(c, plan, change);
          await c.query(
            'UPDATE governance."GovernanceChange" SET status=\'applied\',"businessAuditRef"=$2,"appliedAt"=clock_timestamp(),"patchAndEvidence"="patchAndEvidence"||jsonb_build_object(\'appliedDiff\',$3::jsonb) WHERE "idempotencyKey"=$1',
            [
              change.idempotencyKey,
              result.auditId,
              JSON.stringify(result.diff),
            ],
          );
        }
        for (const scope of ["player-detail", "competition-detail"])
          await c.query(
            'INSERT INTO public."CacheInvalidation" (id,scope,version,"updatedAt") VALUES($1,$2,clock_timestamp(),clock_timestamp()) ON CONFLICT(scope) DO UPDATE SET version=clock_timestamp(),"updatedAt"=clock_timestamp()',
            [stableId("cache", scope), scope],
          );
      }
      if (beforeCommit) await beforeCommit(c);
      const status = plan.findings.some((f) => f.status === "unresolved")
        ? "completed_with_unresolved"
        : "completed";
      await c.query(
        'UPDATE governance."GovernanceBatch" SET status=$2,summary=$3,"completedAt"=clock_timestamp(),"updatedAt"=clock_timestamp() WHERE id=$1',
        [plan.batchId, status, plan.summary],
      );
    });
  }
  private async execute(
    c: PoolClient,
    plan: Plan,
    change: Change,
  ): Promise<{ auditId: string; diff: { before: unknown; after: unknown } }> {
    const op = change.operation;
    let entityType: string = op.kind,
      entityId = change.key;
    let before: unknown = null,
      after: unknown = op;
    switch (op.kind) {
      case "create_organization": {
        entityType = "Organization";
        entityId = op.entity.id;
        const existing = (
          await c.query('SELECT * FROM public."Organization" WHERE id=$1', [
            entityId,
          ])
        ).rows[0];
        if (existing) {
          if (
            normalizeName(existing.nameJa) !== normalizeName(op.entity.nameJa)
          )
            throw new StalePlanError(`organization:${entityId}`);
          break;
        }
        const collision = (
          await c.query('SELECT id FROM public."Organization" WHERE slug=$1', [
            op.entity.slug,
          ])
        ).rowCount;
        await c.query(
          'INSERT INTO public."Organization" (id,slug,"nameJa",type,"updatedAt") VALUES($1,$2,$3,$4,clock_timestamp())',
          [
            entityId,
            collision ? `${op.entity.slug}-${entityId}` : op.entity.slug,
            op.entity.nameJa,
            op.entity.type,
          ],
        );
        break;
      }
      case "create_person": {
        entityType = "Person";
        entityId = op.entity.id;
        const existing = (
          await c.query('SELECT * FROM public."Person" WHERE id=$1', [entityId])
        ).rows[0];
        if (existing) {
          if (
            normalizeName(existing.displayNameJa) !==
            normalizeName(op.entity.displayNameJa)
          )
            throw new StalePlanError(`person:${entityId}`);
          break;
        }
        const collision = (
          await c.query('SELECT id FROM public."Person" WHERE slug=$1', [
            op.entity.slug,
          ])
        ).rowCount;
        await c.query(
          'INSERT INTO public."Person" (id,slug,"displayNameJa","displayNameJaSearch","birthDate","updatedAt") VALUES($1,$2,$3,$4,$5,clock_timestamp())',
          [
            entityId,
            collision ? `${op.entity.slug}-${entityId}` : op.entity.slug,
            op.entity.displayNameJa,
            normalizeName(op.entity.displayNameJa),
            op.entity.birthDate ?? null,
          ],
        );
        break;
      }
      case "source_mapping": {
        entityType = "SourceReference";
        entityId = stableId(plan.sourceId, op.entityType, op.sourceKey);
        const column =
          op.entityType === "organization" ? "organizationId" : "personId";
        const existing = (
          await c.query(
            'SELECT * FROM public."SourceReference" WHERE "sourceId"=$1 AND "sourceEntityType"=$2 AND "sourceEntityKey"=$3 FOR UPDATE',
            [plan.sourceId, op.entityType, op.sourceKey],
          )
        ).rows[0];
        if (existing && existing[column] !== op.targetId)
          throw new StalePlanError(`source_mapping:${op.sourceKey}`);
        await c.query(
          `INSERT INTO public."SourceReference" (id,"sourceId","sourceEntityType","sourceEntityKey","${column}","sourceUrl","updatedAt") VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()) ON CONFLICT("sourceId","sourceEntityType","sourceEntityKey") DO UPDATE SET "sourceUrl"=COALESCE(EXCLUDED."sourceUrl",public."SourceReference"."sourceUrl"),"updatedAt"=clock_timestamp()`,
          [
            entityId,
            plan.sourceId,
            op.entityType,
            op.sourceKey,
            op.targetId,
            op.sourceUrl ?? null,
          ],
        );
        break;
      }
      case "name_variant": {
        entityType = "NameVariant";
        entityId = stableId(
          "alias",
          op.entityType,
          op.targetId,
          normalizeName(op.value),
        );
        const column =
          op.entityType === "person" ? "personId" : "organizationId";
        await c.query(
          `INSERT INTO public."NameVariant" (id,value,type,"${column}","sourceId","updatedAt") VALUES($1,$2,'media',$3,$4,clock_timestamp()) ON CONFLICT(id) DO NOTHING`,
          [entityId, op.value, op.targetId, plan.sourceId],
        );
        break;
      }
      case "membership": {
        const m = op.membership;
        entityType = "Membership";
        entityId = m.id;
        before =
          (
            await c.query(
              'SELECT * FROM public."Membership" WHERE id=$1 FOR UPDATE',
              [m.id],
            )
          ).rows[0] ?? null;
        await c.query(
          `INSERT INTO public."Membership" (id,"personId","organizationId",type,"startDate","endDate","startYear","endYear","startDateBasis","endDateBasis","endState","dateEvidence","sourceId","exclusivityGroup","updatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,clock_timestamp()) ON CONFLICT(id) DO UPDATE SET "startDate"=EXCLUDED."startDate","endDate"=EXCLUDED."endDate","startYear"=EXCLUDED."startYear","endYear"=EXCLUDED."endYear","startDateBasis"=EXCLUDED."startDateBasis","endDateBasis"=EXCLUDED."endDateBasis","endState"=EXCLUDED."endState","dateEvidence"=EXCLUDED."dateEvidence","exclusivityGroup"=EXCLUDED."exclusivityGroup","updatedAt"=clock_timestamp()`,
          [
            m.id,
            m.personId,
            m.organizationId,
            m.type,
            m.startDate ?? null,
            m.endDate ?? null,
            m.startDate ? Number(m.startDate.slice(0, 4)) : null,
            m.endDate ? Number(m.endDate.slice(0, 4)) : null,
            m.startBasis,
            m.endBasis,
            m.endState,
            m.evidence ?? {},
            plan.sourceId,
            m.exclusivityGroup ?? null,
          ],
        );
        await c.query(
          'UPDATE public."Person" SET "updatedAt"=clock_timestamp() WHERE id=$1',
          [m.personId],
        );
        break;
      }
      case "person_fact": {
        entityType = "Person";
        entityId = op.personId;
        const p = (
          await c.query(
            'SELECT hometown FROM public."Person" WHERE id=$1 FOR UPDATE',
            [entityId],
          )
        ).rows[0];
        if (!p) throw new Error("Missing fact target");
        if (p.hometown && p.hometown !== op.value)
          throw new StalePlanError(`person:${entityId}`);
        before = p;
        await c.query(
          'UPDATE public."Person" SET hometown=$2,"updatedAt"=clock_timestamp() WHERE id=$1',
          [entityId, op.value],
        );
        break;
      }
      case "personal_best": {
        entityType = "PersonalBest";
        const pbs = (
          await c.query(
            'SELECT * FROM public."PersonalBest" WHERE "personId"=$1 AND discipline=$2 FOR UPDATE',
            [op.personId, op.discipline],
          )
        ).rows;
        const old = pbs.sort(
          (a, b) => (a.markMillis ?? Infinity) - (b.markMillis ?? Infinity),
        )[0];
        if (old && old.markMillis !== null && old.markMillis <= op.markMillis)
          throw new StalePlanError(`pb:${old.id}`);
        entityId = old?.id ?? stableId("pb", op.personId, op.discipline);
        before = old ?? null;
        await c.query(
          'INSERT INTO public."PersonalBest" (id,"personId",discipline,mark,"markMillis","sourceId","updatedAt") VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()) ON CONFLICT(id) DO UPDATE SET mark=EXCLUDED.mark,"markMillis"=EXCLUDED."markMillis","sourceId"=EXCLUDED."sourceId","updatedAt"=clock_timestamp()',
          [
            entityId,
            op.personId,
            op.discipline,
            op.mark,
            op.markMillis,
            op.sourceId,
          ],
        );
        await c.query(
          'UPDATE public."Person" SET "updatedAt"=clock_timestamp() WHERE id=$1',
          [op.personId],
        );
        break;
      }
      case "race_result": {
        entityType = "RaceResult";
        entityId = stableId("result", plan.sourceId, plan.raceId, op.row.key);
        const exact = (
          await c.query(
            'SELECT * FROM public."RaceResult" WHERE id=$1 FOR UPDATE',
            [entityId],
          )
        ).rows[0];
        const old =
          exact ??
          (
            await c.query(
              'SELECT * FROM public."RaceResult" WHERE "raceId"=$1 AND "personId"=$2 AND "sourceId"=$3 FOR UPDATE',
              [plan.raceId, op.personId, plan.sourceId],
            )
          ).rows;
        if (Array.isArray(old) && old.length === 1) {
          entityId = old[0].id;
          before = old[0];
        } else before = Array.isArray(old) ? null : old;
        await c.query(
          `INSERT INTO public."RaceResult" (id,"personId","raceId","organizationId",mark,"markMillis",rank,"teamRank","gradeAtRace",notes,"sourceId","isEntry","isStarter","updatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,clock_timestamp()) ON CONFLICT(id) DO UPDATE SET "personId"=EXCLUDED."personId","organizationId"=EXCLUDED."organizationId",mark=EXCLUDED.mark,"markMillis"=EXCLUDED."markMillis",rank=EXCLUDED.rank,"teamRank"=EXCLUDED."teamRank","gradeAtRace"=EXCLUDED."gradeAtRace",notes=EXCLUDED.notes,"sourceId"=EXCLUDED."sourceId","isStarter"=EXCLUDED."isStarter","updatedAt"=clock_timestamp()`,
          [
            entityId,
            op.personId,
            plan.raceId,
            op.organizationId ?? null,
            op.row.mark ?? null,
            op.row.mark ? markMillis(op.row.mark) : null,
            op.row.rank ?? null,
            op.row.teamRank ?? null,
            op.row.grade ?? null,
            op.row.notes ?? null,
            plan.sourceId,
            !/\bDNS\b|欠/u.test(op.row.notes ?? "") &&
              ((!!op.row.mark && markMillis(op.row.mark) !== null) ||
                /\b(?:DNF|DQ)\b/u.test(op.row.notes ?? "")),
          ],
        );
        break;
      }
      case "team_result": {
        entityType = "TeamCompetitionResult";
        const t = op.team;
        entityId = stableId("team", plan.editionId, op.organizationId);
        const r = await c.query(
          'INSERT INTO public."TeamCompetitionResult" (id,"competitionEditionId","organizationId","finalRank","finalMark","finalMarkMillis","sourceId","updatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()) ON CONFLICT("competitionEditionId","organizationId") DO UPDATE SET "finalRank"=COALESCE(EXCLUDED."finalRank",public."TeamCompetitionResult"."finalRank"),"finalMark"=COALESCE(EXCLUDED."finalMark",public."TeamCompetitionResult"."finalMark"),"finalMarkMillis"=COALESCE(EXCLUDED."finalMarkMillis",public."TeamCompetitionResult"."finalMarkMillis"),"updatedAt"=clock_timestamp() RETURNING id',
          [
            entityId,
            plan.editionId,
            op.organizationId,
            t.finalRank ?? null,
            t.finalMark ?? null,
            t.finalMark ? markMillis(t.finalMark) : null,
            plan.sourceId,
          ],
        );
        entityId = r.rows[0].id;
        await c.query(
          'INSERT INTO public."TeamCompetitionLegSnapshot" (id,"teamCompetitionResultId",leg,"cumulativeRank","cumulativeMark","cumulativeMarkMillis","gapFromLeader","gapFromLeaderMillis",notes,"sourceId","updatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp()) ON CONFLICT("teamCompetitionResultId",leg) DO UPDATE SET "cumulativeRank"=EXCLUDED."cumulativeRank","cumulativeMark"=EXCLUDED."cumulativeMark","cumulativeMarkMillis"=EXCLUDED."cumulativeMarkMillis","gapFromLeader"=EXCLUDED."gapFromLeader","gapFromLeaderMillis"=EXCLUDED."gapFromLeaderMillis",notes=EXCLUDED.notes,"updatedAt"=clock_timestamp()',
          [
            stableId(entityId, String(t.leg)),
            entityId,
            t.leg,
            t.cumulativeRank ?? null,
            t.cumulativeMark ?? null,
            t.cumulativeMark ? markMillis(t.cumulativeMark) : null,
            t.gapFromLeader ?? null,
            t.gapFromLeader ? markMillis(t.gapFromLeader) : null,
            t.notes ?? null,
            plan.sourceId,
          ],
        );
        break;
      }
      case "merge_person":
      case "merge_organization": {
        before = await merge(c, op);
        entityType = op.kind === "merge_person" ? "Person" : "Organization";
        entityId = op.canonicalId;
        break;
      }
      case "split_person": {
        await split(c, op);
        entityType = "Person";
        entityId = op.fromPersonId;
        break;
      }
      default: {
        const neverOp: never = op;
        throw new Error(`Unsupported operation: ${String(neverOp)}`);
      }
    }
    const diff = businessDiff(op, before);
    const audit = randomUUID();
    await c.query(
      'INSERT INTO public."AuditLog" (id,"entityType","entityId",action,"oldValue","newValue","reasonType","reasonNote","sourceId","actorType","actorId","batchId",metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,\'system\',\'governance-v2\',$10,$11)',
      [
        audit,
        entityType,
        entityId,
        op.kind.startsWith("merge_")
          ? "merge"
          : op.kind === "split_person"
            ? "split"
            : before
              ? "update"
              : "create",
        before ? JSON.stringify(before) : null,
        JSON.stringify(after),
        op.kind.startsWith("merge_")
          ? "entity_merge"
          : op.kind === "split_person"
            ? "entity_split"
            : "import",
        change.reason,
        plan.sourceId,
        plan.batchId,
        {
          idempotencyKey: change.idempotencyKey,
          evidence: change.evidence,
          ruleVersion: "2026-11-11.1",
        },
      ],
    );
    return { auditId: audit, diff };
  }
}

async function merge(
  c: PoolClient,
  op: Extract<Operation, { kind: "merge_person" | "merge_organization" }>,
) {
  if (!op.evidence.length || op.canonicalId === op.duplicateId)
    throw new Error("Merge requires evidence and distinct targets");
  const person = op.kind === "merge_person",
    table = person ? "Person" : "Organization",
    column = person ? "personId" : "organizationId";
  const entities = (
    await c.query(
      `SELECT * FROM public."${table}" WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`,
      [[op.canonicalId, op.duplicateId]],
    )
  ).rows;
  if (entities.length !== 2)
    throw new StalePlanError(
      `${person ? "person" : "organization"}:${op.duplicateId}`,
    );
  const duplicate = entities.find((e) => e.id === op.duplicateId)!;
  // Preserve all reference rows; never delete a profile with unmoved associations.
  if (person) {
    const collisions = (
      await c.query(
        'SELECT 1 FROM public."RaceResult" a JOIN public."RaceResult" b ON a."raceId"=b."raceId" WHERE a."personId"=$1 AND b."personId"=$2 LIMIT 1',
        [op.canonicalId, op.duplicateId],
      )
    ).rowCount;
    if (collisions)
      throw new Error(
        "Merge plan must resolve overlapping race records explicitly",
      );
  } else {
    const collisions = (
      await c.query(
        'SELECT 1 FROM public."TeamCompetitionResult" a JOIN public."TeamCompetitionResult" b ON a."competitionEditionId"=b."competitionEditionId" WHERE a."organizationId"=$1 AND b."organizationId"=$2 LIMIT 1',
        [op.canonicalId, op.duplicateId],
      )
    ).rowCount;
    if (collisions)
      throw new Error("Organization merge has team result collision");
  }
  const move = person
    ? [
        "Membership",
        "RaceResult",
        "PersonalBest",
        "SourceReference",
        "NameVariant",
      ]
    : [
        "Membership",
        "RaceResult",
        "SourceReference",
        "NameVariant",
        "TeamCompetitionResult",
        "PersonalBest",
      ];
  const movedCounts: Record<string, number> = {};
  for (const t of move)
    movedCounts[t] =
      (
        await c.query(
          `UPDATE public."${t}" SET "${column}"=$1,"updatedAt"=clock_timestamp() WHERE "${column}"=$2`,
          [op.canonicalId, op.duplicateId],
        )
      ).rowCount ?? 0;
  const profileFields = person
    ? [
        "displayNameKana",
        "displayNameRoman",
        "displayNameZh",
        "displayNameEn",
        "birthDate",
        "hometown",
        "nationality",
        "heightCm",
        "weightKg",
      ]
    : [
        "nameKana",
        "nameRoman",
        "nameZh",
        "nameEn",
        "shortName",
        "location",
        "prefecture",
        "websiteUrl",
      ];
  for (const field of profileFields)
    await c.query(
      `UPDATE public."${table}" canonical SET "${field}"=COALESCE(canonical."${field}",duplicate."${field}") FROM public."${table}" duplicate WHERE canonical.id=$1 AND duplicate.id=$2`,
      [op.canonicalId, op.duplicateId],
    );
  const name = person ? duplicate.displayNameJa : duplicate.nameJa;
  await c.query(
    `INSERT INTO public."NameVariant" (id,value,type,"${column}","updatedAt") VALUES($1,$2,'former',$3,clock_timestamp())`,
    [randomUUID(), name, op.canonicalId],
  );
  if (person)
    await c.query(
      'DELETE FROM public."PlayerRelationCache" WHERE "personId"=ANY($1::text[])',
      [[op.canonicalId, op.duplicateId]],
    );
  await c.query(`DELETE FROM public."${table}" WHERE id=$1`, [op.duplicateId]);
  await c.query(
    `UPDATE public."${table}" SET "updatedAt"=clock_timestamp() WHERE id=$1`,
    [op.canonicalId],
  );
  return {
    canonical: entities.find((e) => e.id === op.canonicalId),
    duplicate,
    movedCounts,
  };
}
async function split(
  c: PoolClient,
  op: Extract<Operation, { kind: "split_person" }>,
) {
  if (
    !op.evidence.length ||
    op.target.id === op.fromPersonId ||
    (!op.raceResultIds.length && !op.membershipIds.length)
  )
    throw new Error("Split requires evidence and explicit associations");
  const from = (
    await c.query('SELECT id FROM public."Person" WHERE id=$1 FOR UPDATE', [
      op.fromPersonId,
    ])
  ).rowCount;
  if (!from) throw new StalePlanError(`person:${op.fromPersonId}`);
  await c.query(
    'INSERT INTO public."Person" (id,slug,"displayNameJa","displayNameJaSearch","birthDate","updatedAt") VALUES($1,$2,$3,$4,$5,clock_timestamp())',
    [
      op.target.id,
      op.target.slug,
      op.target.displayNameJa,
      normalizeName(op.target.displayNameJa),
      op.target.birthDate ?? null,
    ],
  );
  for (const [table, ids] of [
    ["RaceResult", op.raceResultIds],
    ["Membership", op.membershipIds],
    ["SourceReference", op.sourceReferenceIds],
  ] as const) {
    if (!ids.length) continue;
    const r = await c.query(
      `UPDATE public."${table}" SET "personId"=$1,"updatedAt"=clock_timestamp() WHERE id=ANY($2::text[]) AND "personId"=$3`,
      [op.target.id, ids, op.fromPersonId],
    );
    if (r.rowCount !== new Set(ids).size)
      throw new StalePlanError(`split:${table}`);
  }
  await c.query(
    'DELETE FROM public."PlayerRelationCache" WHERE "personId"=$1',
    [op.fromPersonId],
  );
  await c.query(
    'UPDATE public."Person" SET "updatedAt"=clock_timestamp() WHERE id=$1',
    [op.fromPersonId],
  );
}

function businessDiff(
  op: Operation,
  before: unknown,
): { before: unknown; after: unknown } {
  let after: Record<string, unknown>;
  switch (op.kind) {
    case "membership":
      after = {
        startDate: op.membership.startDate ?? null,
        endDate: op.membership.endDate ?? null,
        startDateBasis: op.membership.startBasis,
        endDateBasis: op.membership.endBasis,
        endState: op.membership.endState,
      };
      break;
    case "personal_best":
      after = {
        discipline: op.discipline,
        mark: op.mark,
        markMillis: op.markMillis,
        sourceId: op.sourceId,
      };
      break;
    case "person_fact":
      after = { [op.field]: op.value };
      break;
    case "race_result":
      after = {
        mark: op.row.mark ?? null,
        rank: op.row.rank ?? null,
        gradeAtRace: op.row.grade ?? null,
      };
      break;
    case "create_person":
      after = { displayNameJa: op.entity.displayNameJa };
      break;
    case "create_organization":
      after = { nameJa: op.entity.nameJa, type: op.entity.type };
      break;
    case "merge_person":
    case "merge_organization":
      after = { canonicalId: op.canonicalId, duplicateId: op.duplicateId };
      break;
    case "split_person":
      after = {
        fromPersonId: op.fromPersonId,
        targetId: op.target.id,
        movedRaceResults: op.raceResultIds.length,
        movedMemberships: op.membershipIds.length,
      };
      break;
    case "name_variant":
      after = { value: op.value };
      break;
    case "team_result":
      after = {
        finalRank: op.team.finalRank ?? null,
        finalMark: op.team.finalMark ?? null,
        cumulativeMark: op.team.cumulativeMark ?? null,
      };
      break;
    case "source_mapping":
      after = { targetId: op.targetId };
      break;
  }
  const original =
    before && typeof before === "object"
      ? (before as Record<string, unknown>)
      : null;
  return {
    before: original
      ? Object.fromEntries(
          Object.keys(after).map((k) => [k, original[k] ?? null]),
        )
      : null,
    after,
  };
}
