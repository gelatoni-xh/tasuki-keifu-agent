import { randomUUID } from "node:crypto";

import { env } from "../config/env.js";
import { agentPrisma } from "../db/agent-prisma.js";
import { listGovernanceCandidates, type GovernanceCandidate } from "../db/business-queries.js";
import {
  createActionExecution,
  createGovernanceBatch,
  createGovernanceSubject,
  finalizeGovernanceBatch,
  finalizeGovernanceSubject,
  findLatestFinalizedGovernance,
} from "../db/repositories.js";
import { runPersonDiagnosis } from "../graph/run.js";
import { createLogger } from "../lib/logger.js";
import type { PersonDiagnosisState } from "../state/person-diagnosis.js";
import { executeAction } from "./action-executor.js";

const logger = createLogger("governance-batch-runner");

export type RunGovernanceBatchInput = {
  limit?: number;
  dryRun?: boolean;
};

type BatchSubjectResult = {
  personId: string;
  personSlug: string;
  status: "completed" | "held" | "failed";
  riskLevel: "low" | "medium" | "high" | null;
  actionCount: number;
  reason: string | null;
};

function isWriteEnabled() {
  return env.TASUKI_AGENT_WRITE_ENABLED?.trim().toLowerCase() === "true";
}

function isWriteConfigured() {
  return Boolean(env.TASUKI_KEIFU_BUSINESS_WRITE_DATABASE_URL?.trim());
}

async function isDueForGovernance(candidate: GovernanceCandidate) {
  const latest = await findLatestFinalizedGovernance(candidate.personId);
  if (!latest?.completedAt) {
    return true;
  }

  return new Date(candidate.businessUpdatedAt) > latest.completedAt;
}

function actionExecutionStatus(input: {
  state: PersonDiagnosisState;
}) {
  if (input.state.actionRiskAssessment?.executionStatus === "skipped") {
    return "skipped" as const;
  }

  if (input.state.actionRiskAssessment?.level === "high") {
    return "held" as const;
  }

  return input.state.actionRiskAssessment?.executionStatus === "held" ? "held" as const : "planned" as const;
}

