import { runPersonDiagnosis } from "../graph/run.js";
import { toJson } from "../lib/json.js";

type CliArgs = {
  personSlug?: string | null;
  personId?: string | null;
  personName?: string | null;
  clarification?: string | null;
  triggeredBy?: "cli" | "admin_api";
};

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {
    personSlug: null,
    personId: null,
    personName: null,
    clarification: null,
    triggeredBy: "cli",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--person-slug" && next) {
      result.personSlug = next;
      index += 1;
      continue;
    }

    if (arg === "--person-id" && next) {
      result.personId = next;
      index += 1;
      continue;
    }

    if (arg === "--person-name" && next) {
      result.personName = next;
      index += 1;
      continue;
    }

    if (arg === "--clarification" && next) {
      result.clarification = next;
      index += 1;
      continue;
    }

    if (arg === "--triggered-by" && next && (next === "cli" || next === "admin_api")) {
      result.triggeredBy = next;
      index += 1;
      continue;
    }
  }

  return result;
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  pnpm diagnose -- --person-slug <slug>",
      "  pnpm diagnose -- --person-id <id>",
      "  pnpm diagnose -- --person-name <name>",
      "",
      "Optional:",
      "  --clarification <text>",
      "  --triggered-by cli|admin_api",
    ].join("\n") + "\n",
  );
}

async function main() {
  const argv = process.argv.slice(2).filter((arg) => arg !== "diagnose");
  const args = parseArgs(argv);

  if (!args.personSlug && !args.personId && !args.personName) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const result = await runPersonDiagnosis(args);
  process.stdout.write(`${toJson({
    runId: result.runId,
    threadId: result.threadId,
    runtimeStatus: result.state.runtimeStatus,
    resolutionStatus: result.state.resolutionStatus,
    targetPersonId: result.state.targetPersonId,
    targetPersonSlug: result.state.targetPersonSlug,
    targetDisplayNameJa: result.state.targetDisplayNameJa,
    findings: result.state.findings,
    actions: result.state.actions,
    resultSummary: result.state.resultSummary,
    resultNotes: result.state.resultNotes,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
