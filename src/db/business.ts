import { Pool } from "pg";

import { env } from "../config/env.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("business-db");

const globalForPool = globalThis as unknown as {
  businessPool?: Pool;
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
