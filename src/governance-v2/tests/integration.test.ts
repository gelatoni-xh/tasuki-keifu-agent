import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Pool } from "pg";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  GovernanceDB,
  LeaseLostError,
  createGovernancePool,
} from "../database.js";
import { DirectoryPayloadStore } from "../storage.js";
import { EventRunner } from "../runner.js";
import type { Researcher } from "../research.js";
import { CONTRACT_VERSION, manifestSchema } from "../contracts.js";
import { deliverNotifications, enqueueReport } from "../notifications.js";

const url = process.env.GOVERNANCE_TEST_DATABASE_URL;
if (!url)
  throw new Error(
    "Set an explicit isolated GOVERNANCE_TEST_DATABASE_URL; no .env fallback",
  );
const target = new URL(url);
if (
  !["localhost", "127.0.0.1"].includes(target.hostname) ||
  !target.pathname.endsWith("_test")
)
  throw new Error("Integration tests only run on a local *_test database");
const pool = createGovernancePool(url);
const db = new GovernanceDB(pool);
const saver = new PostgresSaver(pool, undefined, {
  schema: "governance_checkpoint",
});
const directory = await mkdtemp(
  path.join(os.tmpdir(), "tasuki-governance-tests-"),
);
const store = new DirectoryPayloadStore(directory);
after(async () => {
  await pool.end();
  await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE governance."EventImportTask",governance."GovernanceBatch",governance."BatchAttempt",governance."AgentExecution",governance."GovernanceFinding",governance."GovernanceChange",governance."NotificationDelivery" CASCADE',
  );
  await pool.query(
    'TRUNCATE public."Competition",public."Person",public."Organization",public."Source",public."AuditLog",public."CacheInvalidation" CASCADE',
  );
  await pool.query(`INSERT INTO public."Source" (id,name,type,reliability,"updatedAt") VALUES('s','公式','manual',4,now());
    INSERT INTO public."Competition" (id,slug,"nameJa","updatedAt") VALUES('c','test-event','試験駅伝',now());
    INSERT INTO public."CompetitionEdition" (id,"competitionId",slug,year,"officialName","updatedAt") VALUES('e','c','test-event-2024',2024,'試験駅伝2024',now());
    INSERT INTO public."Race" (id,"competitionEditionId",slug,name,discipline,leg,"startsAt","updatedAt") VALUES('r1','e','test-leg-1','1区','ekiden_leg',1,'2024-11-01',now()),('r2','e','test-leg-2','2区','ekiden_leg',2,'2024-11-01',now());
    INSERT INTO public."Organization" (id,slug,"nameJa",type,"updatedAt") VALUES('u','test-university','試験大学','university',now()),('h','test-high-school','試験高校','high_school',now());
    INSERT INTO public."Person" (id,slug,"displayNameJa","updatedAt") VALUES('p','test-athlete','試験太郎',now());
    INSERT INTO public."Membership" (id,"personId","organizationId",type,"updatedAt") VALUES('mh','p','h','enrolled',now());
    INSERT INTO public."SourceReference" (id,"sourceId","sourceEntityType","sourceEntityKey","personId","updatedAt") VALUES('ref','s','person','athlete-1','p',now());
    INSERT INTO public."PersonalBest" (id,"personId",discipline,mark,"markMillis","sourceId","updatedAt") VALUES('pb','p','m10000','29:00',1740000,'s',now());`);
  await saver.setup();
});
function manifest(key = "event-1", mode: "apply" | "dry_run" = "apply") {
  return {
    version: CONTRACT_VERSION,
    requestKey: key,
    eventEditionId: "e",
    mode,
    batches: [1, 2].map((leg, i) => ({
      unitType: "leg",
      unitKey: String(leg),
      sequence: i,
      sourceId: "s",
      raceSlug: `test-leg-${leg}`,
      organizations: [{ key: "u", name: "試験大学", type: "university" }],
      rows: [
        {
          key: `row-${leg}`,
          sourceKey: "athlete-1",
          name: "試験太郎",
          organizationKey: "u",
          grade: 1,
          memberships: [
            { organizationKey: "u", type: "enrolled", startDate: "2024-04-01" },
          ],
          pbs: [{ discipline: "m10000", mark: leg === 1 ? "28:00" : "28:30" }],
        },
      ],
    })),
  };
}
// Structured fixture for the new stages; severe-case evidence is supplied only
// by the existing deep-research fixture below.
function stagedFixture(deep: Researcher): Researcher {
  return async (request, metrics) => {
    if (request.kind === "normalization_cross_check") return { crossAnswer: { issues: [] }, evidence: [] };
    if (request.kind === "normalization_light" || request.kind === "organization_adjudication") {
      const items = (request.context as { items: Array<{ itemKey: string }> }).items;
      return { batchAnswer: { items: items.map(i => ({ itemKey: i.itemKey, verdict: "unresolved", targetId: null, evidenceRefs: [], reason: "需深入研究的竞争归属" })) }, evidence: [] };
    }
    return deep(request, metrics);
  };
}
const noResearch: Researcher = async request => {
  if (request.kind === "normalization_cross_check") return { crossAnswer: { issues: [] }, evidence: [] };
  assert.fail("Deterministic case invoked identity research");
};
test("official DNS is not a starter; DNF and DQ are starters without a valid mark", async () => {
  const input = manifestSchema.parse(manifest("starter-status"));
  input.batches = input.batches.slice(0, 1);
  const row = input.batches[0].rows[0];
  input.batches[0].rows = [
    { ...row, key: "dns", name: "欠場太郎", notes: "DNS 欠" },
    { ...row, key: "dnf", name: "途中太郎", notes: "DNF" },
    { ...row, key: "dq", name: "失格太郎", notes: "DQ,S5" },
    { ...row, key: "finish", name: "完走太郎", mark: "15:30.00" },
  ].map(({ sourceKey, memberships, pbs, grade, ...r }) => ({ ...r, memberships: [], pbs: [] }));
  const id = await db.submit(input, store);
  const report = await new EventRunner(db, store, saver, {
    writeEnabled: true,
    researcher: noResearch,
  }).run(id);
  assert.equal(report?.status, "completed");
  const results = (await pool.query('SELECT notes,mark,"isStarter","markMillis" FROM public."RaceResult" WHERE "raceId"=\'r1\'')).rows;
  assert.equal(results.length, 4);
  assert.equal(results.find(r => r.notes === "DNS 欠").isStarter, false);
  for (const notes of ["DNF", "DQ,S5"]) {
    const result = results.find(r => r.notes === notes);
    assert.equal(result.isStarter, true);
    assert.equal(result.markMillis, null);
  }
  assert.equal(results.find(r => r.mark === "15:30.00").isStarter, true);
});
test("two batches atomically import, improve existing high school, preserve better PB, and notify once", async () => {
  const id = await db.submit(manifest(), store);
  assert.equal(await db.submit(manifest(), store), id);
  await assert.rejects(
    db.submit({ ...manifest(), mode: "dry_run" }, store),
    /different input/,
  );
  const report = await new EventRunner(db, store, saver, {
    writeEnabled: true,
    researcher: noResearch,
  }).run(id);
  assert.equal(report?.status, "completed");
  assert.equal(report?.importedRows, 2);
  assert.ok(report?.observability?.eventDurationMs !== null);
  assert.ok((report?.observability?.eventDurationMs ?? 0) >= 0);
  assert.ok((report?.observability?.queueWaitMs ?? -1) >= 0);
  assert.equal(report?.observability?.attemptCount, 2);
  assert.equal(report?.observability?.retryCount, 0);
  assert.ok((report?.observability?.attemptDurationMs ?? 0) > 0);
  assert.equal(report?.observability?.resolved, 0);
  assert.equal(report?.observability?.unresolvedFindings, 0);
  assert.deepEqual(report?.observability?.modelUsage, []);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM public."RaceResult"'))
      .rows[0].n,
    2,
  );
  const high = (
    await pool.query("SELECT * FROM public.\"Membership\" WHERE id='mh'")
  ).rows[0];
  assert.equal(high.startYear, 2021);
  assert.equal(high.endYear, 2024);
  assert.equal(high.startDateBasis, "inferred");
  assert.equal(high.endState, "unknown");
  assert.equal(
    (
      await pool.query(
        'SELECT "markMillis" FROM public."PersonalBest" WHERE id=\'pb\'',
      )
    ).rows[0].markMillis,
    1680000,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM governance."NotificationDelivery"',
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    await new EventRunner(db, store, saver, { writeEnabled: true }).run(id),
    null,
  );
  let mails = 0;
  const subjects: string[] = [];
  await deliverNotifications(pool, async (m) => {
    mails++;
    subjects.push(m.subject);
    assert.match(m.text, /导入 2 条/);
  });
  await deliverNotifications(pool, async () => {
    mails++;
  });
  assert.equal(mails, 1);
  assert.match(subjects[0], /試験駅伝2024赛事治理总结/);
  const batchId = (await pool.query('SELECT id FROM governance."GovernanceBatch" ORDER BY sequence LIMIT 1')).rows[0].id;
  await enqueueReport(pool, { batchId }, "batch_alert", "subject-test", { taskId: id, reason: "test" });
  let alertSubject = "";
  assert.equal(await deliverNotifications(pool, async m => { alertSubject = m.subject; }), 1);
  assert.match(alertSubject, /試験駅伝2024第1区治理告警/);
});
test("dry-run stores plans and summary but writes no business rows", async () => {
  const id = await db.submit(manifest("dry", "dry_run"), store);
  const report = await new EventRunner(db, store, saver, {
    writeEnabled: false,
    researcher: noResearch,
  }).run(id);
  assert.equal(report?.importedRows, 0);
  assert.equal(report?.plannedRows, 2);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM public."RaceResult"'))
      .rows[0].n,
    0,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM public."AuditLog"'))
      .rows[0].n,
    0,
  );
});
test("apply switch cannot silently run a write task as dry-run", async () => {
  const id = await db.submit(manifest(), store);
  await assert.rejects(
    new EventRunner(db, store, saver, {
      writeEnabled: false,
      researcher: noResearch,
      maxAttempts: 1,
    }).run(id),
    /WRITE_ENABLED/,
  );
  assert.equal((await db.batches(id))[0].status, "failed");
  assert.equal((await db.batches(id))[1].status, "queued");
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM public."RaceResult"'))
      .rows[0].n,
    0,
  );
});
test("persisted checkpoint resumes an interrupted subgraph with a new runner instance", async () => {
  const id = await db.submit(manifest(), store);
  await assert.rejects(
    new EventRunner(db, store, saver, {
      writeEnabled: true,
      researcher: noResearch,
      maxAttempts: 1,
      failAfterNode: "person_resolve_identity",
    }).run(id),
    /Injected/,
  );
  await db.retry(id);
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "tsx", "src/governance-v2/tests/child-runner.ts", id],
      {
        cwd: process.cwd(),
        env: { ...process.env, GOVERNANCE_TEST_PAYLOAD_DIR: directory },
        encoding: "utf8",
      },
    ),
  );
  assert.equal(report?.importedRows, 2);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM public."RaceResult"'))
      .rows[0].n,
    2,
  );
});
test("crash after business commit does not duplicate import on retry", async () => {
  const id = await db.submit(manifest(), store);
  let injected = false;
  await assert.rejects(
    new EventRunner(db, store, saver, {
      writeEnabled: true,
      researcher: noResearch,
      maxAttempts: 1,
      afterCommit: async () => {
        if (!injected) {
          injected = true;
          throw new Error("after-commit-crash");
        }
      },
    }).run(id),
    /after-commit/,
  );
  const audit = (
    await pool.query('SELECT count(*)::int AS n FROM public."AuditLog"')
  ).rows[0].n;
  assert.equal((await db.batches(id))[0].status, "completed");
  await db.retry(id);
  const report = await new EventRunner(db, store, saver, {
    writeEnabled: true,
    researcher: noResearch,
  }).run(id);
  assert.equal(report?.importedRows, 2);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM public."RaceResult"'))
      .rows[0].n,
    2,
  );
  assert.ok(
    (await pool.query('SELECT count(*)::int AS n FROM public."AuditLog"'))
      .rows[0].n > audit,
  );
});
test("lease replacement fences old worker writes", async () => {
  const id = await db.submit(manifest(), store),
    old = await db.claim(id);
  assert.ok(old);
  await pool.query(
    'UPDATE governance."EventImportTask" SET "leaseUntil"=now()-interval \'1 second\' WHERE id=$1',
    [id],
  );
  const next = await db.claim(id);
  assert.ok(next);
  assert.notEqual(next.leaseToken, old.leaseToken);
  await assert.rejects(
    db.fenced(old, async () => {}),
    LeaseLostError,
  );
});
test("payload tampering is detected before governance", async () => {
  const id = await db.submit(manifest(), store),
    batch = (await db.batches(id))[0];
  await writeFile(
    path.join(directory, batch.rawPayloadRef),
    Buffer.from("tampered"),
  );
  await assert.rejects(store.get(batch.rawPayloadRef, batch.payloadHash));
  await assert.rejects(
    new EventRunner(db, store, saver, {
      writeEnabled: true,
      researcher: noResearch,
    }).run(id),
  );
  assert.equal((await db.batches(id))[0].status, "failed");
  assert.equal((await db.batches(id))[1].status, "queued");
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM governance.\"NotificationDelivery\" WHERE kind='batch_alert'",
      )
    ).rows[0].n,
    1,
  );
  const alert = (
    await pool.query(
      `SELECT payload FROM governance."NotificationDelivery" WHERE kind='batch_alert'`,
    )
  ).rows[0].payload as { summary?: { plannedRows?: number }; batchId?: string };
  assert.equal(alert.summary?.plannedRows, 1);
  assert.equal(alert.batchId, (await db.batches(id))[0].id);
});

