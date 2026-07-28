import type { DiagnosisIssue, PersonCandidate } from "../types/diagnosis.js";
import {
  countDuplicateNormalizedNames,
  findNameNormalizationCandidates,
  loadPersonSnapshot,
  resolvePersonCandidates,
} from "../db/business-queries.js";

export type ToolResult<T> = {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
};

export async function resolvePersonTool(input: {
  personSlug?: string | null;
  personId?: string | null;
  personName?: string | null;
}) {
  try {
    const candidates = await resolvePersonCandidates({
      personId: input.personId,
      personSlug: input.personSlug,
      personName: input.personName,
    });

    if (candidates.length === 0) {
      return {
        ok: true,
        data: { matchType: "not_found" as const },
      } satisfies ToolResult<{ matchType: "not_found" }>;
    }

    if (candidates.length === 1) {
      return {
        ok: true,
        data: {
          matchType: "unique" as const,
          person: candidates[0],
        },
      } satisfies ToolResult<{ matchType: "unique"; person: PersonCandidate }>;
    }

    return {
      ok: true,
      data: {
        matchType: "multiple" as const,
        candidates,
      },
    } satisfies ToolResult<{ matchType: "multiple"; candidates: PersonCandidate[] }>;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "resolve_person_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    } satisfies ToolResult<never>;
  }
}

export async function loadPersonSnapshotTool(input: { personId: string }) {
  try {
    const data = await loadPersonSnapshot({ personId: input.personId });
    return {
      ok: true,
      data,
    } satisfies ToolResult<Awaited<ReturnType<typeof loadPersonSnapshot>>>;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "load_person_snapshot_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    } satisfies ToolResult<never>;
  }
}

export async function checkRelationCacheTool(input: { personId: string; personSlug: string }) {
  try {
    const snapshot = await loadPersonSnapshot({ personId: input.personId });
    const latestSnapshotUpdate = [
      snapshot.profile.updatedAt,
      ...snapshot.memberships.map((item: (typeof snapshot.memberships)[number]) => item.updatedAt),
      ...snapshot.personalBests.map((item: (typeof snapshot.personalBests)[number]) => item.updatedAt),
    ].reduce<string | null>((latest, current) => {
      if (!latest) {
        return current;
      }

      return current > latest ? current : latest;
    }, null) ?? snapshot.profile.updatedAt;

    const cacheGeneratedAt = snapshot.relationCache.generatedAt;
    const findings: DiagnosisIssue[] = [];

    if (!snapshot.relationCache.relationCacheId) {
      findings.push({
        code: "relation_cache_missing",
        title: "relation cache missing",
        severity: "medium",
        node: "check_relation_cache_status",
        summary: "No derived relation cache row exists for this person.",
        evidence: {
          personId: input.personId,
          personSlug: input.personSlug,
        },
      });
    } else if (cacheGeneratedAt && latestSnapshotUpdate && cacheGeneratedAt < latestSnapshotUpdate) {
      findings.push({
        code: "relation_cache_stale",
        title: "relation cache stale",
        severity: "low",
        node: "check_relation_cache_status",
        summary: "Relation cache is older than related profile data.",
        evidence: {
          personId: input.personId,
          cacheGeneratedAt,
          latestSnapshotUpdate,
        },
      });
    }

    return {
      ok: true,
      data: {
        findings,
      },
    } satisfies ToolResult<{ findings: DiagnosisIssue[] }>;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "check_relation_cache_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    } satisfies ToolResult<never>;
  }
}

export async function auditProfileCoverageTool(input: {
  personId: string;
  personSlug: string;
  displayNameJa?: string;
}) {
  try {
    const snapshot = await loadPersonSnapshot({ personId: input.personId });
    const profile = snapshot.profile;
    const missing: string[] = [];

    if (!profile.birthDate) missing.push("birthDate");
    if (!profile.hometown) missing.push("hometown");
    if (!profile.nationality) missing.push("nationality");
    if (!profile.displayNameKana) missing.push("displayNameKana");
    if (!profile.displayNameRoman) missing.push("displayNameRoman");

    const findings: DiagnosisIssue[] = [];
    if (missing.length > 0) {
      findings.push({
        code: "profile_coverage_missing_fields",
        title: "profile coverage gaps",
        severity: missing.length >= 3 ? "high" : "medium",
        node: "check_profile_coverage",
        summary: `Profile is missing ${missing.length} expected fields.`,
        evidence: {
          personId: input.personId,
          personSlug: input.personSlug,
          missing,
        },
      });
    }

    return { ok: true, data: { findings } } satisfies ToolResult<{ findings: DiagnosisIssue[] }>;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "audit_profile_coverage_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    } satisfies ToolResult<never>;
  }
}

