import { Client } from "langsmith";
import { traceable } from "langsmith/traceable";

import { env } from "../config/env.js";

const apiKey = env.LANGSMITH_API_KEY?.trim() || env.LANGCHAIN_API_KEY?.trim() || "";
const apiUrl = env.LANGSMITH_ENDPOINT?.trim() || env.LANGCHAIN_ENDPOINT?.trim() || undefined;
const workspaceId = env.LANGSMITH_WORKSPACE_ID?.trim() || undefined;
const projectName = env.LANGSMITH_PROJECT?.trim() || env.LANGCHAIN_PROJECT?.trim() || "tasuki-keifu-agent-v1";
const tracingEnabled = Boolean(apiKey);

const client = tracingEnabled
  ? new Client({
      apiKey,
      apiUrl,
      workspaceId,
    })
  : undefined;

type GovernanceSubjectType = "person" | "organization";

const observabilitySchema = "tasuki_governance_v1";

function traceGovernanceDiagnosis<T extends (...args: any[]) => Promise<any>>(
  handler: T,
  subjectType: GovernanceSubjectType,
): T {
  return traceable(handler, {
    name: "governance_diagnosis",
    run_type: "chain",
    client,
    tracingEnabled,
    project_name: projectName,
    tags: ["tasuki-governance", `subject:${subjectType}`, `graph:${subjectType}_diagnosis`],
    metadata: {
      observability_schema: observabilitySchema,
      subject_type: subjectType,
      graph_name: `${subjectType}_diagnosis`,
      execution_scope: "single_subject",
    },
  }) as T;
}

export function tracePersonDiagnosis<T extends (...args: any[]) => Promise<any>>(handler: T): T {
  return traceGovernanceDiagnosis(handler, "person");
}

export function traceOrganizationDiagnosis<T extends (...args: any[]) => Promise<any>>(handler: T): T {
  return traceGovernanceDiagnosis(handler, "organization");
}

function traceIdentityResearch<T extends (...args: any[]) => Promise<any>>(
  handler: T,
  subjectType: GovernanceSubjectType,
): T {
  return traceable(handler, {
    name: "research_identity_llm",
    run_type: "llm",
    client,
    tracingEnabled,
    project_name: projectName,
    tags: ["tasuki-governance", `subject:${subjectType}`, "research:identity"],
    metadata: {
      observability_schema: observabilitySchema,
      subject_type: subjectType,
      research_type: "identity",
    },
  }) as T;
}

export function traceNameIdentityResearch<T extends (...args: any[]) => Promise<any>>(handler: T): T {
  return traceIdentityResearch(handler, "person");
}

export function traceOrganizationIdentityResearch<T extends (...args: any[]) => Promise<any>>(handler: T): T {
  return traceIdentityResearch(handler, "organization");
}

function traceWikipediaResearch<T extends (...args: any[]) => Promise<any>>(
  handler: T,
  subjectType: GovernanceSubjectType,
): T {
  return traceable(handler, {
    name: "research_wikipedia_api",
    run_type: "tool",
    client,
    tracingEnabled,
    project_name: projectName,
    tags: ["tasuki-governance", `subject:${subjectType}`, "research:wikipedia"],
    metadata: {
      observability_schema: observabilitySchema,
      subject_type: subjectType,
      research_type: "wikipedia",
    },
  }) as T;
}

export function traceProfileWikipediaResearch<T extends (...args: any[]) => Promise<any>>(handler: T): T {
  return traceWikipediaResearch(handler, "person");
}

export function traceOrganizationWikipediaResearch<T extends (...args: any[]) => Promise<any>>(handler: T): T {
  return traceWikipediaResearch(handler, "organization");
}
