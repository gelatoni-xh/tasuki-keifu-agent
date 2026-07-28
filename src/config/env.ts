import "dotenv/config";

import { z } from "zod";

const EnvSchema = z.object({
  TASUKI_KEIFU_BUSINESS_DATABASE_URL: z.string().min(1),
  TASUKI_KEIFU_AGENT_DATABASE_URL: z.string().min(1),
  LANGCHAIN_TRACING_V2: z.string().optional(),
  LANGCHAIN_API_KEY: z.string().optional(),
  LANGCHAIN_PROJECT: z.string().optional(),
  TASUKI_AGENT_LOG_LEVEL: z.string().optional(),
});

export const env = EnvSchema.parse(process.env);

if (!env.LANGCHAIN_API_KEY?.trim()) {
  process.env.LANGCHAIN_TRACING_V2 = "false";
}

export type Env = typeof env;
