import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createGovernancePool, GovernanceDB } from "../database.js";
import { DirectoryPayloadStore } from "../storage.js";
import { EventRunner } from "../runner.js";
const url = process.env.GOVERNANCE_TEST_DATABASE_URL!,
  directory = process.env.GOVERNANCE_TEST_PAYLOAD_DIR!;
if (
  !url ||
  !["localhost", "127.0.0.1"].includes(new URL(url).hostname) ||
  !new URL(url).pathname.endsWith("_test")
)
  throw new Error("Isolated test database required");
const pool = createGovernancePool(url);
try {
  const result = await new EventRunner(
    new GovernanceDB(pool),
    new DirectoryPayloadStore(directory),
    new PostgresSaver(pool, undefined, { schema: "governance_checkpoint" }),
    {
      writeEnabled: true,
      researcher: async request => {
        if (request.kind === "normalization_cross_check") return { crossAnswer: { issues: [] }, evidence: [] };
        throw new Error("Unexpected research");
      },
    },
  ).run(process.argv[2]);
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
