import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import pg from "pg";

// Explicitly scoped experiment reset, never a governance implementation.
const taskId = "a35d406e-efc6-465a-abe5-d011680408d2";
const requestKey = "nittai333-men5000-heat1-dry_run-v1";
const raceSlug = "nittaidai-long-distance-meet-333-men-5000-heat-1";
const artifactRoot = "/Users/xuhuan/workspace_new/document/333回增量治理准备";
const apply = process.argv.slice(2).includes("--apply");
if (process.argv.slice(2).some((arg) => arg !== "--apply")) {
  throw new Error("Only --apply is supported; default is read-only preview");
}
const env = dotenv.parse(await readFile(path.resolve("../tasuki-keifu/.env")));
const url = new URL(env.DATABASE_URL);
if (url.hostname !== "127.0.0.1" || url.pathname !== "/tasuki_keifu") {
  throw new Error("Unexpected database target");
}
url.port = "15433";
const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
try {
  await client.query(apply ? "BEGIN ISOLATION LEVEL REPEATABLE READ" : "BEGIN READ ONLY");
  const task = (await client.query(
    `SELECT * FROM governance."EventImportTask" WHERE id=$1 ${apply ? "FOR UPDATE" : ""}`,
    [taskId],
  )).rows[0];
  if (!task || task.requestKey !== requestKey || task.mode !== "dry_run" ||
      task.status !== "completed_with_unresolved" || Number(task.summary?.importedRows) !== 0) {
    throw new Error("Expected completed, unapplied dry-run task; refusing reset");
  }
  const batches = (await client.query(
    'SELECT * FROM governance."GovernanceBatch" WHERE "eventTaskId"=$1', [taskId],
  )).rows;
  if (batches.length !== 1 || batches[0].unitKey !== "men-5000-1" || batches[0].recordCount !== 44) {
    throw new Error("Unexpected batch scope");
  }
  const batchIds = batches.map((b) => b.id);
  const attempts = (await client.query(
    'SELECT * FROM governance."BatchAttempt" WHERE "batchId"=ANY($1::uuid[])', [batchIds],
  )).rows;
  if (attempts.some((a) => a.status !== "succeeded")) throw new Error("Nonterminal attempt");
  const threadIds = attempts.map((a) => a.graphThreadId);
  const filters: Array<[string, string, unknown[]]> = [
    ["governance.NotificationDelivery", '"eventTaskId"=$1 OR "batchId"=ANY($2::uuid[])', [taskId, batchIds]],
    ["governance.GovernanceChange", '"batchId"=ANY($1::uuid[])', [batchIds]],
    ["governance.GovernanceFinding", '"batchId"=ANY($1::uuid[])', [batchIds]],
    ["governance.AgentExecution", '"batchAttemptId"=ANY($1::uuid[])', [attempts.map((a) => a.id)]],
    ["governance.BatchAttempt", '"batchId"=ANY($1::uuid[])', [batchIds]],
    ["governance.GovernanceBatch", '"eventTaskId"=$1', [taskId]],
    ["governance.EventImportTask", 'id=$1', [taskId]],
    ...["checkpoint_blobs", "checkpoint_writes", "checkpoints"].map((name) =>
      [`governance_checkpoint.${name}`, "thread_id=ANY($1::text[])", [threadIds]] as [string, string, unknown[]]),
  ];
  const quoteTable = (table: string) => table.split(".").map((s) => `"${s}"`).join(".");
  const tables: Record<string, unknown[]> = {};
  for (const [table, filter, values] of filters) {
    // to_jsonb preserves bytea as PostgreSQL hex strings for recoverable snapshots.
    tables[table] = (await client.query(
      `SELECT to_jsonb(t) AS row FROM ${quoteTable(table)} t WHERE ${filter}`, values,
    )).rows.map((r) => r.row);
  }
  const changes = tables["governance.GovernanceChange"] as Array<{status: string; appliedAt: unknown; businessAuditRef: unknown}>;
  if (changes.some((c) => c.status !== "planned" || c.appliedAt || c.businessAuditRef)) {
    throw new Error("Applied or unexpected change detected; refusing reset");
  }
  const deliveries = tables["governance.NotificationDelivery"] as Array<{status: string}>;
  if (deliveries.some((n) => n.status !== "sent")) throw new Error("Notification may be active");
  const resultCount = async () => Number((await client.query(
    'SELECT count(*) FROM public."RaceResult" rr JOIN public."Race" r ON r.id=rr."raceId" WHERE r.slug=$1',
    [raceSlug],
  )).rows[0].count);
  if (await resultCount() !== 0) throw new Error("Target heat has business results; refusing reset");
  const counts = Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length]));
  console.log(JSON.stringify({ apply, taskId, counts, targetRaceResults: 0 }, null, 2));
  if (!apply) {
    await client.query("ROLLBACK");
  } else {
    const archive = path.join(artifactRoot, "archive", `rules-only-${taskId}-${Date.now()}`);
    await mkdir(archive, { recursive: true, mode: 0o700 });
    const snapshot = JSON.stringify({
      version: 1, archivedAt: new Date().toISOString(), taskId, requestKey, raceSlug,
      reason: "Invalid LLM-enabled baseline: research was not configured", tables,
    }, null, 2) + "\n";
    const snapshotPath = path.join(archive, "database-snapshot.json");
    await writeFile(snapshotPath, snapshot, { flag: "wx", mode: 0o600 });
    const snapshotHash = createHash("sha256").update(snapshot).digest("hex");
    for (const filename of ["result-dry_run.json", "task-dry_run.txt", "manifest-dry_run.json", "first-group-input.json"]) {
      await writeFile(path.join(archive, filename), await readFile(path.join(artifactRoot, filename)), { flag: "wx", mode: 0o600 });
    }
    for (const [table, filter, values] of filters) {
      const deleted = await client.query(`DELETE FROM ${quoteTable(table)} WHERE ${filter}`, values);
      if (deleted.rowCount !== counts[table]) throw new Error(`Unexpected delete count: ${table}`);
    }
    if (await resultCount() !== 0) throw new Error("Business result baseline changed");
    for (const [table, filter, values] of filters) {
      if (Number((await client.query(`SELECT count(*) FROM ${quoteTable(table)} WHERE ${filter}`, values)).rows[0].count) !== 0) {
        throw new Error(`Reset verification failed: ${table}`);
      }
    }
    await client.query("COMMIT");
    await writeFile(path.join(archive, "reset-receipt.json"), JSON.stringify({
      taskId, completedAt: new Date().toISOString(), snapshotHash, deleted: counts,
      targetRaceResults: 0, sentEmailRetracted: false, shellsRetained: true,
      rawPayloadRetained: true, nextRunSubmitted: false,
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(`Archived and reset: ${archive}`);
  }
} catch (error) {
  await client.query("ROLLBACK");
  // Database errors can contain connection details; do not print raw objects.
  console.error(error instanceof Error ? error.message : "Reset failed");
  process.exitCode = 1;
} finally {
  await client.end();
}
