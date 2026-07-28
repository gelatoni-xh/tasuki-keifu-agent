import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

import { env } from "../config/env.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("agent-prisma");

function createPrismaClient() {
  const adapter = new PrismaPg(env.TASUKI_KEIFU_AGENT_DATABASE_URL);

  return new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? [
            { emit: "event", level: "query" },
            { emit: "event", level: "warn" },
            { emit: "event", level: "error" },
          ] satisfies Prisma.LogDefinition[]
        : [{ emit: "event", level: "error" } satisfies Prisma.LogDefinition],
  });
}

type AgentPrismaClient = ReturnType<typeof createPrismaClient>;

const globalForPrisma = globalThis as unknown as {
  agentPrisma?: AgentPrismaClient;
};

export const agentPrisma = globalForPrisma.agentPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.agentPrisma = agentPrisma;
}

agentPrisma.$on("error", (event) => {
  logger.error("prisma_error", { target: event.target, message: event.message });
});

agentPrisma.$on("warn", (event) => {
  logger.warn("prisma_warn", { target: event.target, message: event.message });
});

if (process.env.NODE_ENV === "development") {
  agentPrisma.$on("query", (event) => {
    logger.debug("prisma_query", {
      target: event.target,
      durationMs: event.duration,
      query: event.query,
      params: event.params,
    });
  });
}