test("identity unresolved still imports all rows and emits a batch alert", async () => {
  await pool.query(`INSERT INTO public."Person" (id,slug,"displayNameJa","updatedAt") VALUES('p2','second-athlete','試験太郎',now());
    INSERT INTO public."Membership" (id,"personId","organizationId",type,"updatedAt") VALUES('mp','p','u','enrolled',now()),('mp2','p2','u','enrolled',now());
    DELETE FROM public."SourceReference";`);
  const input = manifest("ambiguous");
  input.batches = input.batches.slice(0, 1);
  const id = await db.submit(input, store);
  let researchCalls = 0;
  const report = await new EventRunner(db, store, saver, {
    writeEnabled: true,
    researcher: stagedFixture(async () => {
      researchCalls++;
      return { answer: { verdict: "unresolved", targetId: null, duplicateIds: [], reason: "资料不足", evidence: [], corrections: [], split: null }, evidence: [] };
    }),
  }).run(id);
  assert.equal(report?.status, "completed_with_unresolved");
  assert.equal(report?.importedRows, 1);
  assert.equal(researchCalls, 1);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM public."RaceResult"'))
      .rows[0].n,
    1,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM governance."NotificationDelivery"',
      )
    ).rows[0].n,
    2,
  );
});

test("a transaction failure rolls back data, audit and change applied status together", async () => {
  await pool.query(`CREATE OR REPLACE FUNCTION governance.fail_test_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected_result_failure'; END $$;
    CREATE TRIGGER fail_test_result BEFORE INSERT ON public."RaceResult" FOR EACH ROW EXECUTE FUNCTION governance.fail_test_result();`);
  try {
    const id = await db.submit(manifest("rollback"), store);
    await assert.rejects(
      new EventRunner(db, store, saver, {
        writeEnabled: true,
        researcher: noResearch,
        maxAttempts: 1,
      }).run(id),
      /injected_result_failure/,
    );
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM public."RaceResult"'))
        .rows[0].n,
      0,
    );
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM public."AuditLog"'))
        .rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM governance.\"GovernanceChange\" WHERE status='applied'",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT "startYear" FROM public."Membership" WHERE id=\'mh\'',
        )
      ).rows[0].startYear,
      null,
    );
  } finally {
    await pool.query(
      'DROP TRIGGER fail_test_result ON public."RaceResult"; DROP FUNCTION governance.fail_test_result();',
    );
  }
});

