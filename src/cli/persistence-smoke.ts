import { agentPrisma } from "../db/agent-prisma.js";
import { runPersonDiagnosis } from "../graph/run.js";

async function main() {
  const result = await runPersonDiagnosis({ personSlug: "person-e794b0e4b8ad20e6b3a2e69c" });

  const run = await agentPrisma.agentRun.findUnique({
    where: { id: result.runId },
    include: {
      checkpoints: true,
      events: true,
      diagnosis: true,
    },
  });

  if (!run) {
    throw new Error("agent run not persisted");
  }

  if (!run.diagnosis) {
    throw new Error("diagnosis result not persisted");
  }

  if (run.status !== "completed") {
    throw new Error(`unexpected run status: ${run.status}`);
  }

  if (run.currentNode !== "build_action_plan") {
    throw new Error(`unexpected current node: ${run.currentNode}`);
  }

  if (run.checkpoints.length === 0) {
    throw new Error("no checkpoints persisted");
  }

  if (run.events.length === 0) {
    throw new Error("no events persisted");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        runId: result.runId,
        persisted: true,
        status: run.status,
        checkpointCount: run.checkpoints.length,
        eventCount: run.events.length,
        diagnosisStatus: run.diagnosis.status,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
