import { z } from "zod";

import {
  ActionRiskAssessmentSchema,
  DiagnosisIssueSchema,
  NameIdentityResearchVerdictSchema,
  SuggestedActionSchema,
} from "./diagnosis.js";

export const OrganizationWikipediaResearchSchema = z.object({
  status: z.enum(["not_needed", "found", "not_found", "unavailable"]),
  summary: z.string(),
  sourceUrl: z.string().nullable(),
  suggestedFields: z.record(z.string(), z.string()).default({}),
});

export const OrganizationCandidateSchema = z.object({
  organizationId: z.string(),
  organizationSlug: z.string(),
  nameJa: z.string(),
  nameKana: z.string().nullable(),
  nameRoman: z.string().nullable(),
  type: z.string(),
});

export const OrganizationProfileSchema = OrganizationCandidateSchema.extend({
  nameZh: z.string().nullable(),
  nameEn: z.string().nullable(),
  shortName: z.string().nullable(),
  location: z.string().nullable(),
  prefecture: z.string().nullable(),
  country: z.string(),
  websiteUrl: z.string().nullable(),
  status: z.string(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const OrganizationReferenceStatsSchema = z.object({
  membershipCount: z.number().int().min(0),
  personalBestCount: z.number().int().min(0),
  raceResultCount: z.number().int().min(0),
  teamCompetitionResultCount: z.number().int().min(0),
  nameVariantCount: z.number().int().min(0),
  sourceReferenceCount: z.number().int().min(0),
});

export const OrganizationActionBundleSchema = z.object({
  organizationId: z.string().nullable(),
  organizationSlug: z.string().nullable(),
  items: z.array(z.object({
    code: z.string(),
    title: z.string(),
    order: z.number().int().min(1),
    rationale: z.string(),
    relatedIssueCodes: z.array(z.string()).default([]),
    payload: z.record(z.string(), z.unknown()).default({}),
    idempotencyKey: z.string(),
  })).default([]),
});

export const OrganizationDiagnosisStateSchema = z.object({
  inputOrganizationSlug: z.string().nullable().default(null),
  inputOrganizationId: z.string().nullable().default(null),
  inputOrganizationName: z.string().nullable().default(null),

  targetOrganizationId: z.string().nullable().default(null),
  targetOrganizationSlug: z.string().nullable().default(null),
  targetOrganizationNameJa: z.string().nullable().default(null),
  resolutionStatus: z.enum(["unresolved", "unique", "multiple", "not_found"]).default("unresolved"),
  candidateOrganizations: z.array(OrganizationCandidateSchema).default([]),
  normalizationCandidates: z.array(OrganizationCandidateSchema).default([]),
  normalizationRiskStatus: z.enum(["not_checked", "no_risk", "definite", "ambiguous", "overflow"]).default("not_checked"),
  nameIdentityResearchVerdict: NameIdentityResearchVerdictSchema.default("not_run"),

  organization: OrganizationProfileSchema.nullable().default(null),
  referenceStats: OrganizationReferenceStatsSchema.nullable().default(null),
  organizationWikipediaResearch: OrganizationWikipediaResearchSchema.nullable().default(null),

  findings: z.array(DiagnosisIssueSchema).default([]),
  actions: z.array(SuggestedActionSchema).default([]),
  actionBundle: OrganizationActionBundleSchema.nullable().default(null),
  actionRiskAssessment: ActionRiskAssessmentSchema.nullable().default(null),

  runtimeRunId: z.string(),
  runtimeStatus: z.enum(["running", "need_clarification", "completed", "failed"]).default("running"),
  runtimeCurrentNode: z.string().default("resolve_organization"),
  runtimeStartedAt: z.string(),
  runtimeEndedAt: z.string().nullable().default(null),
  runtimeErrorMessage: z.string().nullable().default(null),
  runtimeThreadId: z.string().nullable().default(null),
  runtimeNodeHistory: z.array(z.string()).default([]),

  resultStatus: z.string().nullable().default(null),
  resultSummary: z.string().nullable().default(null),
  resultNotes: z.array(z.string()).default([]),
});

export type OrganizationCandidate = z.infer<typeof OrganizationCandidateSchema>;
export type OrganizationProfile = z.infer<typeof OrganizationProfileSchema>;
export type OrganizationReferenceStats = z.infer<typeof OrganizationReferenceStatsSchema>;
export type OrganizationDiagnosisState = z.infer<typeof OrganizationDiagnosisStateSchema>;

export function createInitialOrganizationDiagnosisState(input: {
  runId: string;
  startedAt: string;
  threadId?: string | null;
  organizationSlug?: string | null;
  organizationId?: string | null;
  organizationName?: string | null;
}) {
  return {
    inputOrganizationSlug: input.organizationSlug ?? null,
    inputOrganizationId: input.organizationId ?? null,
    inputOrganizationName: input.organizationName ?? null,
    runtimeRunId: input.runId,
    runtimeStatus: "running",
    runtimeCurrentNode: "resolve_organization",
    runtimeStartedAt: input.startedAt,
    runtimeEndedAt: null,
    runtimeErrorMessage: null,
    runtimeThreadId: input.threadId ?? null,
    runtimeNodeHistory: [],
    candidateOrganizations: [],
    normalizationCandidates: [],
    normalizationRiskStatus: "not_checked",
    nameIdentityResearchVerdict: "not_run",
    organizationWikipediaResearch: null,
    findings: [],
    actions: [],
    actionBundle: null,
    actionRiskAssessment: null,
    resultStatus: null,
    resultSummary: null,
    resultNotes: [],
  } satisfies Partial<OrganizationDiagnosisState>;
}
