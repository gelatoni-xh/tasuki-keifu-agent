import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { withBusinessResearchContext } from "./research-context.js";
import { buildBatchGraph } from "./graph.js";
import {
  GovernanceDB,
  LeaseLostError,
  StalePlanError,
  type Task,
  type Batch,
} from "./database.js";
import {
  createResearcher,
  type ResearchConfig,
  type Researcher,
} from "./research.js";
import type { Plan } from "./contracts.js";
import type { PayloadStore } from "./storage.js";
import { BusinessWriter } from "./writer.js";
import { enqueueReport, needsAttention, type Report } from "./notifications.js";

export type RunnerOptions = {
  writeEnabled: boolean;
  research?: ResearchConfig;
  researcher?: Researcher;
  maxAttempts?: number;
  failAfterNode?: string;
  afterCommit?: () => Promise<void>;
  beforeApply?: () => Promise<void>;
};
export class EventRunner {
  constructor(
    readonly db: GovernanceDB,
    readonly store: PayloadStore,
    readonly saver: PostgresSaver,
    readonly options: RunnerOptions,
  ) {}
  async run(taskId?: string) {
    const task = await this.db.claim(taskId);
    if (!task) return null;
    let leaseError: unknown;
    const timer = setInterval(() => {
      this.db.heartbeat(task).catch((e) => {
        leaseError = e;
      });
    }, 20000);
    timer.unref();
    try {
      for (const batch of await this.db.batches(task.id)) {
        if (["completed", "completed_with_unresolved"].includes(batch.status)) {
          await this.finalizeCommittedBatch(task, batch.id);
          continue;
        }
        if (leaseError) throw leaseError;
        await this.runBatch(task, batch);
      }
      return await this.finish(task);
    } catch (error) {
      if (error instanceof LeaseLostError) throw error;
      await this.db.fenced(task, async (c) => {
        const message =
          error instanceof Error ? error.message : "unknown_execution_error";
        await c.query(
          'UPDATE governance."GovernanceBatch" SET status=\'failed\',"updatedAt"=clock_timestamp() WHERE "eventTaskId"=$1 AND status=\'running\'',
          [task.id],
        );
        await c.query(
          'UPDATE governance."EventImportTask" SET status=\'failed\',"errorMessage"=$2,"completedAt"=clock_timestamp(),"leaseToken"=NULL,"leaseUntil"=NULL WHERE id=$1',
          [task.id, message],
        );
        const report = await this.summary(task, "failed", message, c);
        await enqueueReport(
          c,
          { taskId: task.id },
          "event_summary",
          `event:${task.id}:failed:${report.completedBatches}`,
          report,
        );
        const batch = (
          await c.query(
            'SELECT id FROM governance."GovernanceBatch" WHERE "eventTaskId"=$1 AND status=\'failed\' ORDER BY sequence LIMIT 1',
            [task.id],
          )
        ).rows[0];
        if (batch)
          await enqueueReport(
            c,
            { batchId: batch.id },
            "batch_alert",
            `batch:${batch.id}:failure`,
            { taskId: task.id, reason: message },
          );
      });
      throw error;
    } finally {
      clearInterval(timer);
    }
  }
  private async runBatch(task: Task, batch: Batch) {
    await this.db.fenced(task, (c) =>
      c.query(
        'UPDATE governance."GovernanceBatch" SET status=\'running\',"updatedAt"=clock_timestamp() WHERE id=$1',
        [batch.id],
      ),
    );
    const input = await this.store.get(batch.rawPayloadRef, batch.payloadHash);
    let fresh = false;
    for (let n = 0; n < (this.options.maxAttempts ?? 3); n++) {
      const attempt = await this.db.attempt(task, batch, fresh);
      const reserve = async () =>
        this.db.fenced(task, async (c) => {
          const used = (
            await c.query(
              'SELECT COALESCE(sum(COALESCE((metrics->>\'researchReservations\')::int,0)),0)::int AS n FROM governance."BatchAttempt" WHERE "batchId"=$1',
              [batch.id],
            )
          ).rows[0].n;
          if (used >= (this.options.research?.maxRequests ?? 3)) return false;
          await c.query(
            "UPDATE governance.\"BatchAttempt\" SET metrics=jsonb_set(COALESCE(metrics,'{}'::jsonb),'{researchReservations}',to_jsonb(COALESCE((metrics->>'researchReservations')::int,0)+1)) WHERE id=$1",
            [attempt.id],
          );
          return true;
        });
      const research = withBusinessResearchContext(
        this.db,
        this.options.researcher ??
          createResearcher({
            ...this.options.research,
            timeoutMs: this.options.research?.timeoutMs ?? 25000,
            maxRequests: this.options.research?.maxRequests ?? 3,
            reserve,
          }),
      );
      const graph = buildBatchGraph({
        loadContext: () => this.db.loadContext(task, input),
        research,
        checkpointer: this.saver,
        failAfter: this.options.failAfterNode,
        onNode: async (name) => {
          await this.db.fenced(task, (c) =>
            c.query(
              "UPDATE governance.\"BatchAttempt\" SET metrics=COALESCE(metrics,'{}'::jsonb)||jsonb_build_object('currentNode',$2::text) WHERE id=$1",
              [attempt.id, name],
            ),
          );
        },
      });
      const config = {
        configurable: { thread_id: attempt.graphThreadId },
        recursionLimit: 100,
      };
      try {
        const snapshot = await graph.getState(config);
        let plan: Plan;
        if (snapshot.values?.plan && !snapshot.next.length)
          plan = snapshot.values.plan;
        else {
          const result = await graph.invoke(
            snapshot.values?.batchId
              ? null
              : { batchId: batch.id, input, mode: task.mode },
            config,
          );
          plan = result.plan;
        }
        await this.db.savePlan(task, attempt.id, plan);
        await this.options.beforeApply?.();
        await new BusinessWriter(this.db, this.options.writeEnabled).apply(
          task,
          plan,
        );
        await this.options.afterCommit?.();
        await this.db.fenced(task, async (c) => {
          await c.query(
            'UPDATE governance."BatchAttempt" SET status=\'succeeded\',"endedAt"=clock_timestamp() WHERE id=$1',
            [attempt.id],
          );
          if (needsAttention(plan.findings))
            await enqueueReport(
              c,
              { batchId: batch.id },
              "batch_alert",
              `batch:${batch.id}:unresolved`,
              {
                taskId: task.id,
                batchId: batch.id,
                mode: task.mode,
                summary: plan.summary,
                unresolved: plan.findings
                  .filter((f) => f.status === "unresolved")
                  .map((f) => ({
                    subjectRef: f.subjectRef,
                    reason: f.reason,
                    code: f.code,
                  })),
              },
            );
        });
        return;
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        await this.db.fenced(task, async (c) => {
          await c.query(
            'UPDATE governance."BatchAttempt" SET status=\'failed\',"endedAt"=clock_timestamp(),"errorMessage"=$2 WHERE id=$1',
            [
              attempt.id,
              error instanceof Error ? error.message : "unknown_error",
            ],
          );
        });
        // A committed batch must only be finalized, not re-planned after a crash.
        const done = (
          await this.db.pool.query(
            'SELECT status FROM governance."GovernanceBatch" WHERE id=$1',
            [batch.id],
          )
        ).rows[0];
        if (["completed", "completed_with_unresolved"].includes(done.status))
          throw error;
        fresh = error instanceof StalePlanError;
        if (fresh)
          await this.db.fenced(task, (c) =>
            c.query(
              "UPDATE governance.\"GovernanceChange\" SET status='superseded' WHERE \"batchId\"=$1 AND status='planned'",
              [batch.id],
            ),
          );
        if (n + 1 >= (this.options.maxAttempts ?? 3)) throw error;
      }
    }
  }
  private async finalizeCommittedBatch(task: Task, batchId: string) {
    await this.db.fenced(task, async (c) => {
      await c.query(
        'UPDATE governance."BatchAttempt" SET status=\'succeeded\',"endedAt"=COALESCE("endedAt",clock_timestamp()) WHERE "batchId"=$1 AND "attemptNo"=(SELECT MAX("attemptNo") FROM governance."BatchAttempt" WHERE "batchId"=$1)',
        [batchId],
      );
      const findings = (
        await c.query(
          'SELECT reason,"subjectRef","findingCode" AS code FROM governance."GovernanceFinding" WHERE "batchId"=$1 AND "resolutionStatus"=\'unresolved\' AND severity=\'serious\'',
          [batchId],
        )
      ).rows;
      if (findings.length)
        await enqueueReport(
          c,
          { batchId },
          "batch_alert",
          `batch:${batchId}:unresolved`,
          { taskId: task.id, batchId, unresolved: findings },
        );
    });
  }
  private async summary(
    task: Task,
    status: string,
    error?: string,
    queryable: Pick<import("pg").Pool, "query"> = this.db.pool,
  ): Promise<Report> {
    const batches = (
      await queryable.query(
        'SELECT status,summary FROM governance."GovernanceBatch" WHERE "eventTaskId"=$1',
        [task.id],
      )
    ).rows;
    const findings = (
      await queryable.query(
        'SELECT f.reason,f."subjectRef",f."findingCode" AS code FROM governance."GovernanceFinding" f JOIN governance."GovernanceBatch" b ON b.id=f."batchId" WHERE b."eventTaskId"=$1 AND f."resolutionStatus"=\'unresolved\'',
        [task.id],
      )
    ).rows;
    const done = batches.filter((b) =>
      ["completed", "completed_with_unresolved"].includes(b.status),
    );
    const sum = (key: string) =>
      done.reduce((n, b) => n + Number(b.summary?.[key] ?? 0), 0);
    return {
      taskId: task.id,
      mode: task.mode,
      status,
      importedRows: sum("importedRows"),
      plannedRows: sum("plannedRows"),
      changes: sum("changes"),
      repairs: sum("repairs"),
      plannedRepairs: sum("plannedRepairs"),
      unresolved: findings.length,
      completedBatches: done.length,
      totalBatches: batches.length,
      unresolvedDetails: findings,
      error,
    };
  }
  private async finish(task: Task) {
    return this.db.fenced(task, async (c) => {
      const unresolved = (
        await c.query(
          'SELECT 1 FROM governance."GovernanceFinding" f JOIN governance."GovernanceBatch" b ON b.id=f."batchId" WHERE b."eventTaskId"=$1 AND f."resolutionStatus"=\'unresolved\' LIMIT 1',
          [task.id],
        )
      ).rowCount;
      const status = unresolved ? "completed_with_unresolved" : "completed",
        report = await this.summary(task, status, undefined, c);
      await enqueueReport(
        c,
        { taskId: task.id },
        "event_summary",
        `event:${task.id}:completed`,
        report,
      );
      await c.query(
        'UPDATE governance."EventImportTask" SET status=$2,summary=$3,"completedAt"=clock_timestamp(),"updatedAt"=clock_timestamp(),"leaseToken"=NULL,"leaseUntil"=NULL WHERE id=$1',
        [task.id, status, report],
      );
      return report;
    });
  }
}
