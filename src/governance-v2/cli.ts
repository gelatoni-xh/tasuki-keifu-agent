import "dotenv/config";
import path from "node:path";
import { adaptRacePayload } from "./legacy-adapter.js";
import { manifestSchema } from "./contracts.js";
import { positiveInteger, nonNegative } from "./config.js";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { GovernanceDB, createGovernancePool } from "./database.js";
import { DirectoryPayloadStore } from "./storage.js";
import { EventRunner } from "./runner.js";
import {
  createMailTransport,
  deliverNotifications,
  parseMailConfig,
} from "./notifications.js";

async function main() {
  const [command, arg] = process.argv.slice(2);
  const url = process.env.GOVERNANCE_DATABASE_URL;
  if (!url)
    throw new Error(
      "GOVERNANCE_DATABASE_URL must point to the main business database with governance schema",
    );
  const pool = createGovernancePool(url);
  const saver = new PostgresSaver(pool, undefined, {
    schema: "governance_checkpoint",
  });
  const readPool = process.env.GOVERNANCE_READ_DATABASE_URL
    ? createGovernancePool(
        process.env.GOVERNANCE_READ_DATABASE_URL,
        "tasuki-governance-v2-readonly",
      )
    : pool;
  const db = new GovernanceDB(pool, readPool);
  try {
    if (command === "health") {
      const state = (
        await pool.query(
          `SELECT to_regclass('governance."EventImportTask"') IS NOT NULL AS governance_ready,
                  to_regclass('governance_checkpoint.checkpoints') IS NOT NULL AS checkpoint_ready`,
        )
      ).rows[0];
      if (!state?.governance_ready || !state?.checkpoint_ready)
        throw new Error("governance schemas are not ready");
      console.log("ready");
      return;
    }
    if (command === "setup-checkpoints") {
      await saver.setup();
      console.log("Checkpoint schema ready");
      return;
    }
    if (command === "cleanup-checkpoints") {
      const days = positiveInteger(
        process.env.GOVERNANCE_CHECKPOINT_RETENTION_DAYS,
        7,
      );
      const old = (
        await pool.query(
          'SELECT a."graphThreadId" FROM governance."BatchAttempt" a JOIN governance."GovernanceBatch" b ON b.id=a."batchId" JOIN governance."EventImportTask" t ON t.id=b."eventTaskId" WHERE t.status IN (\'completed\',\'completed_with_unresolved\') AND t."completedAt"<now()-$1*interval \'1 day\' AND a.status IN (\'succeeded\',\'superseded\')',
          [days],
        )
      ).rows;
      for (const row of old) await saver.deleteThread(row.graphThreadId);
      console.log(
        JSON.stringify({ deletedThreads: old.length, retentionDays: days }),
      );
      return;
    }
    if (command === "status") {
      if (!arg) throw new Error("status requires task ID");
      const task = (
        await pool.query(
          'SELECT id,status,mode,summary,"errorMessage" FROM governance."EventImportTask" WHERE id=$1',
          [arg],
        )
      ).rows[0];
      console.log(
        JSON.stringify({ task, batches: await db.batches(arg) }, null, 2),
      );
      return;
    }
    if (command === "retry") {
      if (!arg) throw new Error("retry requires task ID");
      await db.retry(arg);
      console.log(arg);
      return;
    }
    if (command === "deliver" || command === "mail-worker") {
      if (process.env.GOVERNANCE_MAIL_ENABLED !== "true")
        throw new Error("Real delivery requires GOVERNANCE_MAIL_ENABLED=true");
      const transport = createMailTransport(parseMailConfig());
      let stopped = false;
      process.once("SIGTERM", () => {
        stopped = true;
      });
      process.once("SIGINT", () => {
        stopped = true;
      });
      try {
        do {
          const sent = await deliverNotifications(pool, (msg) =>
            transport(msg),
          );
          if (sent) console.log(JSON.stringify({ sent }));
          if (command === "deliver") break;
          if (!stopped)
            await new Promise((resolve) => setTimeout(resolve, 5000));
        } while (!stopped);
      } finally {
        // Nodemailer closes idle connections when the process exits.
      }
      return;
    }
    const directory = process.env.GOVERNANCE_PAYLOAD_DIR;
    if (!directory)
      throw new Error(
        "GOVERNANCE_PAYLOAD_DIR must name a persistent absolute directory",
      );
    const store = new DirectoryPayloadStore(directory);
    if (command === "adapt") {
      if (!arg) throw new Error("adapt requires an event spec JSON file");
      const spec = JSON.parse(await readFile(arg, "utf8"));
      const batches = await Promise.all(
        spec.batches.map(
          async (b: {
            unitType: "leg" | "heat" | "group";
            unitKey: string;
            sequence: number;
            payloadFile: string;
          }) =>
            adaptRacePayload(
              JSON.parse(
                await readFile(
                  path.resolve(path.dirname(arg), b.payloadFile),
                  "utf8",
                ),
              ),
              {
                unitType: b.unitType,
                unitKey: b.unitKey,
                sequence: b.sequence,
              },
            ),
        ),
      );
      console.log(
        JSON.stringify(manifestSchema.parse({ ...spec, batches }), null, 2),
      );
      return;
    }
    if (command === "submit") {
      if (!arg) throw new Error("submit requires manifest file");
      console.log(
        await db.submit(JSON.parse(await readFile(arg, "utf8")), store),
      );
      return;
    }
    if (command === "run" || command === "work-once" || command === "worker") {
      if (
        process.env.GOVERNANCE_WRITE_ENABLED === "true" &&
        !process.env.GOVERNANCE_READ_DATABASE_URL
      )
        throw new Error(
          "Apply CLI requires a separate GOVERNANCE_READ_DATABASE_URL",
        );
      const researchTimeoutMs = positiveInteger(
        process.env.GOVERNANCE_RESEARCH_TIMEOUT_MS,
        25000,
        600000,
      );
      const researchRequests = positiveInteger(
        process.env.GOVERNANCE_RESEARCH_REQUESTS,
        3,
      );
      if (command === "worker")
        console.info(JSON.stringify({
          event: "governance_worker_config",
          researchTimeoutMs,
          researchRequests,
        }));
      const runner = new EventRunner(db, store, saver, {
        writeEnabled: process.env.GOVERNANCE_WRITE_ENABLED === "true",
        research: {
          apiKey: process.env.OPENAI_API_KEY,
          baseUrl: process.env.OPENAI_BASE_URL,
          model: process.env.GOVERNANCE_RESEARCH_MODEL,
          timeoutMs: researchTimeoutMs,
          maxRequests: researchRequests,
          inputCostPerMillionUsd: nonNegative(process.env.GOVERNANCE_INPUT_COST_PER_MILLION_USD),
          outputCostPerMillionUsd: nonNegative(process.env.GOVERNANCE_OUTPUT_COST_PER_MILLION_USD),
        },
        inputCostPerMillionUsd: nonNegative(process.env.GOVERNANCE_INPUT_COST_PER_MILLION_USD),
        outputCostPerMillionUsd: nonNegative(process.env.GOVERNANCE_OUTPUT_COST_PER_MILLION_USD),
      });
      if (command !== "worker") {
        console.log(JSON.stringify(await runner.run(arg), null, 2));
        return;
      }
      let stopped = false;
      process.once("SIGTERM", () => {
        stopped = true;
      });
      process.once("SIGINT", () => {
        stopped = true;
      });
      while (!stopped) {
        try {
          const report = await runner.run();
          if (report) console.log(JSON.stringify(report));
        } catch {
          console.error(
            "Task failed; persisted for inspection and explicit retry.",
          );
        }
        if (!stopped) await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      return;
    }
    throw new Error(
      "Usage: tsx src/governance-v2/cli.ts health | setup-checkpoints | submit <manifest.json> | run [task-id] | work-once | status <id> | retry <id> | deliver",
    );
  } finally {
    if (readPool !== pool) await readPool.end();
    await pool.end();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "governance_failed");
  process.exitCode = 1;
});
