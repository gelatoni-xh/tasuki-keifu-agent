import { Pool } from "pg";

import { env } from "../config/env.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("business-db");

const globalForPool = globalThis as unknown as {
  businessPool?: Pool;
  businessWritePool?: Pool;
};

export function getBusinessPool() {
  if (globalForPool.businessPool) {
    return globalForPool.businessPool;
  }

  const pool = new Pool({
    connectionString: env.TASUKI_KEIFU_BUSINESS_DATABASE_URL,
    application_name: "tasuki-keifu-agent",
  });

  pool.on("error", (error) => {
    logger.error("pool_error", { message: error.message, stack: error.stack });
  });

  globalForPool.businessPool = pool;
  return pool;
}

export function getBusinessWritePool() {
  if (globalForPool.businessWritePool) {
    return globalForPool.businessWritePool;
  }

  const connectionString = env.TASUKI_KEIFU_BUSINESS_WRITE_DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("TASUKI_KEIFU_BUSINESS_WRITE_DATABASE_URL is required for business write actions.");
  }

  const pool = new Pool({
    connectionString,
    application_name: "tasuki-keifu-agent-write",
  });

  pool.on("error", (error) => {
    logger.error("write_pool_error", { message: error.message, stack: error.stack });
  });

  globalForPool.businessWritePool = pool;
  return pool;
}
