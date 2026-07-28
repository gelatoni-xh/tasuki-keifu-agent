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
