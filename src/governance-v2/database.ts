import { randomUUID } from "node:crypto";
import { Pool, types, type PoolClient } from "pg";
import { basis, fingerprint, normalizeName } from "./rules.js";
import {
  manifestSchema,
  type Manifest,
  type Context,
  type BatchInput,
  type Plan,
  type Membership,
  type Org,
  type Person,
  type PB,
} from "./contracts.js";
import type { PayloadStore } from "./storage.js";

// Prisma's business timestamps are UTC stored as timestamp-without-time-zone.
// node-postgres otherwise interprets them in the machine's local timezone.
export function createGovernancePool(
  connectionString: string,
  applicationName = "tasuki-governance-v2",
) {
  return new Pool({
    connectionString,
    application_name: applicationName,
    max: 6,
    types: {
      getTypeParser(oid: number, format?: "text" | "binary") {
        if (oid === 1114 && format !== "binary")
          return (value: string) => new Date(value.replace(" ", "T") + "Z");
        return types.getTypeParser(oid, format);
      },
    },
  });
}
export type Task = {
  id: string;
  mode: Manifest["mode"];
  status: string;
  inputManifest: { version: string; eventEditionId: string };
  leaseToken: string;
  manifestHash: string;
};
export type Batch = {
  id: string;
  status: string;
  rawPayloadRef: string;
  payloadHash: string;
  sequence: number;
};
export const iso = (v: unknown): string | undefined =>
  v == null ? undefined : new Date(v as string).toISOString();
