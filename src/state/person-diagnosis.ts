import { z } from "zod";

import {
  DiagnosisIssueSchema,
  MembershipSnapshotSchema,
  PersonCandidateSchema,
  PersonProfileSchema,
  PersonalBestSnapshotSchema,
  RelationCacheSnapshotSchema,
  SuggestedActionSchema,
} from "../types/diagnosis.js";

export const PersonDiagnosisStateSchema = z.object({
  inputPersonSlug: z.string().nullable().default(null),
  inputPersonId: z.string().nullable().default(null),
  inputPersonName: z.string().nullable().default(null),
  inputClarification: z.string().nullable().default(null),
  triggeredBy: z.enum(["cli", "admin_api"]).default("cli"),

  targetPersonId: z.string().nullable().default(null),
  targetPersonSlug: z.string().nullable().default(null),
  targetDisplayNameJa: z.string().nullable().default(null),
  resolutionStatus: z.enum(["unresolved", "unique", "multiple", "not_found"]).default("unresolved"),
  candidatePeople: z.array(PersonCandidateSchema).default([]),
  clarificationAttempts: z.number().int().min(0).default(0),

  profile: PersonProfileSchema.nullable().default(null),
  memberships: z.array(MembershipSnapshotSchema).default([]),
  personalBests: z.array(PersonalBestSnapshotSchema).default([]),
  relationCache: RelationCacheSnapshotSchema.nullable().default(null),

  findings: z.array(DiagnosisIssueSchema).default([]),
  actions: z.array(SuggestedActionSchema).default([]),

  runtimeRunId: z.string(),
  runtimeStatus: z.enum(["running", "need_clarification", "completed", "failed"]).default("running"),
  runtimeCurrentNode: z.string().default("resolve_person"),
  runtimeStartedAt: z.string(),
  runtimeEndedAt: z.string().nullable().default(null),
  runtimeErrorMessage: z.string().nullable().default(null),
  runtimeThreadId: z.string().nullable().default(null),
  runtimeNodeHistory: z.array(z.string()).default([]),

  resultStatus: z.string().nullable().default(null),
  resultSummary: z.string().nullable().default(null),
  resultNotes: z.array(z.string()).default([]),
});

export type PersonDiagnosisState = z.infer<typeof PersonDiagnosisStateSchema>;

export function createInitialPersonDiagnosisState(input: {
  runId: string;
  startedAt: string;
  threadId?: string | null;
  triggeredBy?: "cli" | "admin_api";
  personSlug?: string | null;
  personId?: string | null;
  personName?: string | null;
  clarification?: string | null;
}) {
  return {
    inputPersonSlug: input.personSlug ?? null,
    inputPersonId: input.personId ?? null,
    inputPersonName: input.personName ?? null,
    inputClarification: input.clarification ?? null,
    triggeredBy: input.triggeredBy ?? "cli",
    runtimeRunId: input.runId,
    runtimeStatus: "running",
    runtimeCurrentNode: "resolve_person",
    runtimeStartedAt: input.startedAt,
    runtimeEndedAt: null,
    runtimeErrorMessage: null,
    runtimeThreadId: input.threadId ?? null,
    runtimeNodeHistory: [],
    candidatePeople: [],
    clarificationAttempts: 0,
    findings: [],
    actions: [],
    resultStatus: null,
    resultSummary: null,
    resultNotes: [],
  } satisfies Partial<PersonDiagnosisState>;
}
