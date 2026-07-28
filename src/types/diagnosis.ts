import { z } from "zod";

export const DiagnosisSeveritySchema = z.enum(["info", "low", "medium", "high", "critical"]);
export const SuggestedActionPrioritySchema = z.enum(["low", "medium", "high"]);

export const DiagnosisIssueSchema = z.object({
  code: z.string(),
  title: z.string(),
  severity: DiagnosisSeveritySchema,
  node: z.string(),
  summary: z.string(),
  evidence: z.record(z.string(), z.unknown()).default({}),
});

export const SuggestedActionSchema = z.object({
  code: z.string(),
  title: z.string(),
  priority: SuggestedActionPrioritySchema,
  rationale: z.string(),
  relatedIssueCodes: z.array(z.string()).default([]),
});

export const PersonCandidateSchema = z.object({
  personId: z.string(),
  personSlug: z.string(),
  displayNameJa: z.string(),
});

export const PersonProfileSchema = z.object({
  personId: z.string(),
  personSlug: z.string(),
  displayNameJa: z.string(),
  displayNameKana: z.string().nullable(),
  displayNameRoman: z.string().nullable(),
  displayNameZh: z.string().nullable(),
  displayNameEn: z.string().nullable(),
  birthDate: z.string().nullable(),
  hometown: z.string().nullable(),
  nationality: z.string().nullable(),
  heightCm: z.number().int().nullable(),
  weightKg: z.number().int().nullable(),
  type: z.string(),
  status: z.string(),
  notes: z.string().nullable(),
  updatedAt: z.string(),
});

export const MembershipSnapshotSchema = z.object({
  membershipId: z.string(),
  personId: z.string(),
  organizationId: z.string(),
  organizationSlug: z.string(),
  organizationNameJa: z.string(),
  organizationType: z.string(),
  type: z.string(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  startYear: z.number().int().nullable(),
  endYear: z.number().int().nullable(),
  status: z.string(),
  notes: z.string().nullable(),
  updatedAt: z.string(),
});

export const PersonalBestSnapshotSchema = z.object({
  personalBestId: z.string(),
  personId: z.string(),
  discipline: z.string(),
  mark: z.string(),
  markMillis: z.number().int().nullable(),
  achievedOn: z.string().nullable(),
  competitionName: z.string().nullable(),
  venue: z.string().nullable(),
  organizationId: z.string().nullable(),
  stage: z.string().nullable(),
  isHighSchoolPb: z.boolean(),
  isCollegePb: z.boolean(),
  status: z.string(),
  notes: z.string().nullable(),
  updatedAt: z.string(),
});

export const RelationCacheSnapshotSchema = z.object({
  relationCacheId: z.string().nullable(),
  generatedAt: z.string().nullable(),
  sourceHash: z.string().nullable(),
  payload: z.unknown().nullable(),
});

export type DiagnosisIssue = z.infer<typeof DiagnosisIssueSchema>;
export type SuggestedAction = z.infer<typeof SuggestedActionSchema>;
export type PersonCandidate = z.infer<typeof PersonCandidateSchema>;
export type PersonProfile = z.infer<typeof PersonProfileSchema>;
export type MembershipSnapshot = z.infer<typeof MembershipSnapshotSchema>;
export type PersonalBestSnapshot = z.infer<typeof PersonalBestSnapshotSchema>;
export type RelationCacheSnapshot = z.infer<typeof RelationCacheSnapshotSchema>;