const date = (v: unknown) => iso(v)?.slice(0, 10);
export class LeaseLostError extends Error {
  constructor() {
    super("Task lease expired or ownership changed");
  }
}
export class StalePlanError extends Error {
  constructor(ref: string) {
    super(`Business context changed: ${ref}`);
  }
}
export class GovernanceDB {
  constructor(
    readonly pool: Pool,
    readonly readPool: Pool = pool,
  ) {}
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async fenced<T>(task: Task, fn: (c: PoolClient) => Promise<T>) {
    return this.transaction(async (c) => {
      const result = await c.query(
        'SELECT id FROM governance."EventImportTask" WHERE id=$1 AND "leaseToken"=$2 AND "leaseUntil">clock_timestamp() AND status=\'running\' FOR UPDATE',
        [task.id, task.leaseToken],
      );
      if (!result.rowCount) throw new LeaseLostError();
      return fn(c);
    });
  }
  async submit(raw: unknown, store: PayloadStore) {
    const manifest = manifestSchema.parse(raw),
      hash = fingerprint(manifest);
    const refs = await Promise.all(manifest.batches.map((b) => store.put(b)));
    return this.transaction(async (c) => {
      // No full payload duplication: only a compact manifest and object references live in SQL.
      const compact = {
        version: manifest.version,
        eventEditionId: manifest.eventEditionId,
        batchCount: manifest.batches.length,
      };
      const ins = await c.query(
        'INSERT INTO governance."EventImportTask" (id,"requestKey","manifestHash",mode,"inputManifest") VALUES($1,$2,$3,$4,$5) ON CONFLICT("requestKey") DO NOTHING RETURNING id',
        [randomUUID(), manifest.requestKey, hash, manifest.mode, compact],
      );
      const task = (
        await c.query(
          'SELECT id,"manifestHash" FROM governance."EventImportTask" WHERE "requestKey"=$1 FOR UPDATE',
          [manifest.requestKey],
        )
      ).rows[0];
      if (task.manifestHash !== hash)
        throw new Error("requestKey was already used for different input/mode");
      if (ins.rowCount)
        for (const [i, b] of manifest.batches.entries()) {
          await c.query(
            'INSERT INTO governance."GovernanceBatch" (id,"eventTaskId","unitType","unitKey",sequence,"rawPayloadRef","payloadHash","payloadBytes","recordCount") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [
              randomUUID(),
              task.id,
              b.unitType,
              b.unitKey,
              b.sequence,
              refs[i].ref,
              refs[i].hash,
              refs[i].bytes,
              b.rows.length,
            ],
          );
        }
      return task.id as string;
    });
  }
  async claim(taskId?: string, leaseSeconds = 120): Promise<Task | null> {
    return this.transaction(async (c) => {
      const row = (
        await c.query(
          'SELECT * FROM governance."EventImportTask" WHERE ($1::uuid IS NULL OR id=$1) AND (status=\'queued\' OR (status=\'running\' AND "leaseUntil"<clock_timestamp())) AND "nextRunAt"<=clock_timestamp() ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1',
          [taskId ?? null],
        )
      ).rows[0];
      if (!row) return null;
      const token = randomUUID();
      await c.query(
        'UPDATE governance."EventImportTask" SET status=\'running\',"leaseToken"=$2,"leaseUntil"=clock_timestamp()+$3*interval \'1 second\',"heartbeatAt"=clock_timestamp(),"updatedAt"=clock_timestamp() WHERE id=$1',
        [row.id, token, leaseSeconds],
      );
      return { ...row, leaseToken: token } as Task;
    });
  }
  async heartbeat(task: Task, seconds = 120) {
    const r = await this.pool.query(
      'UPDATE governance."EventImportTask" SET "heartbeatAt"=clock_timestamp(),"leaseUntil"=clock_timestamp()+$3*interval \'1 second\' WHERE id=$1 AND "leaseToken"=$2 AND status=\'running\' AND "leaseUntil">clock_timestamp()',
      [task.id, task.leaseToken, seconds],
    );
    if (!r.rowCount) throw new LeaseLostError();
  }
  async batches(taskId: string): Promise<Batch[]> {
    return (
      await this.pool.query(
        'SELECT * FROM governance."GovernanceBatch" WHERE "eventTaskId"=$1 ORDER BY sequence',
        [taskId],
      )
    ).rows;
  }
  async attempt(task: Task, batch: Batch, fresh = false) {
    return this.fenced(task, async (c) => {
      const old = (
        await c.query(
          'SELECT * FROM governance."BatchAttempt" WHERE "batchId"=$1 ORDER BY "attemptNo" DESC LIMIT 1',
          [batch.id],
        )
      ).rows[0];
      if (old && !fresh && ["running", "failed"].includes(old.status)) {
        await c.query(
          'UPDATE governance."BatchAttempt" SET status=\'running\',"endedAt"=NULL WHERE id=$1',
          [old.id],
        );
        return old as { id: string; graphThreadId: string; attemptNo: number };
      }
      if (old)
        await c.query(
          "UPDATE governance.\"BatchAttempt\" SET status='superseded' WHERE id=$1 AND status<>'succeeded'",
          [old.id],
        );
      const id = randomUUID(),
        thread = randomUUID(),
        n = (old?.attemptNo ?? 0) + 1;
      await c.query(
        'INSERT INTO governance."BatchAttempt" (id,"batchId","attemptNo","graphThreadId","inputFingerprint") VALUES($1,$2,$3,$4,$5)',
        [id, batch.id, n, thread, batch.payloadHash],
      );
      await c.query(
        'UPDATE governance."GovernanceBatch" SET status=\'running\',"updatedAt"=clock_timestamp() WHERE id=$1',
        [batch.id],
      );
      return { id, graphThreadId: thread, attemptNo: n };
    });
  }
  async savePlan(task: Task, attemptId: string, plan: Plan) {
    await this.fenced(task, async (c) => {
      const executionIds: Record<string, string> = {};
      for (const a of plan.agents) {
        const r = await c.query(
          'INSERT INTO governance."AgentExecution" (id,"batchAttemptId","agentKey","agentVersion",status,"resultSummary",metrics,"endedAt") VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()) ON CONFLICT("batchAttemptId","agentKey","executionNo") DO UPDATE SET status=EXCLUDED.status,"resultSummary"=EXCLUDED."resultSummary",metrics=EXCLUDED.metrics,"endedAt"=EXCLUDED."endedAt" RETURNING id',
          [
            randomUUID(),
            attemptId,
            a.agentKey,
            "2026-11-11.1",
            a.skipped ? "skipped" : "succeeded",
            { findings: a.findings.length, changes: a.changes.length },
            a.metrics,
          ],
        );
        executionIds[a.agentKey] = r.rows[0].id;
      }
      await c.query(
        'DELETE FROM governance."GovernanceFinding" WHERE "batchId"=$1 AND NOT ("findingKey"=ANY($2::text[]))',
        [plan.batchId, plan.findings.map((f) => f.key)],
      );
      for (const f of plan.findings)
        await c.query(
          'INSERT INTO governance."GovernanceFinding" (id,"batchId","findingKey","findingCode","subjectRef",severity,"resolutionStatus",reason,"detailsAndEvidence","agentExecutionId") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT("batchId","findingKey") DO UPDATE SET "resolutionStatus"=EXCLUDED."resolutionStatus",reason=EXCLUDED.reason,"detailsAndEvidence"=EXCLUDED."detailsAndEvidence"',
          [
            randomUUID(),
            plan.batchId,
            f.key,
            f.code,
            f.subjectRef,
            f.severity,
            f.status,
            f.reason,
            { evidence: f.evidence },
            executionIds[
              f.code.startsWith("membership") ? "membership" : "normalization"
            ] ?? null,
          ],
        );
      for (const change of plan.changes)
        await c.query(
          'INSERT INTO governance."GovernanceChange" (id,"batchId","proposedByExecutionId","changeKey","idempotencyKey",operation,"entityRef","patchAndEvidence",revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,(SELECT COALESCE(MAX(revision),0)+1 FROM governance."GovernanceChange" WHERE "batchId"=$2 AND "changeKey"=$4)) ON CONFLICT("idempotencyKey") DO UPDATE SET "patchAndEvidence"=EXCLUDED."patchAndEvidence",status=\'planned\' WHERE governance."GovernanceChange".status IN (\'planned\',\'superseded\')',
          [
            randomUUID(),
            plan.batchId,
            executionIds[change.agentKey] ?? null,
            change.key,
            change.idempotencyKey,
            change.operation.kind,
            change.key,
            change,
          ],
        );
    });
  }
  async retry(taskId: string) {
    const r = await this.pool.query(
      'UPDATE governance."EventImportTask" SET status=\'queued\',"leaseToken"=NULL,"leaseUntil"=NULL,"completedAt"=NULL,"errorMessage"=NULL WHERE id=$1 AND status=\'failed\' RETURNING id',
      [taskId],
    );
    if (!r.rowCount) throw new Error("Only a failed task can be retried");
  }
  async loadContext(task: Task, input: BatchInput): Promise<Context> {
    const c = await this.readPool.connect();
    try {
      const race = (
        await c.query('SELECT * FROM public."Race" WHERE slug=$1', [
          input.raceSlug,
        ])
      ).rows[0];
      if (
        !race ||
        race.competitionEditionId !== task.inputManifest.eventEditionId
      )
        throw new Error("Race missing or not in requested event edition");
      const sources = (
        await c.query(
          'SELECT id,reliability FROM public."Source" WHERE id=ANY($1::text[])',
          [
            [
              ...new Set([
                input.sourceId,
                ...input.rows.flatMap((r) =>
                  r.pbs.map((p) => p.sourceId).filter(Boolean),
                ),
              ]),
            ],
          ],
        )
      ).rows;
      const source = sources.find((s) => s.id === input.sourceId);
      if (!source) throw new Error("Missing import source");
      const sourceMappings = (
        await c.query(
          'SELECT "sourceId","sourceEntityType" AS "entityType","sourceEntityKey" AS "sourceKey","personId","organizationId" FROM public."SourceReference" WHERE "sourceId"=$1 AND "sourceEntityKey"=ANY($2::text[])',
          [
            input.sourceId,
            [
              ...input.rows.map(
                (r) => r.sourceKey ?? `${input.raceSlug}:${r.key}`,
              ),
              ...input.organizations.map(
                (o) => o.sourceKey ?? `org:${normalizeName(o.name)}`,
              ),
            ],
          ],
        )
      ).rows;
      const names = input.rows
        .flatMap((r) =>
          [r.name, r.kana, r.roman].filter((n): n is string => !!n),
        )
        .map(normalizeName);
      const peopleRows = (
        await c.query(
          `SELECT p.*, COALESCE((SELECT array_agg(n.value) FROM public."NameVariant" n WHERE n."personId"=p.id),'{}') AS aliases FROM public."Person" p
        WHERE lower(regexp_replace(normalize(p."displayNameJa",NFKC),'[[:space:]・･]','','g'))=ANY($1::text[])
        OR lower(regexp_replace(normalize(COALESCE(p."displayNameKana",''),NFKC),'[[:space:]・･]','','g'))=ANY($1::text[]) OR lower(regexp_replace(normalize(COALESCE(p."displayNameRoman",''),NFKC),'[[:space:]・･]','','g'))=ANY($1::text[]) OR p.id=ANY($2::text[]) OR EXISTS(SELECT 1 FROM public."NameVariant" n WHERE n."personId"=p.id AND lower(regexp_replace(normalize(n.value,NFKC),'[[:space:]・･]','','g'))=ANY($1::text[]))`,
          [names, sourceMappings.map((m) => m.personId).filter(Boolean)],
        )
      ).rows;
      const people: Person[] = peopleRows.map((p) => ({
        ...p,
        aliases: [
          ...p.aliases,
          ...[p.displayNameKana, p.displayNameRoman].filter(Boolean),
        ],
        updatedAt: iso(p.updatedAt),
        birthDate: date(p.birthDate),
      }));
      const membershipsRows = (
        await c.query(
          'SELECT m.*,o.type AS "organizationType" FROM public."Membership" m JOIN public."Organization" o ON o.id=m."organizationId" WHERE m."personId"=ANY($1::text[])',
          [people.map((p) => p.id)],
        )
      ).rows;
      const memberships: Membership[] = membershipsRows.map((m) => ({
        id: m.id,
        personId: m.personId,
        organizationId: m.organizationId,
        type: m.type,
        organizationType: m.organizationType,
        startDate: date(m.startDate),
        endDate: date(m.endDate),
        startBasis: basis(m.startDateBasis),
        endBasis: basis(m.endDateBasis),
        updatedAt: iso(m.updatedAt),
        evidence: m.dateEvidence ?? {},
        endState: m.endState ?? "unknown",
        exclusivityGroup: m.exclusivityGroup ?? undefined,
      }));
      const orgNames = input.organizations.map((o) => normalizeName(o.name));
      const orgRows = (
        await c.query(
          `SELECT o.*, COALESCE((SELECT array_agg(n.value) FROM public."NameVariant" n WHERE n."organizationId"=o.id),'{}') AS aliases FROM public."Organization" o WHERE lower(regexp_replace(normalize(o."nameJa",NFKC),'[[:space:]・･]','','g'))=ANY($1::text[]) OR lower(regexp_replace(normalize(COALESCE(o."shortName",''),NFKC),'[[:space:]・･]','','g'))=ANY($1::text[]) OR LEFT(normalize(o."nameJa",NFKC),2)=ANY($3::text[]) OR o.slug=ANY($4::text[]) OR o.id=ANY($2::text[]) OR EXISTS(SELECT 1 FROM public."NameVariant" n WHERE n."organizationId"=o.id AND lower(regexp_replace(normalize(n.value,NFKC),'[[:space:]・･]','','g'))=ANY($1::text[]))`,
          [
            orgNames,
            [
              ...memberships.map((m) => m.organizationId),
              ...sourceMappings.map((m) => m.organizationId).filter(Boolean),
            ],
            input.organizations.map((o) =>
              o.name.normalize("NFKC").slice(0, 2),
            ),
            input.organizations.map((o) => o.slug).filter(Boolean),
          ],
        )
      ).rows;
      const organizations: Org[] = orgRows.map((o) => ({
        ...o,
        updatedAt: iso(o.updatedAt),
        aliases: [...o.aliases, ...(o.shortName ? [o.shortName] : [])],
      }));
      const pbs: PB[] = (
        await c.query(
          'SELECT p.*,COALESCE(s.reliability,0) AS reliability FROM public."PersonalBest" p LEFT JOIN public."Source" s ON s.id=p."sourceId" WHERE p."personId"=ANY($1::text[])',
          [people.map((p) => p.id)],
        )
      ).rows.map((p) => ({ ...p, updatedAt: iso(p.updatedAt) }));
      return {
        raceId: race.id,
        raceDate: date(race.startsAt),
        editionId: race.competitionEditionId,
        source,
        sources,
        people,
        organizations,
        memberships,
        pbs,
        sourceMappings,
      };
    } finally {
      c.release();
    }
  }
}
