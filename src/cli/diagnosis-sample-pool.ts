import type { RunPersonDiagnosisInput } from "../graph/run.js";

export type DiagnosisSampleCase = {
  label: string;
  input: RunPersonDiagnosisInput;
  expectedRuntimeStatus: "completed" | "need_clarification";
  expectedResolutionStatus?: "unresolved" | "unique" | "multiple" | "not_found";
  expectedIssueCount?: number;
  expectedActionCount?: number;
  expectedIssueCodes?: string[];
  expectedActionCodes?: string[];
};

export const diagnosisSamplePool: DiagnosisSampleCase[] = [
  {
    label: "single-person",
    input: { personSlug: "person-e794b0e4b8ad20e6b3a2e69c" },
    expectedRuntimeStatus: "completed",
    expectedResolutionStatus: "unique",
    expectedIssueCodes: ["profile_coverage_missing_fields"],
    expectedActionCodes: [],
  },
  {
    label: "clarification-needed",
    input: { personName: "中川拓海" },
    expectedRuntimeStatus: "need_clarification",
    expectedResolutionStatus: "multiple",
    expectedIssueCount: 0,
    expectedActionCount: 0,
    expectedIssueCodes: [],
    expectedActionCodes: [],
  },
  {
    label: "clarified-duplicate-name",
    input: {
      personName: "中川拓海",
      clarification: "person-nittaidai324-5e12a45e5b3a94345664",
    },
    expectedRuntimeStatus: "completed",
    expectedResolutionStatus: "unique",
    expectedIssueCodes: ["profile_coverage_missing_fields", "duplicate_normalized_name"],
    expectedActionCodes: [],
  },
  {
    label: "multiple-current-memberships",
    input: { personSlug: "person-m-and-a-best-partners-06debb74" },
    expectedRuntimeStatus: "completed",
    expectedResolutionStatus: "unique",
    expectedIssueCodes: ["profile_coverage_missing_fields", "multiple_current_memberships"],
    expectedActionCodes: ["review_membership_timeline"],
  },
  {
    label: "pb-conflict",
    input: { personSlug: "nakano-shota" },
    expectedRuntimeStatus: "completed",
    expectedResolutionStatus: "unique",
    expectedIssueCodes: [
      "profile_coverage_missing_fields",
      "conflicting_personal_best",
    ],
    expectedActionCodes: ["review_personal_bests"],
  },
  {
    label: "membership-boundary",
    input: { personSlug: "person-e4bd90e897a420e9a2af2de9" },
    expectedRuntimeStatus: "completed",
    expectedResolutionStatus: "unique",
    expectedIssueCodes: ["profile_coverage_missing_fields", "high_school_starts_after_university"],
    expectedActionCodes: [],
  },
  {
    label: "duplicate-normalized-name",
    input: { personSlug: "person-nittaidai324-1611f58a45b3bd8b24f5" },
    expectedRuntimeStatus: "completed",
    expectedResolutionStatus: "unique",
    expectedIssueCodes: ["profile_coverage_missing_fields", "duplicate_normalized_name"],
    expectedActionCodes: [],
  },
  {
    label: "timeline-overlap",
    input: { personSlug: "person-kantoic2025-b091569c126a650147e5" },
    expectedRuntimeStatus: "completed",
    expectedResolutionStatus: "unique",
    expectedIssueCodes: ["profile_coverage_missing_fields", "same_type_membership_overlap"],
    expectedActionCodes: [],
  },
  {
    label: "not-found",
    input: { personSlug: "person-this-slug-should-not-exist-20260728" },
    expectedRuntimeStatus: "completed",
    expectedResolutionStatus: "not_found",
    expectedIssueCount: 0,
    expectedActionCount: 0,
    expectedIssueCodes: [],
    expectedActionCodes: [],
  },
];