test("mail failure persists retry and never changes imported business state", async () => {
  const id = await db.submit(manifest("mail"), store);
  await new EventRunner(db, store, saver, {
    writeEnabled: true,
    researcher: noResearch,
  }).run(id);
  await deliverNotifications(pool, async () => {
    throw new Error("SMTP down");
  });
  assert.equal(
    (await pool.query('SELECT status FROM governance."NotificationDelivery"'))
      .rows[0].status,
    "failed",
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM public."RaceResult"'))
      .rows[0].n,
    2,
  );
  await pool.query(
    'UPDATE governance."NotificationDelivery" SET "nextAttemptAt"=now()',
  );
  assert.equal(await deliverNotifications(pool, async () => {}), 1);
});

test("evidence-backed person merge moves associations and compares PB across both profiles", async () => {
  await pool.query(`INSERT INTO public."Person" (id,slug,"displayNameJa",hometown,"updatedAt") VALUES('p2','second-athlete','試験太郎','東京都',now());
    INSERT INTO public."Membership" (id,"personId","organizationId",type,"updatedAt") VALUES('mu1','p','u','enrolled',now()),('mu2','p2','u','enrolled',now());
    INSERT INTO public."PersonalBest" (id,"personId",discipline,mark,"markMillis","sourceId","updatedAt") VALUES('pb2','p2','m10000','27:00',1620000,'s',now());
    DELETE FROM public."SourceReference";`);
  const input = manifest("merge");
  input.batches = input.batches.slice(0, 1);
  const id = await db.submit(input, store);
  await new EventRunner(db, store, saver, {
    writeEnabled: true,
    researcher: stagedFixture(async (request) =>
      request.kind === "person_identity"
        ? {
            answer: {
              verdict: "merge",
              targetId: "p",
              duplicateIds: ["p2"],
              reason: "官方资料确认同一人",
              evidence: [
                { url: "https://example.org/official", quote: "同人" },
              ],
              corrections: [],
              split: null,
            },
            evidence: [{ url: "https://example.org/official" }],
          }
        : { stopReason: "no_more_sources", evidence: [] }),
  }).run(id);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM public.\"Person\" WHERE id='p2'",
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (await pool.query("SELECT hometown FROM public.\"Person\" WHERE id='p'"))
      .rows[0].hometown,
    "東京都",
  );
  assert.equal(
    (
      await pool.query(
        'SELECT min("markMillis") AS best FROM public."PersonalBest" WHERE "personId"=\'p\'',
      )
    ).rows[0].best,
    1620000,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM public."RaceResult" WHERE "personId"=\'p\'',
      )
    ).rows[0].n,
    1,
  );
});

