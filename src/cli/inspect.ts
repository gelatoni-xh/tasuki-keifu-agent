import { agentPrisma } from "../db/agent-prisma.js";
import { toJson } from "../lib/json.js";

type InspectArgs = {
  limit: number;
  personSlug?: string | null;
  status?: string | null;
};

function parseArgs(argv: string[]): InspectArgs {
  const result: InspectArgs = {
    limit: 10,
    personSlug: null,
    status: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--limit" && next) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        result.limit = parsed;
      }
      index += 1;
      continue;
    }

    if (arg === "--person-slug" && next) {
      result.personSlug = next;
      index += 1;
      continue;
    }

    if (arg === "--status" && next) {
      result.status = next;
      index += 1;
      continue;
    }
  }

  return result;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  const runs = await agentPrisma.agentRun.findMany({
    where: {
      ...(args.personSlug ? { diagnosis: { personSlug: args.personSlug } } : {}),
      ...(args.status ? { status: args.status as never } : {}),
    },
    orderBy: [{ startedAt: "desc" }],
    take: args.limit,
    include: {
      diagnosis: true,
    },
  });

  process.stdout.write(
    `${toJson(
      runs.map((run) => ({
        runId: run.id,
        graphName: run.graphName,
        status: run.status,
        currentNode: run.currentNode,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        personSlug: run.diagnosis?.personSlug ?? null,
        personId: run.diagnosis?.personId ?? null,
        diagnosisStatus: run.diagnosis?.status ?? null,
        summary: run.diagnosis?.summary ?? null,
      })),
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
