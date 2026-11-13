import type { GovernanceDB, Task } from "./database.js";
import { emptyMetrics, type Metrics } from "./contracts.js";
import type { Researcher, ResearchOutcome } from "./research.js";
import { fingerprint } from "./rules.js";

type Entry = { outcome: ResearchOutcome; metrics: Metrics };
// Persist each completed response before the graph node can publish its state.
// A crash before this journal commit may still consume an upstream request; its
// reservation remains visible and prevents unlimited recovery calls.
export function journalResearch(db: GovernanceDB, task: Task, attemptId: string,
  policy: unknown, research: Researcher): Researcher {
  return async (request, metrics) => {
    // Hash the JSON wire representation so Date values from PostgreSQL and
    // their checkpoint-restored ISO strings identify the same model request.
    const callId = fingerprint(JSON.parse(JSON.stringify({ request, policy })));
    const cached = await db.fenced(task, async c => (await c.query(
      `SELECT metrics->'modelJournal'->$2 AS entry FROM governance."BatchAttempt" WHERE id=$1`,
      [attemptId, callId],
    )).rows[0]?.entry as Entry | undefined);
    let entry = cached;
    if (!entry || (!entry.outcome.retryExhausted && !entry.outcome.answer && !entry.outcome.batchAnswer && !entry.outcome.crossAnswer && !["research_budget_exhausted", "research_not_configured", "research_has_no_verified_source_reference", "research_scope_too_large", "identity_footprint_too_large"].includes(entry.outcome.stopReason ?? ""))) {
      const usage = emptyMetrics();
      const outcome = await research(request, usage);
      if (cached) {
        if (cached.metrics.llmCalls && cached.metrics.costKnown !== true) usage.costKnown = false;
        for (const key of ["llmCalls", "networkCalls", "inputTokens", "outputTokens", "estimatedCostUsd"] as const)
          usage[key] += cached.metrics[key];
        usage.llmModels = [...new Set([...usage.llmModels, ...cached.metrics.llmModels])];
        usage.stoppedReasons.unshift(...cached.metrics.stoppedReasons);
        usage.researchCalls = [...cached.metrics.researchCalls ?? [], ...usage.researchCalls ?? []];
      }
      entry = { outcome, metrics: usage };
      await db.fenced(task, c => c.query(
        `UPDATE governance."BatchAttempt" SET metrics=jsonb_set(COALESCE(metrics,'{}'::jsonb),
          '{modelJournal}',COALESCE(metrics->'modelJournal','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb)) WHERE id=$1`,
        [attemptId, callId, JSON.stringify(entry)],
      ));
    }
    if (!(metrics.accountedCallIds ??= []).includes(callId)) {
      metrics.accountedCallIds.push(callId);
      for (const key of ["llmCalls", "networkCalls", "inputTokens", "outputTokens", "estimatedCostUsd"] as const)
        metrics[key] += entry.metrics[key];
      if (entry.metrics.llmCalls && entry.metrics.costKnown !== true) metrics.costKnown = false;
      else if (metrics.costKnown !== false) metrics.costKnown = true;
      metrics.llmModels = [...new Set([...metrics.llmModels, ...entry.metrics.llmModels])];
      metrics.stoppedReasons.push(...entry.metrics.stoppedReasons);
      (metrics.researchCalls ??= []).push(...(entry.metrics.researchCalls ?? []).map(c => ({ ...c,
        callId, stage: request.subjectRef,
        itemCount: (request.context as { items?: unknown[] })?.items?.length ?? 1,
      })));
    }
    return structuredClone(entry.outcome);
  };
}
