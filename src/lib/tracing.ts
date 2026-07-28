import { Client } from "langsmith";
import { traceable } from "langsmith/traceable";

import { env } from "../config/env.js";

const apiKey = env.LANGSMITH_API_KEY?.trim() || env.LANGCHAIN_API_KEY?.trim() || "";
const apiUrl = env.LANGSMITH_ENDPOINT?.trim() || env.LANGCHAIN_ENDPOINT?.trim() || undefined;
const projectName = env.LANGSMITH_PROJECT?.trim() || env.LANGCHAIN_PROJECT?.trim() || "tasuki-keifu-agent-v1";
const tracingEnabled = Boolean(apiKey);

const client = tracingEnabled
  ? new Client({
      apiKey,
      apiUrl,
    })
  : undefined;

export function tracePersonDiagnosis<T extends (...args: any[]) => Promise<any>>(handler: T): T {
  return traceable(handler, {
    name: "person_diagnosis",
    run_type: "chain",
    client,
    tracingEnabled,
    project_name: projectName,
  }) as T;
}

