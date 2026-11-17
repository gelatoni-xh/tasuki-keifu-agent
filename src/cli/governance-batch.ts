import { runGovernanceBatch } from "../governance/batch-runner.js";
import { toJson } from "../lib/json.js";

function parseArgs(argv: string[]) {
  let limit = 20;
  let dryRun = true;
  let personSlug: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--limit" && next) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = parsed;
      }
      index += 1;
      continue;
    }

    if (arg === "--execute") {
      dryRun = false;
      continue;
    }

    if (arg === "--person-slug" && next) {
      personSlug = next;
      index += 1;
    }
  }

  return { limit, dryRun, personSlug };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runGovernanceBatch(args);
  process.stdout.write(`${toJson(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
