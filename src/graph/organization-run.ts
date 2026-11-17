import { randomUUID } from "node:crypto";

import {
  createAgentRun,
  finalizeAgentRun,
  recordAgentEvent,
  upsertDiagnosisResult,
} from "../db/repositories.js";
import { traceOrganizationDiagnosis } from "../lib/tracing.js";
import {
  createInitialOrganizationDiagnosisState,
  OrganizationDiagnosisStateSchema,
  type OrganizationDiagnosisState,
} from "../types/organization-diagnosis.js";
import { buildOrganizationDiagnosisGraph } from "./organization-diagnosis.js";

export type RunOrganizationDiagnosisInput = {
  organizationSlug?: string | null;
  organizationId?: string | null;
  organizationName?: string | null;
  threadId?: string | null;
};

async function runOrganizationDiagnosisImpl(input: RunOrganizationDiagnosisInput) {
  const runId = randomUUID();
  const threadId = input.threadId ?? runId;
  const startedAt = new Date().toISOString();
  const initialState = OrganizationDiagnosisStateSchema.parse(createInitialOrganizationDiagnosisState({
    runId,
    startedAt,
    threadId,
    organizationSlug: input.organizationSlug,
    organizationId: input.organizationId,
    organizationName: input.organizationName,
  }));

  await createAgentRun({
    runId,
    graphName: "organization_diagnosis",
    threadId,
    payload: input,
  });
  await recordAgentEvent({
    runId,
    nodeName: "run",
    level: "info",
    message: "run_started",
    payload: { threadId, startedAt },
  });

  try {
    const graph = buildOrganizationDiagnosisGraph();
    const state = await graph.invoke(initialState as OrganizationDiagnosisState, {
      configurable: { thread_id: threadId },
    }) as OrganizationDiagnosisState;
    const runStatus = state.runtimeStatus === "failed"
      ? "failed"
      : state.runtimeStatus === "need_clarification"
        ? "need_clarification"
        : "completed";
    await upsertDiagnosisResult({
      runId,
      status: state.resultStatus ?? "completed",
      summary: state.resultSummary,
      findings: state.findings,
      actions: state.actions,
      snapshot: {
        subjectType: "organization",
        organization: state.organization,
        referenceStats: state.referenceStats,
        actionBundle: state.actionBundle,
      },
    });
    await finalizeAgentRun({
      runId,
      status: runStatus,
      currentNode: state.runtimeCurrentNode,
      output: {
        subjectType: "organization",
        organizationId: state.targetOrganizationId,
        organizationSlug: state.targetOrganizationSlug,
        issueCount: state.findings.length,
        actionCount: state.actions.length,
        actionRiskLevel: state.actionRiskAssessment?.level ?? null,
      },
    });
    return { runId, threadId, state };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finalizeAgentRun({ runId, status: "failed", currentNode: "failed", errorMessage: message });
    throw error;
  }
}

export const runOrganizationDiagnosis = traceOrganizationDiagnosis(runOrganizationDiagnosisImpl);