test("a mixed-person split moves only evidence-selected associations and imports the new row", async () => {
  await pool.query(`INSERT INTO public."RaceResult" (id,"personId","raceId","organizationId",mark,"sourceId","updatedAt") VALUES('old-result','p','r2','h','31:00','s',now());
    UPDATE public."Person" SET "birthDate"='1990-01-01' WHERE id='p';`);
  const input = manifest("split");
  input.batches = input.batches.slice(0, 1);
  (input.batches[0].rows[0] as Record<string, unknown>).birthDate =
    "2005-01-01";
  const id = await db.submit(input, store);
  const report = await new EventRunner(db, store, saver, {
    writeEnabled: true,
    researcher: stagedFixture(async () => ({
      answer: {
        verdict: "split",
        targetId: null,
        duplicateIds: [],
        reason: "官方履历证明混人",
        evidence: [{ url: "https://example.org/official", quote: "新选手" }],
        corrections: [],
        split: {
          fromPersonId: "p",
          name: "試験太郎",
          raceResultIds: ["old-result"],
          membershipIds: ["mh"],
          sourceReferenceIds: [],
        },
      },
      evidence: [{ url: "https://example.org/official" }],
    })),
  }).run(id);
  assert.equal(report?.importedRows, 1);
  const target = (
    await pool.query(
      'SELECT "personId" FROM public."RaceResult" WHERE id=\'old-result\'',
    )
  ).rows[0].personId;
  assert.notEqual(target, "p");
  assert.equal(
    (
      await pool.query(
        'SELECT "personId" FROM public."Membership" WHERE id=\'mh\'',
      )
    ).rows[0].personId,
    target,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM public."RaceResult" WHERE "personId"=$1',
        [target],
      )
    ).rows[0].n,
    2,
  );
});

