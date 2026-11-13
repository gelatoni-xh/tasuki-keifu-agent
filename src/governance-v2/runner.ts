import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { journalResearch } from "./research-journal.js";
import { NORMALIZATION_POLICY_VERSION } from "./normalization.js";
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
  inputCostPerMillionUsd?: number;
  outputCostPerMillionUsd?: number;
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
            'SELECT id,"recordCount" FROM governance."GovernanceBatch" WHERE "eventTaskId"=$1 AND status=\'failed\' ORDER BY sequence LIMIT 1',
            [task.id],
          )
        ).rows[0];
        if (batch)
          await enqueueReport(
            c,
            { batchId: batch.id },
            "batch_alert",
            `batch:${batch.id}:failure`,
            {
              taskId: task.id,
              batchId: batch.id,
              mode: task.mode,
              reason: message,
              summary: {
                plannedRows: Number(batch.recordCount ?? 0),
                importedRows: 0,
                repairs: 0,
                plannedRepairs: 0,
                unresolved: 0,
              },
            },
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
      const reserve = async (kind: import("./research.js").ResearchRequest["kind"]) =>
        this.db.fenced(task, async (c) => {
          const normalization = kind.startsWith("normalization_") || kind === "organization_adjudication";
          const field = normalization ? "normalizationReservations" : "researchReservations";
          const used = (await c.query(
            `SELECT COALESCE(sum(COALESCE((metrics->>$2)::int,0)),0)::int AS n FROM governance."BatchAttempt" WHERE "batchId"=$1`,
            [batch.id, field],
          )).rows[0].n;
          if (used >= (normalization ? 5 : this.options.research?.maxRequests ?? 3)) return false;
          await c.query(
            `UPDATE governance."BatchAttempt" SET metrics=jsonb_set(COALESCE(metrics,'{}'::jsonb),ARRAY[$2::text],to_jsonb(COALESCE((metrics->>$2)::int,0)+1)) WHERE id=$1`,
            [attempt.id, field],
          );
          return true;
        });
      const research = journalResearch(this.db, task, attempt.id, {
        policy: NORMALIZATION_POLICY_VERSION, model: this.options.research?.model,
        endpoint: this.options.research?.baseUrl,
      }, withBusinessResearchContext(
        this.db,
        this.options.researcher ??
          createResearcher({
            ...this.options.research,
            timeoutMs: this.options.research?.timeoutMs ?? 25000,
            maxRequests: this.options.research?.maxRequests ?? 3,
            inputCostPerMillionUsd: this.options.inputCostPerMillionUsd,
            outputCostPerMillionUsd: this.options.outputCostPerMillionUsd,
            reserve,
          }),
      ));
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
    const taskRow = (
      await queryable.query(
        'SELECT "createdAt","completedAt" FROM governance."EventImportTask" WHERE id=$1',
        [task.id],
      )
    ).rows[0];
    const batches = (
      await queryable.query(
        'SELECT status,summary,"recordCount" FROM governance."GovernanceBatch" WHERE "eventTaskId"=$1',
        [task.id],
      )
    ).rows;
    const findings = (
      await queryable.query(
        'SELECT f.reason,f."subjectRef",f."findingCode" AS code FROM governance."GovernanceFinding" f JOIN governance."GovernanceBatch" b ON b.id=f."batchId" WHERE b."eventTaskId"=$1 AND f."resolutionStatus"=\'unresolved\'',
        [task.id],
      )
    ).rows;
    const findingCounts = (
      await queryable.query(
        `SELECT f."resolutionStatus",count(*)::int AS count
         FROM governance."GovernanceFinding" f
         JOIN governance."GovernanceBatch" b ON b.id=f."batchId"
         WHERE b."eventTaskId"=$1 GROUP BY f."resolutionStatus"`,
        [task.id],
      )
    ).rows;
    const attemptStats = (
      await queryable.query(
        `SELECT count(*)::int AS "attemptCount",
                count(*) FILTER (WHERE ba."attemptNo">1)::int AS "retryCount",
                COALESCE(sum(GREATEST(0,extract(epoch FROM (COALESCE(ba."endedAt",clock_timestamp())-ba."startedAt"))*1000)),0)::bigint AS "attemptDurationMs",
                COALESCE(sum(GREATEST(0,extract(epoch FROM (COALESCE(ba."endedAt",clock_timestamp())-ba."startedAt"))*1000)) FILTER (WHERE ba."attemptNo">1),0)::bigint AS "retryDurationMs",
                min(ba."startedAt") AS "firstAttemptAt"
         FROM governance."BatchAttempt" ba
         JOIN governance."GovernanceBatch" gb ON gb.id=ba."batchId"
         WHERE gb."eventTaskId"=$1`,
        [task.id],
      )
    ).rows[0];
    const done = batches.filter((b) =>
      ["completed", "completed_with_unresolved"].includes(b.status),
    );
    const sum = (key: string) =>
      done.reduce((n, b) => n + Number(b.summary?.[key] ?? 0), 0);
    const executions = (
      await queryable.query(
        `SELECT ae.metrics,ae."batchAttemptId"
         FROM governance."AgentExecution" ae
         JOIN governance."BatchAttempt" ba ON ba.id=ae."batchAttemptId"
         JOIN governance."GovernanceBatch" gb ON gb.id=ba."batchId"
         WHERE gb."eventTaskId"=$1`,
        [task.id],
      )
    ).rows;
    const failedAttempts = (
      await queryable.query(
        `SELECT ba.id,ba.metrics
         FROM governance."BatchAttempt" ba
         JOIN governance."GovernanceBatch" gb ON gb.id=ba."batchId"
         WHERE gb."eventTaskId"=$1 AND ba.status='failed'`,
        [task.id],
      )
    ).rows;
    const observability = executions.reduce(
      (acc, row) => {
        const metrics = (row.metrics ?? {}) as Record<string, unknown>;
        acc.llmCalls += Number(metrics.llmCalls ?? 0);
        acc.networkCalls += Number(metrics.networkCalls ?? 0);
        acc.ruleDecisions += Number(metrics.ruleDecisions ?? 0);
        acc.inputTokens += Number(metrics.inputTokens ?? 0);
        acc.outputTokens += Number(metrics.outputTokens ?? 0);
        acc.estimatedCostUsd += Number(metrics.estimatedCostUsd ?? 0);
        if (Number(metrics.llmCalls ?? 0) > 0 && metrics.costKnown !== true) acc.costKnown = false;
        for (const model of Array.isArray(metrics.llmModels) ? metrics.llmModels : [])
          if (typeof model === "string" && !acc.llmModels.includes(model)) acc.llmModels.push(model);
        acc.agentExecutions++;
        acc.agentDurationMs += Number(metrics.durationMs ?? 0);
        return acc;
      },
      { costKnown: true, llmCalls: 0, networkCalls: 0, ruleDecisions: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, llmModels: [] as string[], agentExecutions: 0, agentDurationMs: 0, modelUsage: new Map<string, { calls: number; inputTokens: number; outputTokens: number }>() },
    );
    const addMetrics = (metrics: Record<string, unknown>) => {
      observability.llmCalls += Number(metrics.llmCalls ?? 0);
      observability.networkCalls += Number(metrics.networkCalls ?? 0);
      observability.ruleDecisions += Number(metrics.ruleDecisions ?? 0);
      observability.inputTokens += Number(metrics.inputTokens ?? 0);
      observability.outputTokens += Number(metrics.outputTokens ?? 0);
      observability.estimatedCostUsd += Number(metrics.estimatedCostUsd ?? 0);
      if (Number(metrics.llmCalls ?? 0) > 0 && metrics.costKnown !== true) observability.costKnown = false;
      for (const model of Array.isArray(metrics.llmModels) ? metrics.llmModels : [])
        if (typeof model === "string" && !observability.llmModels.includes(model)) observability.llmModels.push(model);
    };
    for (const row of failedAttempts) {
      const metrics = (row.metrics ?? {}) as Record<string, unknown>;
      const journal = metrics.modelJournal;
      if (!journal || typeof journal !== "object") continue;
      const accounted = new Set(executions
        .filter((execution) => execution.batchAttemptId === row.id)
        .flatMap((execution) => execution.metrics?.accountedCallIds ?? []));
      for (const [callId, entry] of Object.entries(journal as Record<string, unknown>)) {
        if (accounted.has(callId)) continue;
        if (!entry || typeof entry !== "object") continue;
        const entryMetrics = (entry as { metrics?: unknown }).metrics;
        if (entryMetrics && typeof entryMetrics === "object") {
          const metrics = entryMetrics as Record<string, unknown>;
          addMetrics(metrics);
          for (const call of Array.isArray(metrics.researchCalls) ? metrics.researchCalls : []) {
            if (!call || typeof call !== "object") continue;
            const item = call as Record<string, unknown>;
            if (typeof item.model !== "string") continue;
            const usage = observability.modelUsage.get(item.model) ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
            usage.calls++;
            usage.inputTokens += Number(item.inputTokens ?? 0);
            usage.outputTokens += Number(item.outputTokens ?? 0);
            observability.modelUsage.set(item.model, usage);
          }
        }
      }
    }
    for (const row of executions) {
      const metrics = (row.metrics ?? {}) as Record<string, unknown>;
      for (const call of Array.isArray(metrics.researchCalls) ? metrics.researchCalls : []) {
        if (!call || typeof call !== "object") continue;
        const item = call as Record<string, unknown>;
        if (typeof item.model !== "string") continue;
        const usage = observability.modelUsage.get(item.model) ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
        usage.calls++;
        usage.inputTokens += Number(item.inputTokens ?? 0);
        usage.outputTokens += Number(item.outputTokens ?? 0);
        observability.modelUsage.set(item.model, usage);
      }
    }
    const createdAt = taskRow?.createdAt ? new Date(taskRow.createdAt).getTime() : 0;
    const completedAt = taskRow?.completedAt ? new Date(taskRow.completedAt).getTime() : 0;
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
      failedBatches: batches.filter((b) => b.status === "failed").length,
      failedRows: batches.filter((b) => b.status === "failed").reduce((n, b) => n + Number(b.recordCount ?? 0), 0),
      unresolvedDetails: findings,
      observability: {
        llmCalls: observability.llmCalls,
        networkCalls: observability.networkCalls,
        ruleDecisions: observability.ruleDecisions,
        inputTokens: observability.inputTokens,
        outputTokens: observability.outputTokens,
        estimatedCostUsd: observability.costKnown ? observability.estimatedCostUsd : null,
        costKnown: observability.costKnown,
        llmModels: observability.llmModels,
        agentExecutions: observability.agentExecutions,
        agentDurationMs: observability.agentDurationMs,
        modelUsage: [...observability.modelUsage.entries()].map(([model, usage]) => ({ model, ...usage })),
        eventDurationMs: createdAt && completedAt ? completedAt - createdAt : null,
        queueWaitMs:
          createdAt && attemptStats?.firstAttemptAt
            ? Math.max(0, new Date(attemptStats.firstAttemptAt).getTime() - createdAt)
            : null,
        attemptCount: Number(attemptStats?.attemptCount ?? 0),
        retryCount: Number(attemptStats?.retryCount ?? 0),
        attemptDurationMs: Number(attemptStats?.attemptDurationMs ?? 0),
        retryDurationMs: Number(attemptStats?.retryDurationMs ?? 0),
        resolved: findingCounts
          .filter((f) => f.resolutionStatus === "resolved")
          .reduce((n, f) => n + Number(f.count), 0),
        unresolvedFindings: findingCounts
          .filter((f) => f.resolutionStatus === "unresolved")
          .reduce((n, f) => n + Number(f.count), 0),
        costPerImportedRowUsd:
          sum("importedRows") > 0 && observability.costKnown
            ? observability.estimatedCostUsd / sum("importedRows")
            : null,
        costPerPlannedRowUsd:
          sum("plannedRows") > 0 && observability.costKnown
            ? observability.estimatedCostUsd / sum("plannedRows")
            : null,
      },
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
      const status = unresolved ? "completed_with_unresolved" : "completed";
      await c.query(
        'UPDATE governance."EventImportTask" SET status=$2,"completedAt"=clock_timestamp(),"updatedAt"=clock_timestamp() WHERE id=$1',
        [task.id, status],
      );
      const report = await this.summary(task, status, undefined, c);
      await enqueueReport(
        c,
        { taskId: task.id },
        "event_summary",
        `event:${task.id}:completed`,
        report,
      );
      await c.query(
        'UPDATE governance."EventImportTask" SET summary=$2,"leaseToken"=NULL,"leaseUntil"=NULL WHERE id=$1',
        [task.id, report],
      );
      return report;
    });
  }
}
