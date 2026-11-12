import { z } from "zod";

export const CONTRACT_VERSION = "event-governance/1";
export const RULE_VERSION = "2026-11-11.1";
const text = z.string().trim().min(1);
export const orgTypes = [
  "unknown",
  "junior_high_school",
  "high_school",
  "university",
  "prefecture_representative",
  "student_union_select",
  "corporate_team",
  "company",
  "club",
  "organizer",
] as const;
export const dateBasis = z.enum(["unknown", "source", "inferred"]);
export const orgSchema = z
  .object({
    key: text,
    name: text,
    slug: text.optional(),
    type: z.enum(orgTypes).default("unknown"),
    sourceKey: text.optional(),
  })
  .strict();
export const membershipHintSchema = z
  .object({
    organizationKey: text,
    type: z.enum(["origin", "enrolled", "affiliated", "graduated", "staff"]),
    exclusivityGroup: z.enum(["employment", "team_registration"]).optional(),
    grade: z.number().int().min(1).max(10).optional(),
    startDate: z.iso.date().optional(),
    endDate: z.iso.date().optional(),
    endState: z.enum(["unknown", "ongoing", "ended"]).default("unknown"),
  })
  .strict();
export const rowSchema = z
  .object({
    key: text,
    sourceKey: text.optional(),
    sourceUrl: z.url().optional(),
    name: text,
    slug: text.optional(),
    kana: text.optional(),
    roman: text.optional(),
    birthDate: z.iso.date().optional(),
    organizationKey: text.optional(),
    memberships: z.array(membershipHintSchema).default([]),
    hometown: text.optional(),
    pbs: z
      .array(
        z
          .object({ discipline: text, mark: text, sourceId: text.optional() })
          .strict(),
      )
      .default([]),
    mark: text.optional(),
    rank: z.number().int().positive().nullable().optional(),
    teamRank: z.number().int().positive().nullable().optional(),
    grade: z.number().int().positive().optional(),
    notes: z.string().optional(),
  })
  .strict();
export const teamSchema = z
  .object({
    organizationKey: text,
    finalRank: z.number().int().positive().nullable().optional(),
    finalMark: text.optional(),
    leg: z.number().int().positive(),
    cumulativeRank: z.number().int().positive().nullable().optional(),
    cumulativeMark: text.optional(),
    gapFromLeader: text.optional(),
    notes: z.string().optional(),
  })
  .strict();
export const batchInputSchema = z
  .object({
    unitType: z.enum(["leg", "heat", "group"]),
    unitKey: text,
    sequence: z.number().int().nonnegative(),
    sourcePayload: z.unknown().optional(),
    sourceId: text,
    raceSlug: text,
    organizations: z.array(orgSchema),
    rows: z.array(rowSchema).min(1),
    teams: z.array(teamSchema).default([]),
  })
  .strict()
  .superRefine((batch, ctx) => {
    for (const [field, values] of [
      ["rows", batch.rows],
      ["organizations", batch.organizations],
    ] as const) {
      const keys = values.map((v) => v.key);
      if (new Set(keys).size !== keys.length)
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "duplicate source row/entity key",
        });
    }
    const orgs = new Set(batch.organizations.map((o) => o.key));
    for (const row of batch.rows)
      for (const k of [
        row.organizationKey,
        ...row.memberships.map((m) => m.organizationKey),
      ]) {
        if (k && !orgs.has(k))
          ctx.addIssue({
            code: "custom",
            message: `Unknown organization key: ${k}`,
          });
      }
    for (const team of batch.teams)
      if (!orgs.has(team.organizationKey))
        ctx.addIssue({
          code: "custom",
          message: `Unknown team: ${team.organizationKey}`,
        });
    const excluded =
      batch.raceSlug === "hakone-qualifier-103" ||
      batch.raceSlug.startsWith("hakone-qualifier-103-") ||
      batch.sourceId === "source-hakone-103-qualifier-official";
    if (excluded)
      ctx.addIssue({
        code: "custom",
        message: "Withdrawn Hakone 103 qualifier import is out of scope",
      });
  });
export const manifestSchema = z
  .object({
    version: z.literal(CONTRACT_VERSION),
    requestKey: text,
    eventEditionId: text,
    mode: z.enum(["dry_run", "apply"]).default("dry_run"),
    batches: z.array(batchInputSchema).min(1),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.batches.map((b) => b.sequence)).size !== v.batches.length)
      ctx.addIssue({ code: "custom", message: "Duplicate batch sequence" });
    if (
      new Set(v.batches.map((b) => `${b.unitType}:${b.unitKey}`)).size !==
      v.batches.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate batch key" });
  });