async function executeActionBundle(input: {
  subjectId: string;
  dryRun: boolean;
  state: PersonDiagnosisState;
}) {
  const status = actionExecutionStatus(input);
  const reason = input.state.actionRiskAssessment?.reasons.join("；") ?? null;

  for (const action of input.state.actionBundle?.items ?? []) {
    const previousSuccess = await agentPrisma.actionExecution.findFirst({
      where: {
        idempotencyKey: action.idempotencyKey,
        status: "succeeded",
      },
      select: { id: true },
    });

    if (previousSuccess) {
      await createActionExecution({
        subjectId: input.subjectId,
        actionCode: action.code,
        idempotencyKey: action.idempotencyKey,
        action,
        status: "skipped",
        result: { reason: "idempotency_key_already_succeeded", previousExecutionId: previousSuccess.id },
      });
      continue;
    }

    if (status === "held") {
      await createActionExecution({
        subjectId: input.subjectId,
        actionCode: action.code,
        idempotencyKey: action.idempotencyKey,
        action,
        status: "held",
        errorMessage: reason,
      });
      continue;
    }

    if (input.dryRun) {
      await createActionExecution({
        subjectId: input.subjectId,
        actionCode: action.code,
        idempotencyKey: action.idempotencyKey,
        action,
        status: "planned",
        result: { mode: "dry_run" },
      });
      continue;
    }

    try {
      const result = await executeAction(action);
      await createActionExecution({
        subjectId: input.subjectId,
        actionCode: action.code,
        idempotencyKey: action.idempotencyKey,
        action,
        status: "succeeded",
        result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await createActionExecution({
        subjectId: input.subjectId,
        actionCode: action.code,
        idempotencyKey: action.idempotencyKey,
        action,
        status: "failed",
        errorMessage: message,
      });
      throw error;
    }
  }
}

async function runSubject(input: {
  batchId: string;
  dryRun: boolean;
  candidate: GovernanceCandidate;
}): Promise<BatchSubjectResult> {
  const subject = await createGovernanceSubject({
    batchId: input.batchId,
    personId: input.candidate.personId,
    personSlug: input.candidate.personSlug,
    businessUpdatedAt: new Date(input.candidate.businessUpdatedAt),
  });

  try {
    const diagnosis = await runPersonDiagnosis({
      personId: input.candidate.personId,
      personSlug: input.candidate.personSlug,
      triggeredBy: "cli",
      threadId: `governance:${input.batchId}:${input.candidate.personId}`,
    });
    const state = diagnosis.state;
    const risk = state.actionRiskAssessment;
    const actionCount = state.actionBundle?.items.length ?? 0;
    const holdReason = risk?.reasons.join("；") ?? null;

    await executeActionBundle({
      subjectId: subject.id,
      dryRun: input.dryRun,
      state,
    });

    const held = risk?.executionStatus === "held";
    await finalizeGovernanceSubject({
      subjectId: subject.id,
      diagnosisRunId: diagnosis.runId,
      status: held ? "held" : "completed",
      riskLevel: risk?.level ?? null,
      findings: state.findings,
      actionBundle: state.actionBundle,
      holdReason,
    });

    return {
      personId: input.candidate.personId,
      personSlug: input.candidate.personSlug,
      status: held ? "held" : "completed",
      riskLevel: risk?.level ?? null,
      actionCount,
      reason: holdReason,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finalizeGovernanceSubject({
      subjectId: subject.id,
      status: "failed",
      errorMessage: message,
    });
    throw error;
  }
}

export async function runGovernanceBatch(input: RunGovernanceBatchInput = {}) {
  const batchId = randomUUID();
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const requestedDryRun = input.dryRun ?? true;
  const dryRun = requestedDryRun || !isWriteEnabled() || !isWriteConfigured();

  if (!requestedDryRun && (!isWriteEnabled() || !isWriteConfigured())) {
    logger.warn("write_mode_not_enabled", {
      batchId,
      message: "Write mode requires TASUKI_AGENT_WRITE_ENABLED=true and TASUKI_KEIFU_BUSINESS_WRITE_DATABASE_URL; batch is running as dry-run.",
    });
  }

  await createGovernanceBatch({
    batchId,
    dryRun,
    payload: {
      limit,
      requestedDryRun,
      writeEnabled: isWriteEnabled(),
      writeConfigured: isWriteConfigured(),
    },
  });

  try {
    // Fetch extra candidates because recently governed people are filtered in the agent database.
    const candidates = await listGovernanceCandidates({ limit: Math.min(limit * 4, 400) });
    const dueCandidates: GovernanceCandidate[] = [];

    for (const candidate of candidates) {
      if (await isDueForGovernance(candidate)) {
        dueCandidates.push(candidate);
      }
      if (dueCandidates.length >= limit) {
        break;
      }
    }

    const subjects: BatchSubjectResult[] = [];
    for (const candidate of dueCandidates) {
      try {
        subjects.push(await runSubject({ batchId, dryRun, candidate }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("governance_subject_failed", {
          batchId,
          personId: candidate.personId,
          message,
        });
        subjects.push({
          personId: candidate.personId,
          personSlug: candidate.personSlug,
          status: "failed",
          riskLevel: null,
          actionCount: 0,
          reason: message,
        });
      }
    }

    const summary = {
      batchId,
      dryRun,
      candidateCount: dueCandidates.length,
      completedCount: subjects.filter((item) => item.status === "completed").length,
      heldCount: subjects.filter((item) => item.status === "held").length,
      failedCount: subjects.filter((item) => item.status === "failed").length,
      subjects,
    };

    await finalizeGovernanceBatch({
      batchId,
      status: "completed",
      summary,
    });

    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finalizeGovernanceBatch({
      batchId,
      status: "failed",
      errorMessage: message,
    });
    throw error;
  }
}