export async function auditMembershipTimelineTool(input: {
  personId: string;
  personSlug: string;
}) {
  try {
    const snapshot = await loadPersonSnapshot({ personId: input.personId });
    const findings: DiagnosisIssue[] = [];
    const memberships = snapshot.memberships;
    const today = new Date().toISOString().slice(0, 10);

    const currentMemberships = memberships.filter((membership: (typeof memberships)[number]) => {
      const started = !membership.startDate || membership.startDate <= today;
      const notEnded = !membership.endDate || membership.endDate >= today;
      return started && notEnded;
    });

    if (currentMemberships.length > 1) {
      findings.push({
        code: "multiple_current_memberships",
        title: "multiple current memberships",
        severity: "high",
        node: "check_membership_timeline",
        summary: "More than one membership appears to be current.",
        evidence: {
          personId: input.personId,
          memberships: currentMemberships,
        },
      });
    }

    const highSchools = memberships.filter((membership) => membership.organizationType === "high_school");
    const universities = memberships.filter((membership) => membership.organizationType === "university");

    const latestHighSchool = highSchools.at(-1) ?? null;
    const earliestUniversity = universities[0] ?? null;

    if (
      latestHighSchool &&
      earliestUniversity &&
      latestHighSchool.startDate &&
      earliestUniversity.startDate &&
      latestHighSchool.startDate > earliestUniversity.startDate
    ) {
      findings.push({
        code: "high_school_starts_after_university",
        title: "high school starts after university",
        severity: "medium",
        node: "check_membership_timeline",
        summary: "High school membership starts after the earliest university membership.",
        evidence: {
          personId: input.personId,
          latestHighSchool,
          earliestUniversity,
        },
      });
    }

    for (let index = 0; index < memberships.length - 1; index += 1) {
      const current = memberships[index];
      const next = memberships[index + 1];
      const currentStart = current.startDate ?? "0000-00-00";
      const nextStart = next.startDate ?? "0000-00-00";

      if (currentStart > nextStart) {
        findings.push({
          code: "membership_order_anomaly",
          title: "membership timeline ordering anomaly",
          severity: "low",
          node: "check_membership_timeline",
          summary: "Memberships are not in chronological order.",
          evidence: {
            first: current,
            second: next,
          },
        });
      }

      if (current.organizationType === next.organizationType && current.startDate && next.startDate && current.endDate && next.endDate) {
        const overlaps = current.startDate <= next.endDate && next.startDate <= current.endDate;
        if (overlaps) {
          findings.push({
            code: "same_type_membership_overlap",
            title: "same type membership overlap",
            severity: "medium",
            node: "check_membership_timeline",
            summary: "Adjacent memberships of the same type overlap in time.",
            evidence: {
              first: current,
              second: next,
            },
          });
        }
      }
    }

    return { ok: true, data: { findings } } satisfies ToolResult<{ findings: DiagnosisIssue[] }>;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "audit_membership_timeline_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    } satisfies ToolResult<never>;
  }
}

export async function auditPersonNormalizationRiskTool(input: {
  personId: string;
  personSlug: string;
  displayNameJa?: string;
}) {
  try {
    const snapshot = await loadPersonSnapshot({ personId: input.personId });
    const displayNameJa = input.displayNameJa ?? snapshot.profile.displayNameJa;
    const findings: DiagnosisIssue[] = [];
    const duplicateCount = await countDuplicateNormalizedNames({
      displayNameJa,
    });

    if (duplicateCount > 1) {
      const candidates = await findNameNormalizationCandidates({
        personId: input.personId,
        personSlug: input.personSlug,
        displayNameJa,
      });

      findings.push({
        code: "duplicate_normalized_name",
        title: "duplicate normalized person name",
        severity: "high",
        node: "check_person_normalization_risk",
        summary: "More than one person shares the same normalized display name.",
        evidence: {
          personId: input.personId,
          personSlug: input.personSlug,
          displayNameJa,
          duplicateCount,
          candidates,
        },
      });
    }

    return { ok: true, data: { findings } } satisfies ToolResult<{ findings: DiagnosisIssue[] }>;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "audit_person_normalization_risk_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    } satisfies ToolResult<never>;
  }
}

export async function auditPersonalBestConsistencyTool(input: {
  personId: string;
  personSlug: string;
}) {
  try {
    const snapshot = await loadPersonSnapshot({ personId: input.personId });
    const findings: DiagnosisIssue[] = [];
    const groups = new Map<string, typeof snapshot.personalBests>();

    for (const personalBest of snapshot.personalBests) {
      const existing = groups.get(personalBest.discipline) ?? [];
      existing.push(personalBest);
      groups.set(personalBest.discipline, existing);
    }

    for (const [discipline, items] of groups.entries()) {
      const duplicateMarks = new Map<string, typeof items>();
      for (const item of items) {
        const key = `${item.markMillis ?? item.mark}`;
        const bucket = duplicateMarks.get(key) ?? [];
        bucket.push(item);
        duplicateMarks.set(key, bucket);
      }

      const exactDuplicates = [...duplicateMarks.values()].filter((bucket) => bucket.length > 1);
      const conflictingItems = items.filter((item) => item.status === "conflicting");

      if (exactDuplicates.length > 0) {
        findings.push({
          code: "duplicate_personal_bests",
          title: "duplicate personal best records",
          severity: "medium",
          node: "check_personal_best_consistency",
          summary: `There are duplicate PB rows for ${discipline}.`,
          evidence: {
            personId: input.personId,
            personSlug: input.personSlug,
            discipline,
            duplicateGroups: exactDuplicates,
          },
        });
      }

      for (const item of conflictingItems) {
        findings.push({
          code: "conflicting_personal_best",
          title: "conflicting personal best record",
          severity: "high",
          node: "check_personal_best_consistency",
          summary: `PB row for ${discipline} is marked conflicting.`,
          evidence: {
            personalBestId: item.personalBestId,
            mark: item.mark,
            status: item.status,
          },
        });
      }

      for (const item of items) {
        if (!item.markMillis) {
          findings.push({
            code: "personal_best_missing_mark_millis",
            title: "personal best missing canonical duration",
            severity: "low",
            node: "check_personal_best_consistency",
            summary: `PB row for ${discipline} lacks markMillis.`,
            evidence: {
              personalBestId: item.personalBestId,
              mark: item.mark,
            },
          });
        }
      }
    }

    return { ok: true, data: { findings } } satisfies ToolResult<{ findings: DiagnosisIssue[] }>;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "audit_personal_best_consistency_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    } satisfies ToolResult<never>;
  }
}
