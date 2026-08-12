import { agentPrisma } from "./agent-prisma.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("agent-repositories");

export async function createAgentRun(input: {
  runId: string;
  graphName: string;
  threadId?: string | null;
  payload: unknown;
}) {
  return agentPrisma.agentRun.create({
    data: {
      id: input.runId,
      graphName: input.graphName,
      threadId: input.threadId ?? null,
      input: input.payload as never,
    },
  });
}

export async function updateAgentRun(input: {
  runId: string;
  status?: "running" | "need_clarification" | "completed" | "failed";
  currentNode?: string | null;
  output?: unknown;
  errorMessage?: string | null;
  endedAt?: Date | null;
}) {
  await agentPrisma.agentRun.update({
    where: { id: input.runId },
    data: {
      status: input.status,
      currentNode: input.currentNode ?? undefined,
      output: input.output as never,
      errorMessage: input.errorMessage ?? undefined,
      endedAt: input.endedAt ?? undefined,
    },
  });
}

export async function recordAgentEvent(input: {
  runId: string;
  nodeName?: string | null;
  level?: "debug" | "info" | "warn" | "error";
  message: string;
  payload?: unknown;
}) {
  await agentPrisma.agentEvent.create({
    data: {
      runId: input.runId,
      nodeName: input.nodeName ?? null,
      level: input.level ?? "info",
      message: input.message,
      payload: input.payload as never,
    },
  });
}

export async function recordCheckpoint(input: {
  runId: string;
  nodeName: string;
  state: unknown;
}) {
  await agentPrisma.agentCheckpoint.create({
    data: {
      runId: input.runId,
      nodeName: input.nodeName,
      state: input.state as never,
    },
  });
}

export async function upsertDiagnosisResult(input: {
  runId: string;
  personId?: string | null;
  personSlug?: string | null;
  status: string;
  summary?: string | null;
  findings: unknown;
  actions: unknown;
  snapshot?: unknown;
}) {
  const result = await agentPrisma.diagnosisResult.upsert({
    where: { runId: input.runId },
    create: {
      runId: input.runId,
      personId: input.personId ?? null,
      personSlug: input.personSlug ?? null,
      status: input.status,
      summary: input.summary ?? null,
      findings: input.findings as never,
      actions: input.actions as never,
      snapshot: input.snapshot as never,
    },
    update: {
      personId: input.personId ?? null,
      personSlug: input.personSlug ?? null,
      status: input.status,
      summary: input.summary ?? null,
      findings: input.findings as never,
      actions: input.actions as never,
      snapshot: input.snapshot as never,
    },
  });

  logger.debug("diagnosis_result_saved", { runId: input.runId, id: result.id });
  return result;
}

export async function finalizeAgentRun(input: {
  runId: string;
  status: "completed" | "need_clarification" | "failed";
  currentNode?: string | null;
  output?: unknown;
  errorMessage?: string | null;
}) {
  await updateAgentRun({
    runId: input.runId,
    status: input.status,
    currentNode: input.currentNode ?? null,
    output: input.output,
    errorMessage: input.errorMessage ?? null,
    endedAt: new Date(),
  });
}

export async function createGovernanceBatch(input: {
  batchId: string;
  dryRun: boolean;
  payload: unknown;
}) {
  return agentPrisma.governanceBatch.create({
    data: {
      id: input.batchId,
      dryRun: input.dryRun,
      input: input.payload as never,
    },
  });
}

export async function finalizeGovernanceBatch(input: {
  batchId: string;
  status: "completed" | "failed";
  summary?: unknown;
  errorMessage?: string | null;
}) {
  await agentPrisma.governanceBatch.update({
    where: { id: input.batchId },
    data: {
      status: input.status,
      summary: input.summary as never,
      errorMessage: input.errorMessage ?? null,
      endedAt: new Date(),
    },
  });
}

export async function findLatestFinalizedGovernance(personId: string) {
  const subjects = await agentPrisma.governanceSubject.findMany({
    where: {
      personId,
      status: { in: ["completed", "held"] },
      completedAt: { not: null },
    },
    orderBy: { completedAt: "desc" },
    select: {
      completedAt: true,
      findings: true,
    },
  });

  return subjects.find((subject) => {
    const findings = Array.isArray(subject.findings) ? subject.findings : [];
    const findingCodes = findings
      .map((finding) =>
        finding && typeof finding === "object" && typeof (finding as { code?: unknown }).code === "string"
          ? (finding as { code: string }).code
          : "",
      )
      .filter(Boolean);

    // Profile completeness is an observation, not a completed governance result.
    return !(findingCodes.length > 0 && findingCodes.every((code) => code === "profile_coverage_missing_fields"));
  }) ?? null;
}

export async function createGovernanceSubject(input: {
  batchId: string;
  personId: string;
  personSlug: string;
  businessUpdatedAt: Date;
}) {
  return agentPrisma.governanceSubject.create({
    data: {
      batchId: input.batchId,
      personId: input.personId,
      personSlug: input.personSlug,
      businessUpdatedAt: input.businessUpdatedAt,
    },
  });
}

export async function finalizeGovernanceSubject(input: {
  subjectId: string;
  diagnosisRunId?: string | null;
  status: "completed" | "held" | "failed";
  riskLevel?: "low" | "medium" | "high" | null;
  findings?: unknown;
  actionBundle?: unknown;
  holdReason?: string | null;
  errorMessage?: string | null;
}) {
  await agentPrisma.governanceSubject.update({
    where: { id: input.subjectId },
    data: {
      diagnosisRunId: input.diagnosisRunId ?? null,
      status: input.status,
      riskLevel: input.riskLevel ?? null,
      findings: input.findings as never,
      actionBundle: input.actionBundle as never,
      holdReason: input.holdReason ?? null,
      errorMessage: input.errorMessage ?? null,
      completedAt: new Date(),
    },
  });
}

export async function createActionExecution(input: {
  subjectId: string;
  actionCode: string;
  idempotencyKey: string;
  action: unknown;
  status: "planned" | "held" | "skipped" | "succeeded" | "failed";
  result?: unknown;
  errorMessage?: string | null;
}) {
  return agentPrisma.actionExecution.upsert({
    where: {
      subjectId_actionCode: {
        subjectId: input.subjectId,
        actionCode: input.actionCode,
      },
    },
    create: {
      subjectId: input.subjectId,
      actionCode: input.actionCode,
      idempotencyKey: input.idempotencyKey,
      status: input.status,
      action: input.action as never,
      result: input.result as never,
      errorMessage: input.errorMessage ?? null,
      startedAt: input.status === "planned" || input.status === "held" ? null : new Date(),
      endedAt: input.status === "planned" ? null : new Date(),
    },
    update: {
      idempotencyKey: input.idempotencyKey,
      status: input.status,
      action: input.action as never,
      result: input.result as never,
      errorMessage: input.errorMessage ?? null,
      endedAt: input.status === "planned" ? null : new Date(),
    },
  });
}
