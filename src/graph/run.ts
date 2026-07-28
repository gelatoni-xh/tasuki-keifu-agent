import { randomUUID } from "node:crypto";

import { createLogger } from "../lib/logger.js";
import { tracePersonDiagnosis } from "../lib/tracing.js";
import { PersonDiagnosisStateSchema, createInitialPersonDiagnosisState, type PersonDiagnosisState } from "../state/person-diagnosis.js";
import { buildPersonDiagnosisGraph } from "./person-diagnosis.js";
import {
  createAgentRun,
  finalizeAgentRun,
  recordAgentEvent,
  updateAgentRun,
  upsertDiagnosisResult,
} from "../db/repositories.js";

const logger = createLogger("person-diagnosis-runner");

export type RunPersonDiagnosisInput = {
  personSlug?: string | null;
  personId?: string | null;
  personName?: string | null;
  clarification?: string | null;
  triggeredBy?: "cli" | "admin_api";
  threadId?: string | null;
};

async function runPersonDiagnosisImpl(input: RunPersonDiagnosisInput) {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const threadId = input.threadId ?? runId;
  const graph = buildPersonDiagnosisGraph();
  const initialState = PersonDiagnosisStateSchema.parse(createInitialPersonDiagnosisState({
    runId,
    startedAt,
    threadId,
    triggeredBy: input.triggeredBy ?? "cli",
    personSlug: input.personSlug ?? null,
    personId: input.personId ?? null,
    personName: input.personName ?? null,
    clarification: input.clarification ?? null,
  }));

  await createAgentRun({
    runId,
    graphName: "person_diagnosis",
    threadId,
    payload: {
      personSlug: input.personSlug ?? null,
      personId: input.personId ?? null,
      personName: input.personName ?? null,
      clarification: input.clarification ?? null,
      triggeredBy: input.triggeredBy ?? "cli",
    },
  });

  await recordAgentEvent({
    runId,
    nodeName: "run",
    level: "info",
    message: "run_started",
    payload: {
      threadId,
      startedAt,
    },
  });

  try {
    const result = (await graph.invoke(initialState as PersonDiagnosisState, {
      configurable: {
        thread_id: threadId,
      },
    })) as PersonDiagnosisState;

    const diagnosisStatus = result.resultStatus ?? (result.runtimeStatus === "need_clarification" ? "need_clarification" : "completed");
    const runStatus = result.runtimeStatus === "need_clarification" ? "need_clarification" : "completed";

    await upsertDiagnosisResult({
      runId,
      personId: result.targetPersonId,
      personSlug: result.targetPersonSlug ?? input.personSlug ?? null,
      status: diagnosisStatus,
      summary: result.resultSummary,
      findings: result.findings,
      actions: result.actions,
      snapshot: {
        profile: result.profile,
        memberships: result.memberships,
        personalBests: result.personalBests,
        relationCache: result.relationCache,
      },
    });

    await finalizeAgentRun({
      runId,
      status: runStatus,
      currentNode: result.runtimeCurrentNode,
      output: {
        status: diagnosisStatus,
        summary: result.resultSummary,
        issueCount: result.findings.length,
        actionCount: result.actions.length,
      },
    });

    return {
      runId,
      threadId,
      state: result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("run_failed", { runId, message });
    await finalizeAgentRun({
      runId,
      status: "failed",
      currentNode: "failed",
      errorMessage: message,
    });
    await updateAgentRun({
      runId,
      status: "failed",
      currentNode: "failed",
      errorMessage: message,
    });
    throw error;
  }
}

export const runPersonDiagnosis = tracePersonDiagnosis(runPersonDiagnosisImpl);
