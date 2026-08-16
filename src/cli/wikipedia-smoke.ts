import { extractWikipediaPersonalBests } from "../lib/wikipedia.js";

function main() {
  const personalBests = extractWikipediaPersonalBests(`
| 5000m = 13分45秒67
| 10000m = 28:01.23
| マラソン = 2時間06分18秒
`);
  const byDiscipline = new Map(personalBests.map((item) => [item.discipline, item]));

  if (
    byDiscipline.get("m5000")?.mark !== "13:45.67"
    || byDiscipline.get("m5000")?.markMillis !== 825670
    || byDiscipline.get("m10000")?.mark !== "28:01.23"
    || byDiscipline.get("marathon")?.mark !== "2:06:18.00"
  ) {
    throw new Error(`Wikipedia PB parsing failed: ${JSON.stringify(personalBests)}`);
  }

  process.stdout.write(`${JSON.stringify({ parsedPersonalBests: personalBests.length, ok: true }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
}