test("a stale plan reloads affected context rather than overwriting newer business data", async () => {
  const id = await db.submit(manifest("stale"), store);
  let injected = false;
  const report = await new EventRunner(db, store, saver, {
    writeEnabled: true,
    researcher: noResearch,
    beforeApply: async () => {
      if (injected) return;
      injected = true;
      await pool.query(
        "UPDATE public.\"Person\" SET hometown='大阪府',\"updatedAt\"=clock_timestamp() WHERE id='p'",
      );
    },
  }).run(id);
  assert.equal(report?.importedRows, 2);
  assert.equal(
    (await pool.query("SELECT hometown FROM public.\"Person\" WHERE id='p'"))
      .rows[0].hometown,
    "大阪府",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM governance.\"BatchAttempt\" WHERE status='superseded'",
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM public."RaceResult"'))
      .rows[0].n,
    2,
  );
});

test("model journal survives a crash before lightweight checkpoint commit without another physical call", async () => {
  await pool.query(`INSERT INTO public."Person" (id,slug,"displayNameJa","updatedAt") VALUES('p2','other-athlete','試験太郎',now());
    DELETE FROM public."SourceReference";`);
  const input = manifest("journal-recovery", "dry_run"); input.batches = input.batches.slice(0, 1);
  let lightweightCalls = 0;
  const research: Researcher = async (request, metrics) => {
    metrics.llmCalls++;
    if (request.kind === "normalization_light") { lightweightCalls++; }
    return stagedFixture(async () => ({ answer: { verdict: "unresolved", targetId: null, duplicateIds: [], reason: "独立证据不足", evidence: [], corrections: [], split: null }, evidence: [] }))(request, metrics);
  };
  const id = await db.submit(input, store);
  await assert.rejects(new EventRunner(db, store, saver, { writeEnabled: false,
    researcher: research, maxAttempts: 1, failAfterNode: "person_light_batch" }).run(id), /Injected/);
  assert.equal(lightweightCalls, 1);
  await db.retry(id);
  const report = await new EventRunner(db, store, saver, { writeEnabled: false, researcher: research }).run(id);
  assert.equal(lightweightCalls, 1);
  assert.equal(report?.observability?.llmCalls, 3);
  assert.equal(report?.observability?.estimatedCostUsd, null);
  assert.equal(report?.importedRows, 0);
});
