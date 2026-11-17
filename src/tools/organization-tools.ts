import type { DiagnosisIssue } from "../types/diagnosis.js";
import type { OrganizationCandidate } from "../types/organization-diagnosis.js";
import {
  findOrganizationNormalizationCandidates,
  loadOrganizationSnapshot,
  resolveOrganizationCandidates,
} from "../db/business-queries.js";
import { normalizeSearchKey } from "../lib/normalize.js";

export type OrganizationToolResult<T> = {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
};

export async function resolveOrganizationTool(input: {
  organizationSlug?: string | null;
  organizationId?: string | null;
  organizationName?: string | null;
}) {
  try {
    const candidates = await resolveOrganizationCandidates(input);
    if (candidates.length === 0) {
      return { ok: true, data: { matchType: "not_found" as const } } satisfies OrganizationToolResult<{ matchType: "not_found" }>;
    }
    if (candidates.length === 1) {
      return {
        ok: true,
        data: { matchType: "unique" as const, organization: candidates[0] },
      } satisfies OrganizationToolResult<{ matchType: "unique"; organization: OrganizationCandidate }>;
    }
    return {
      ok: true,
      data: { matchType: "multiple" as const, candidates },
    } satisfies OrganizationToolResult<{ matchType: "multiple"; candidates: OrganizationCandidate[] }>;
  } catch (error) {
    return {
      ok: false,
      error: { code: "resolve_organization_failed", message: error instanceof Error ? error.message : String(error) },
    } satisfies OrganizationToolResult<never>;
  }
}

export async function loadOrganizationSnapshotTool(input: { organizationId: string }) {
  try {
    return {
      ok: true,
      data: await loadOrganizationSnapshot(input),
    } satisfies OrganizationToolResult<Awaited<ReturnType<typeof loadOrganizationSnapshot>>>;
  } catch (error) {
    return {
      ok: false,
      error: { code: "load_organization_snapshot_failed", message: error instanceof Error ? error.message : String(error) },
    } satisfies OrganizationToolResult<never>;
  }
}

export async function auditOrganizationCoverageTool(input: {
  organizationId: string;
  organizationSlug: string;
}) {
  try {
    const snapshot = await loadOrganizationSnapshot({ organizationId: input.organizationId });
    const missing: string[] = [];
    const organization = snapshot.organization;

    if (!organization.nameKana) missing.push("nameKana");
    if (!organization.nameRoman) missing.push("nameRoman");
    if (!organization.location) missing.push("location");
    if (!organization.prefecture) missing.push("prefecture");
    if (!organization.websiteUrl) missing.push("websiteUrl");

    const findings: DiagnosisIssue[] = missing.length === 0
      ? []
      : [{
          code: "organization_coverage_missing_fields",
          title: "organization coverage gaps",
          severity: "low",
          node: "check_organization_coverage",
          summary: `Organization is missing ${missing.length} optional fields.`,
          evidence: { organizationId: input.organizationId, organizationSlug: input.organizationSlug, missing },
        }];

    return { ok: true, data: { findings } } satisfies OrganizationToolResult<{ findings: DiagnosisIssue[] }>;
  } catch (error) {
    return {
      ok: false,
      error: { code: "audit_organization_coverage_failed", message: error instanceof Error ? error.message : String(error) },
    } satisfies OrganizationToolResult<never>;
  }
}

export async function auditOrganizationNormalizationRiskTool(input: {
  organizationId: string;
  organizationSlug: string;
  nameJa?: string;
}) {
  try {
    const snapshot = await loadOrganizationSnapshot({ organizationId: input.organizationId });
    const nameJa = input.nameJa ?? snapshot.organization.nameJa;
    const candidates = await findOrganizationNormalizationCandidates({
      organizationId: input.organizationId,
      nameJa,
    });
    const findings: DiagnosisIssue[] = [];

    if (candidates.length > 3) {
      findings.push({
        code: "organization_normalization_candidate_overflow",
        title: "organization normalization candidate overflow",
        severity: "high",
        node: "check_organization_normalization_risk",
        summary: `Exact normalized organization name matched ${candidates.length} other records.`,
        evidence: { organizationId: input.organizationId, organizationSlug: input.organizationSlug, nameJa, candidates },
      });
      return {
        ok: true,
        data: { findings, candidates, riskStatus: "overflow" as const },
      } satisfies OrganizationToolResult<{ findings: DiagnosisIssue[]; candidates: OrganizationCandidate[]; riskStatus: "overflow" }>;
    }

    if (candidates.length === 0) {
      return {
        ok: true,
        data: { findings, candidates, riskStatus: "no_risk" as const },
      } satisfies OrganizationToolResult<{ findings: DiagnosisIssue[]; candidates: OrganizationCandidate[]; riskStatus: "no_risk" }>;
    }

    const sameType = candidates.every((candidate) => candidate.type === snapshot.organization.type);
    findings.push({
      code: sameType ? "duplicate_normalized_organization_name" : "organization_same_name_cross_type",
      title: sameType ? "duplicate normalized organization name" : "same organization name across types",
      severity: "high",
      node: "check_organization_normalization_risk",
      summary: sameType
        ? "Another organization has the same normalized Japanese name and type."
        : "Another organization has the same normalized Japanese name but a different type.",
      evidence: {
        organizationId: input.organizationId,
        organizationSlug: input.organizationSlug,
        targetNameJa: nameJa,
        normalizedNameJa: normalizeSearchKey(nameJa),
        targetType: snapshot.organization.type,
        candidates,
      },
    });
    return {
      ok: true,
      // Type mismatches are often import artifacts such as company vs corporate team.
      // Let the identity-research node distinguish them before keeping the collision.
      data: { findings, candidates, riskStatus: "ambiguous" as const },
    } satisfies OrganizationToolResult<{
      findings: DiagnosisIssue[];
      candidates: OrganizationCandidate[];
      riskStatus: "ambiguous";
    }>;
  } catch (error) {
    return {
      ok: false,
      error: { code: "audit_organization_normalization_risk_failed", message: error instanceof Error ? error.message : String(error) },
    } satisfies OrganizationToolResult<never>;
  }
}

export async function auditOrganizationReferenceFootprintTool(input: {
  organizationId: string;
  organizationSlug: string;
}) {
  try {
    const snapshot = await loadOrganizationSnapshot({ organizationId: input.organizationId });
    const references = snapshot.referenceStats;
    const total = Object.values(references).reduce((sum, count) => sum + count, 0);
    const findings: DiagnosisIssue[] = total === 0
      ? [{
          code: "organization_unreferenced",
          title: "unreferenced organization",
          severity: "low",
          node: "check_organization_reference_footprint",
          summary: "Organization has no current membership, result, variant, or source references.",
          evidence: { organizationId: input.organizationId, organizationSlug: input.organizationSlug, referenceStats: references },
        }]
      : [];

    return {
      ok: true,
      data: { findings, referenceStats: references },
    } satisfies OrganizationToolResult<{ findings: DiagnosisIssue[]; referenceStats: typeof references }>;
  } catch (error) {
    return {
      ok: false,
      error: { code: "audit_organization_reference_footprint_failed", message: error instanceof Error ? error.message : String(error) },
    } satisfies OrganizationToolResult<never>;
  }
}