export type BatchInput = z.infer<typeof batchInputSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export type OrgInput = z.infer<typeof orgSchema>;
export type PersonRow = z.infer<typeof rowSchema>;
export type MembershipHint = z.infer<typeof membershipHintSchema>;
export type Basis = z.infer<typeof dateBasis>;
export type Evidence = {
  sourceId?: string;
  sourceKey?: string;
  url?: string;
  quote?: string;
  fetchedAt?: string;
  hash?: string;
};
export type Finding = {
  key: string;
  code: string;
  subjectRef: string;
  severity: "info" | "warning" | "serious";
  status: "resolved" | "unresolved" | "informational";
  reason: string;
  evidence: Evidence[];
};
export type Window = {
  startDate?: string;
  endDate?: string;
  startBasis: Basis;
  endBasis: Basis;
  endState: "unknown" | "ongoing" | "ended";
  evidence?: Record<string, unknown>;
};
export type Org = {
  id: string;
  slug: string;
  nameJa: string;
  type: (typeof orgTypes)[number];
  updatedAt?: string;
  aliases?: string[];
};
export type Person = {
  id: string;
  slug: string;
  displayNameJa: string;
  birthDate?: string | null;
  hometown?: string | null;
  updatedAt?: string;
  aliases?: string[];
};
export type Membership = Window & {
  id: string;
  personId: string;
  organizationId: string;
  type: MembershipHint["type"];
  organizationType: Org["type"];
  exclusivityGroup?: string;
  updatedAt?: string;
};
export type PB = {
  id: string;
  personId: string;
  discipline: string;
  mark: string;
  markMillis: number | null;
  reliability: number;
  updatedAt: string;
};
export type Source = { id: string; reliability: number };
export type Context = {
  raceId: string;
  raceDate?: string;
  editionId: string;
  source: Source;
  sources: Source[];
  organizations: Org[];
  people: Person[];
  memberships: Membership[];
  pbs: PB[];
  historicalReferences?: Array<{
    id: string; personId: string; sourceId: string; sourceKey: string; entityType: string; sourceUrl?: string;
  }>;
  historicalResults?: Array<{
    id: string; personId: string; organizationId?: string; organizationName?: string;
    raceId: string; raceSlug: string; raceName: string; raceDate?: string;
    mark?: string; notes?: string; isStarter?: boolean; sourceId?: string;
  }>;
  sourceMappings: {
    sourceId: string;
    entityType: string;
    sourceKey: string;
    personId?: string;
    organizationId?: string;
  }[];
};
export type Operation =
  | { kind: "create_organization"; entity: Org }
  | { kind: "create_person"; entity: Person }
  | {
      kind: "source_mapping";
      entityType: "person" | "organization" | "governance_person_observation";
      sourceKey: string;
      targetId: string;
      sourceUrl?: string;
    }
  | {
      kind: "name_variant";
      entityType: "person" | "organization";
      targetId: string;
      value: string;
    }
  | { kind: "membership"; membership: Membership }
  | { kind: "person_fact"; personId: string; field: "hometown"; value: string }
  | {
      kind: "personal_best";
      personId: string;
      discipline: string;
      mark: string;
      markMillis: number;
      sourceId: string;
    }
  | {
      kind: "race_result";
      personId: string;
      organizationId?: string;
      row: Pick<
        PersonRow,
        "key" | "mark" | "rank" | "teamRank" | "grade" | "notes"
      >;
    }
  | {
      kind: "team_result";
      organizationId: string;
      team: z.infer<typeof teamSchema>;
    }
  | {
      kind: "merge_person" | "merge_organization";
      canonicalId: string;
      duplicateId: string;
      evidence: Evidence[];
    }
  | {
      kind: "split_person";
      fromPersonId: string;
      target: Person;
      raceResultIds: string[];
      membershipIds: string[];
      sourceReferenceIds: string[];
      evidence: Evidence[];
    };
export type Change = {
  key: string;
  idempotencyKey: string;
  operation: Operation;
  expectedVersions: Record<string, string>;
  reason: string;
  evidence: Evidence[];
  agentKey: string;
};
export type Metrics = {
  ruleDecisions: number;
  llmCalls: number;
  networkCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  costKnown?: boolean;
  llmModels: string[];
  durationMs: number;
  stoppedReasons: string[];
  accountedCallIds?: string[];
  normalizationStages?: Array<{ stage: string; inputCount: number; resolvedCount: number; remainingCount: number; durationMs: number }>;
  normalizationPolicyVersion?: string;
  normalizationSummary?: { crossCheckIssues: number; organizationCorrections: number; affectedPeople: number; reassessedPeople: number; affectedPeopleResolved: number };
  researchCalls?: Array<{
    callId?: string; stage?: string; itemCount?: number;
    model: string;
    category: string;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    stoppedReason: string | null;
  }>;
};
export type AgentResult = {
  agentKey: string;
  skipped: boolean;
  findings: Finding[];
  changes: Change[];
  metrics: Metrics;
};
export type Plan = {
  batchId: string;
  raceId: string;
  sourceId: string;
  editionId: string;
  mode: Manifest["mode"];
  changes: Change[];
  findings: Finding[];
  agents: AgentResult[];
  summary: Record<string, unknown>;
};
export type Resolution = {
  organizationMap: Record<string, string>;
  personMap: Record<string, string>;
  findings: Finding[];
  changes: Change[];
  metrics: Metrics;
};
export const emptyMetrics = (): Metrics => ({
  ruleDecisions: 0,
  llmCalls: 0,
  networkCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostUsd: 0,
  llmModels: [],
  durationMs: 0,
  stoppedReasons: [],
});
