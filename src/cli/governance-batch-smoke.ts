import { agentPrisma } from "../db/agent-prisma.js";
import { runGovernanceBatch } from "../governance/batch-runner.js";

async function main() {
  const result = await runGovernanceBatch({ limit: 1, dryRun: true });

  if (result.candidateCount > 1) {
    throw new Error(`expected at most one candidate, received ${result.candidateCount}`);
  }

  const batch = await agentPrisma.governanceBatch.findUnique({
    where: { id: result.batchId },
    include: {
      subjects: {
        include: {
          actionExecutions: true,
        },
      },
    },
  });

  if (!batch) {
    throw new Error("governance batch was not persisted");
  }

  if (batch.status !== "completed" || !batch.dryRun) {
    throw new Error(`unexpected batch state: status=${batch.status} dryRun=${batch.dryRun}`);
  }

  if (batch.subjects.length !== result.candidateCount) {
    throw new Error(`subject count mismatch: ${batch.subjects.length} !== ${result.candidateCount}`);
  }

  for (const subject of batch.subjects) {
    if (!["completed", "held"].includes(subject.status)) {
      throw new Error(`unexpected subject status: ${subject.status}`);
    }

    if (subject.actionExecutions.some((action) => action.status === "succeeded")) {
      throw new Error("dry-run unexpectedly executed a write action");
    }
  }

  process.stdout.write(`${JSON.stringify({
    batchId: batch.id,
    dryRun: batch.dryRun,
    subjectCount: batch.subjects.length,
    subjectStatuses: batch.subjects.map((subject) => subject.status),
  }, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await agentPrisma.$disconnect();
  });
