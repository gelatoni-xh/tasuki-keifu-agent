import "dotenv/config";

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

const EnvSchema = z.object({
  TASUKI_KEIFU_BUSINESS_DATABASE_URL: z.string().min(1),
  TASUKI_KEIFU_BUSINESS_WRITE_DATABASE_URL: z.string().optional(),
  TASUKI_KEIFU_AGENT_DATABASE_URL: z.string().min(1),
  LANGSMITH_TRACING: z.string().optional(),
  LANGSMITH_API_KEY: z.string().optional(),
  LANGSMITH_WORKSPACE_ID: z.string().optional(),
  LANGSMITH_PROJECT: z.string().optional(),
  LANGSMITH_ENDPOINT: z.string().optional(),
  LANGCHAIN_TRACING_V2: z.string().optional(),
  LANGCHAIN_API_KEY: z.string().optional(),
  LANGCHAIN_PROJECT: z.string().optional(),
  LANGCHAIN_ENDPOINT: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  TASUKI_LLM_TIMEOUT_MS: z.string().optional(),
  TASUKI_WIKIPEDIA_TIMEOUT_MS: z.string().optional(),
  TASUKI_AGENT_WRITE_ENABLED: z.string().optional(),
  TASUKI_AGENT_LOG_LEVEL: z.string().optional(),
});

const localLangSmithKeyPath = path.join(os.homedir(), ".codex", "secrets", "langsmith_api_key");
if (!process.env.LANGSMITH_API_KEY?.trim() && existsSync(localLangSmithKeyPath)) {
  process.env.LANGSMITH_API_KEY = readFileSync(localLangSmithKeyPath, "utf8").trim();
}

const localCodexAuthPath = path.join(os.homedir(), ".codex", "auth.json");
if (!process.env.OPENAI_API_KEY?.trim() && existsSync(localCodexAuthPath)) {
  try {
    const localCodexAuth = JSON.parse(readFileSync(localCodexAuthPath, "utf8")) as { OPENAI_API_KEY?: string };
    if (localCodexAuth.OPENAI_API_KEY?.trim()) {
      process.env.OPENAI_API_KEY = localCodexAuth.OPENAI_API_KEY.trim();
    }
  } catch {
    // A malformed local Codex auth file should not prevent rule-only checks.
  }
}

const localCodexConfigPath = path.join(os.homedir(), ".codex", "config.toml");
if (existsSync(localCodexConfigPath)) {
  const localCodexConfig = readFileSync(localCodexConfigPath, "utf8");
  const baseUrl = localCodexConfig.match(/^\s*base_url\s*=\s*"([^"]+)"/m)?.[1];
  const model = localCodexConfig.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1];
  if (!process.env.OPENAI_BASE_URL?.trim() && baseUrl) {
    process.env.OPENAI_BASE_URL = baseUrl;
  }
  if (!process.env.OPENAI_MODEL?.trim() && model) {
    process.env.OPENAI_MODEL = model;
  }
}

export const env = EnvSchema.parse(process.env);

const langSmithApiKey = env.LANGSMITH_API_KEY?.trim() || env.LANGCHAIN_API_KEY?.trim() || "";
const langSmithWorkspaceId = env.LANGSMITH_WORKSPACE_ID?.trim() || undefined;
const langSmithProject = env.LANGSMITH_PROJECT?.trim() || env.LANGCHAIN_PROJECT?.trim() || "tasuki-keifu-agent-v1";
const langSmithEndpoint = env.LANGSMITH_ENDPOINT?.trim() || env.LANGCHAIN_ENDPOINT?.trim() || undefined;
const langSmithTracingEnabled = Boolean(langSmithApiKey);

process.env.LANGSMITH_TRACING = langSmithTracingEnabled ? "true" : "false";
process.env.LANGCHAIN_TRACING_V2 = langSmithTracingEnabled ? "true" : "false";
process.env.LANGSMITH_PROJECT = langSmithProject;
process.env.LANGCHAIN_PROJECT = langSmithProject;

if (langSmithWorkspaceId) {
  process.env.LANGSMITH_WORKSPACE_ID = langSmithWorkspaceId;
}

if (langSmithEndpoint) {
  process.env.LANGSMITH_ENDPOINT = langSmithEndpoint;
  process.env.LANGCHAIN_ENDPOINT = langSmithEndpoint;
}

if (!langSmithApiKey) {
  process.env.LANGSMITH_API_KEY = "";
  process.env.LANGCHAIN_TRACING_V2 = "false";
}

export type Env = typeof env;
