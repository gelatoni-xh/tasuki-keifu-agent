import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";

import { recordAgentEvent, recordCheckpoint } from "../db/repositories.js";
import { researchOrganizationIdentity } from "../lib/codex-llm.js";
import { createLogger } from "../lib/logger.js";
import { researchOrganizationWikipedia } from "../lib/wikipedia.js";
import {
  auditOrganizationCoverageTool,
  auditOrganizationNormalizationRiskTool,
  auditOrganizationReferenceFootprintTool,
  loadOrganizationSnapshotTool,
  resolveOrganizationTool,
} from "../tools/organization-tools.js";
import type { SuggestedAction } from "../types/diagnosis.js";
import {
  OrganizationDiagnosisStateSchema,
  type OrganizationDiagnosisState,
} from "../types/organization-diagnosis.js";

type OrganizationDiagnosisNode =
  | "resolve_organization"
  | "load_organization_snapshot"
  | "check_organization_coverage"
  | "research_organization_wikipedia"
  | "check_organization_normalization_risk"
  | "research_organization_identity"
  | "check_organization_reference_footprint"
  | "summarize_findings"
  | "build_action_plan"
  | "evaluate_action_bundle_risk";

function appendNode(state: OrganizationDiagnosisState, nodeName: OrganizationDiagnosisNode) {
  return {
    runtimeCurrentNode: nodeName,
    runtimeNodeHistory: [...state.runtimeNodeHistory, nodeName],
  };
}

function instrumentNode(
  nodeName: OrganizationDiagnosisNode,
  handler: (state: OrganizationDiagnosisState) => Promise<Partial<OrganizationDiagnosisState>>,
  logger = createLogger("organization-diagnosis-graph"),
) {
  return async (state: OrganizationDiagnosisState) => {
    await recordAgentEvent({
      runId: state.runtimeRunId,
      nodeName,
      level: "debug",
      message: "node_start",
      payload: { state: { runtimeCurrentNode: state.runtimeCurrentNode } },
    });
    const update = await handler(state);
    const merged = { ...state, ...update, ...appendNode(state, nodeName) } satisfies OrganizationDiagnosisState;
    await recordCheckpoint({ runId: state.runtimeRunId, nodeName, state: merged });
    await recordAgentEvent({
      runId: state.runtimeRunId,
      nodeName,
      level: "info",
      message: "node_complete",
      payload: { findings: merged.findings.length, actions: merged.actions.length, runtimeStatus: merged.runtimeStatus },
    });
    logger.debug("node_complete", { nodeName, runId: state.runtimeRunId });
    return { ...update, ...appendNode(state, nodeName) };
  };
}

async function resolveOrganizationNode(state: OrganizationDiagnosisState): Promise<Partial<OrganizationDiagnosisState>> {
  const result = await resolveOrganizationTool({
    organizationId: state.inputOrganizationId,
    organizationSlug: state.inputOrganizationSlug,
    organizationName: state.inputOrganizationName,
  });
  if (!result.ok || !result.data) {
    return { runtimeStatus: "failed", runtimeErrorMessage: result.error?.message ?? "resolve_organization_failed" };
  }
  if (result.data.matchType === "not_found") {
    return {
      resolutionStatus: "not_found",
      runtimeStatus: "completed",
      resultStatus: "not_found",
      resultSummary: "Organization could not be resolved from the provided input.",
    };
  }
  if (result.data.matchType === "multiple") {
    return {
      resolutionStatus: "multiple",
      candidateOrganizations: result.data.candidates,
      runtimeStatus: "need_clarification",
      resultStatus: "need_clarification",
      resultSummary: "Multiple organizations matched the input. Provide an organization slug or ID.",
    };
  }
  return {
    resolutionStatus: "unique",
    targetOrganizationId: result.data.organization.organizationId,
    targetOrganizationSlug: result.data.organization.organizationSlug,
    targetOrganizationNameJa: result.data.organization.nameJa,
  };
}

async function loadSnapshotNode(state: OrganizationDiagnosisState): Promise<Partial<OrganizationDiagnosisState>> {
  const result = await loadOrganizationSnapshotTool({ organizationId: state.targetOrganizationId ?? "" });
  if (!result.ok || !result.data) {
    return { runtimeStatus: "failed", runtimeErrorMessage: result.error?.message ?? "load_organization_snapshot_failed" };
  }
  return { organization: result.data.organization, referenceStats: result.data.referenceStats };
}

async function coverageNode(state: OrganizationDiagnosisState): Promise<Partial<OrganizationDiagnosisState>> {
  const result = await auditOrganizationCoverageTool({
    organizationId: state.targetOrganizationId ?? "",
    organizationSlug: state.targetOrganizationSlug ?? "",
  });
  return { findings: [...state.findings, ...(result.ok && result.data ? result.data.findings : [])] };
}

async function researchOrganizationWikipediaNode(
  state: OrganizationDiagnosisState,
): Promise<Partial<OrganizationDiagnosisState>> {
  const coverage = state.findings.find((finding) => finding.code === "organization_coverage_missing_fields");
  const missing = Array.isArray(coverage?.evidence.missing)
    ? coverage.evidence.missing.filter((field): field is string => field === "websiteUrl" || field === "prefecture")
    : [];
  if (!state.targetOrganizationNameJa || missing.length === 0) {
    return {
      organizationWikipediaResearch: {
        status: "not_needed",
        summary: "官网和都道府县均无需补全。",
        sourceUrl: null,
        suggestedFields: {},
      },
    };
  }
  const research = await researchOrganizationWikipedia({ targetName: state.targetOrganizationNameJa, missingFields: missing });
  if (research.status !== "found") {
    return {
      organizationWikipediaResearch: research,
      resultNotes: [...state.resultNotes, `组织 Wikipedia 查询未补到字段：${research.summary}`],
    };
  }
  return {
    organizationWikipediaResearch: research,
    findings: [
      ...state.findings,
      {
        code: "organization_wikipedia_data_available",
        title: "Wikipedia organization data available",
        severity: "low",
        node: "research_organization_wikipedia",
        summary: research.summary,
        evidence: {
          organizationId: state.targetOrganizationId,
          organizationSlug: state.targetOrganizationSlug,
          sourceUrl: research.sourceUrl,
          suggestedFields: research.suggestedFields,
        },
      },
    ],
    resultNotes: [...state.resultNotes, `组织 Wikipedia 查询：${research.summary}`],
  };
}

async function normalizationNode(state: OrganizationDiagnosisState): Promise<Partial<OrganizationDiagnosisState>> {
  const result = await auditOrganizationNormalizationRiskTool({
    organizationId: state.targetOrganizationId ?? "",
    organizationSlug: state.targetOrganizationSlug ?? "",
    nameJa: state.targetOrganizationNameJa ?? undefined,
  });
  return {
    findings: [...state.findings, ...(result.ok && result.data ? result.data.findings : [])],
    normalizationCandidates: result.ok && result.data ? result.data.candidates : [],
    normalizationRiskStatus: result.ok && result.data ? result.data.riskStatus : "not_checked",
  };
}

async function researchIdentityNode(state: OrganizationDiagnosisState): Promise<Partial<OrganizationDiagnosisState>> {
  if (state.normalizationRiskStatus !== "ambiguous" || state.normalizationCandidates.length !== 1 || !state.organization) {
    return { normalizationRiskStatus: state.normalizationRiskStatus === "not_checked" ? "no_risk" : state.normalizationRiskStatus };
  }
  const research = await researchOrganizationIdentity({
    targetName: state.organization.nameJa,
    targetType: state.organization.type,
    candidates: state.normalizationCandidates,
  });
  const normalizationCodes = new Set([
    "duplicate_normalized_organization_name",
    "organization_same_name_cross_type",
  ]);
  if (research.verdict === "different") {
    return {
      findings: state.findings.filter((finding) => !normalizationCodes.has(finding.code)),
      normalizationRiskStatus: "no_risk",
      nameIdentityResearchVerdict: "different",
      resultNotes: [...state.resultNotes, `组织身份研究（different）：${research.summary}`],
    };
  }
  if (research.verdict === "uncertain") {
    return {
      findings: [
        ...state.findings.filter((finding) => !normalizationCodes.has(finding.code)),
        {
          code: "organization_identity_uncertain",
          title: "organization identity uncertain",
          severity: "high",
          node: "research_organization_identity",
          summary: research.summary,
          evidence: {
            organizationId: state.targetOrganizationId,
            organizationSlug: state.targetOrganizationSlug,
            candidates: state.normalizationCandidates,
            reason: research.reason,
            sourceMode: research.sourceMode,
          },
        },
      ],
      nameIdentityResearchVerdict: "uncertain",
      resultNotes: [...state.resultNotes, `组织身份研究（uncertain）：${research.summary}`],
    };
  }
  return {
    nameIdentityResearchVerdict: "same",
    normalizationRiskStatus: "definite",
    resultNotes: [...state.resultNotes, `组织身份研究（same）：${research.summary}`],
  };
}

async function referenceFootprintNode(state: OrganizationDiagnosisState): Promise<Partial<OrganizationDiagnosisState>> {
  const result = await auditOrganizationReferenceFootprintTool({
    organizationId: state.targetOrganizationId ?? "",
    organizationSlug: state.targetOrganizationSlug ?? "",
  });
  return {
    findings: [...state.findings, ...(result.ok && result.data ? result.data.findings : [])],
    referenceStats: result.ok && result.data ? result.data.referenceStats : state.referenceStats,
  };
}

async function summarizeFindingsNode(state: OrganizationDiagnosisState): Promise<Partial<OrganizationDiagnosisState>> {
  const highCount = state.findings.filter((finding) => finding.severity === "high" || finding.severity === "critical").length;
  return {
    resultStatus: "completed",
    resultSummary: state.findings.length === 0
      ? "No material organization issues found."
      : `${state.findings.length} organization issues found (${highCount} high severity).`,
  };
}

async function buildActionPlanNode(state: OrganizationDiagnosisState): Promise<Partial<OrganizationDiagnosisState>> {
  const needsReview = state.findings.some((finding) => [
    "duplicate_normalized_organization_name",
    "organization_same_name_cross_type",
    "organization_identity_uncertain",
  ].includes(finding.code));
  const actions: SuggestedAction[] = [];
  if (state.findings.some((finding) => finding.code === "organization_wikipedia_data_available")) {
    actions.push({
      code: "backfill_organization_from_wikipedia",
      title: "Backfill organization fields from Wikipedia",
      priority: "low",
      rationale: "Wikipedia supplied an explicit official website or prefecture for currently empty fields.",
      relatedIssueCodes: ["organization_wikipedia_data_available"],
    });
  }
  if (needsReview) {
    actions.push({
        code: "review_organization_normalization",
        title: "Review organization normalization",
        priority: "high",
        rationale: "Organization merges can rewrite memberships, results, source mappings, and name variants.",
        relatedIssueCodes: state.findings
          .filter((finding) => [
            "duplicate_normalized_organization_name",
            "organization_same_name_cross_type",
            "organization_identity_uncertain",
          ].includes(finding.code))
          .map((finding) => finding.code),
      });
  }
  const candidate = state.nameIdentityResearchVerdict === "same" && state.normalizationCandidates.length === 1
    ? state.normalizationCandidates[0]
    : null;
  const candidateSnapshot = candidate
    ? await loadOrganizationSnapshotTool({ organizationId: candidate.organizationId })
    : null;
  const candidateProfile = candidateSnapshot?.ok && candidateSnapshot.data ? candidateSnapshot.data.organization : null;
  const candidateReferenceStats = candidateSnapshot?.ok && candidateSnapshot.data ? candidateSnapshot.data.referenceStats : null;

  function isImportSlug(slug: string) {
    return /^(org|hs|univ|club)-[a-f0-9]{8,}$/i.test(slug);
  }
  function referenceScore(value: NonNullable<OrganizationDiagnosisState["referenceStats"]>) {
    return value.membershipCount
      + value.personalBestCount
      + value.raceResultCount
      + value.teamCompetitionResultCount
      + value.nameVariantCount
      + value.sourceReferenceCount;
  }
  function chooseCanonical() {
    if (!candidate || !candidateProfile || !candidateReferenceStats || !state.organization || !state.referenceStats) {
      return null;
    }
    if (state.organization.type !== candidateProfile.type) {
      if (state.organization.type === "corporate_team") return "target" as const;
      if (candidateProfile.type === "corporate_team") return "candidate" as const;
    }
    const targetImport = isImportSlug(state.organization.organizationSlug);
    const candidateImport = isImportSlug(candidateProfile.organizationSlug);
    if (targetImport !== candidateImport) {
      return targetImport ? "candidate" as const : "target" as const;
    }
    const targetScore = referenceScore(state.referenceStats);
    const candidateScore = referenceScore(candidateReferenceStats);
    if (targetScore !== candidateScore) {
      return targetScore > candidateScore ? "target" as const : "candidate" as const;
    }
    const targetCreatedAt = new Date(state.organization.createdAt).getTime();
    const candidateCreatedAt = new Date(candidateProfile.createdAt).getTime();
    if (targetCreatedAt !== candidateCreatedAt) {
      return targetCreatedAt < candidateCreatedAt ? "target" as const : "candidate" as const;
    }
    return null;
  }

  const canonicalChoice = chooseCanonical();
  if (candidate && candidateProfile && canonicalChoice) {
    const reviewIndex = actions.findIndex((action) => action.code === "review_organization_normalization");
    if (reviewIndex >= 0) {
      actions.splice(reviewIndex, 1);
    }
    actions.push({
      code: "merge_organization_duplicate",
      title: "Merge confirmed duplicate organization",
      priority: "medium",
      rationale: "LLM research confirmed the records are the same organization and the canonical record was selected by a deterministic rule.",
      relatedIssueCodes: state.findings
        .filter((finding) => [
          "duplicate_normalized_organization_name",
          "organization_same_name_cross_type",
        ].includes(finding.code))
        .map((finding) => finding.code),
    });
  }
  const actionOrder: Record<string, number> = {
    backfill_organization_from_wikipedia: 1,
    merge_organization_duplicate: 2,
    review_organization_normalization: 99,
  };
  actions.sort((left, right) => (actionOrder[left.code] ?? 50) - (actionOrder[right.code] ?? 50));
  const bundleItems = actions.map((action, index) => ({
    code: action.code,
    title: action.title,
    order: index + 1,
    rationale: action.rationale,
    relatedIssueCodes: action.relatedIssueCodes,
    payload: action.code === "merge_organization_duplicate" && candidate && candidateProfile && canonicalChoice
      ? {
          canonicalOrganizationId: canonicalChoice === "target" ? state.targetOrganizationId : candidateProfile.organizationId,
          canonicalOrganizationSlug: canonicalChoice === "target" ? state.targetOrganizationSlug : candidateProfile.organizationSlug,
          duplicateOrganizationId: canonicalChoice === "target" ? candidateProfile.organizationId : state.targetOrganizationId,
          duplicateOrganizationSlug: canonicalChoice === "target" ? candidateProfile.organizationSlug : state.targetOrganizationSlug,
          researchSummary: state.resultNotes.at(-1) ?? null,
        }
      : action.code === "backfill_organization_from_wikipedia"
      ? {
          organizationId: state.targetOrganizationId,
          organizationSlug: state.targetOrganizationSlug,
          sourceUrl: state.organizationWikipediaResearch?.sourceUrl ?? null,
          suggestedFields: state.organizationWikipediaResearch?.suggestedFields ?? {},
        }
      : {
          organizationId: state.targetOrganizationId,
          organizationSlug: state.targetOrganizationSlug,
          candidates: state.normalizationCandidates,
          referenceStats: state.referenceStats,
        },
    idempotencyKey: [
      "organization",
      state.targetOrganizationId ?? "unresolved",
      action.code,
      action.code === "merge_organization_duplicate" && candidate && candidateProfile && canonicalChoice
        ? [
            canonicalChoice === "target" ? state.targetOrganizationId : candidateProfile.organizationId,
            canonicalChoice === "target" ? candidateProfile.organizationId : state.targetOrganizationId,
          ].join(":")
        : state.normalizationCandidates.map((candidate) => candidate.organizationId).sort().join(":"),
    ].join(":"),
  }));
  return {
    actions,
    actionBundle: {
      organizationId: state.targetOrganizationId,
      organizationSlug: state.targetOrganizationSlug,
      items: bundleItems,
    },
  };
}

async function evaluateRiskNode(state: OrganizationDiagnosisState): Promise<Partial<OrganizationDiagnosisState>> {
  const items = state.actionBundle?.items ?? [];
  if (items.length === 0) {
    return {
      actionRiskAssessment: { level: "low", reasons: ["当前没有需要执行的组织写动作。"], executionStatus: "skipped" },
      runtimeStatus: "completed",
      runtimeEndedAt: new Date().toISOString(),
    };
  }
  if (items.every((item) => item.code === "backfill_organization_from_wikipedia")) {
    return {
      actionRiskAssessment: {
        level: "low",
        reasons: ["动作只会填充 Wikipedia 明确给出的官网或都道府县空字段。"],
        executionStatus: "planned",
      },
      runtimeStatus: "completed",
      runtimeEndedAt: new Date().toISOString(),
    };
  }
  if (items.every((item) => item.code === "backfill_organization_from_wikipedia" || item.code === "merge_organization_duplicate")) {
    return {
      actionRiskAssessment: {
        level: items.some((item) => item.code === "merge_organization_duplicate") ? "medium" : "low",
        reasons: items.some((item) => item.code === "merge_organization_duplicate")
          ? ["组织身份已由 LLM 研究确认，且主记录按固定规则唯一选出。"]
          : ["动作只会填充 Wikipedia 明确给出的官网或都道府县空字段。"],
        executionStatus: "planned",
      },
      runtimeStatus: "completed",
      runtimeEndedAt: new Date().toISOString(),
    };
  }
  return {
    actionRiskAssessment: {
      level: "high",
      reasons: ["组织归一化未能唯一确认同一实体或选出主记录，不能自动合并。"],
      executionStatus: "held",
    },
    runtimeStatus: "completed",
    runtimeEndedAt: new Date().toISOString(),
  };
}

export function buildOrganizationDiagnosisGraph() {
  const logger = createLogger("organization-diagnosis-graph");
  const graph = new StateGraph<
    typeof OrganizationDiagnosisStateSchema,
    OrganizationDiagnosisState,
    Partial<OrganizationDiagnosisState>,
    OrganizationDiagnosisNode
  >(OrganizationDiagnosisStateSchema);
  graph.addNode("resolve_organization", instrumentNode("resolve_organization", resolveOrganizationNode, logger));
  graph.addNode("load_organization_snapshot", instrumentNode("load_organization_snapshot", loadSnapshotNode, logger));
  graph.addNode("check_organization_coverage", instrumentNode("check_organization_coverage", coverageNode, logger));
  graph.addNode("research_organization_wikipedia", instrumentNode("research_organization_wikipedia", researchOrganizationWikipediaNode, logger));
  graph.addNode("check_organization_normalization_risk", instrumentNode("check_organization_normalization_risk", normalizationNode, logger));
  graph.addNode("research_organization_identity", instrumentNode("research_organization_identity", researchIdentityNode, logger));
  graph.addNode("check_organization_reference_footprint", instrumentNode("check_organization_reference_footprint", referenceFootprintNode, logger));
  graph.addNode("summarize_findings", instrumentNode("summarize_findings", summarizeFindingsNode, logger));
  graph.addNode("build_action_plan", instrumentNode("build_action_plan", buildActionPlanNode, logger));
  graph.addNode("evaluate_action_bundle_risk", instrumentNode("evaluate_action_bundle_risk", evaluateRiskNode, logger));

  graph.addEdge(START, "resolve_organization");
  graph.addConditionalEdges(
    "resolve_organization",
    (state) => state.resolutionStatus === "unique" ? "load_organization_snapshot" : END,
    ["load_organization_snapshot", END],
  );
  graph.addEdge("load_organization_snapshot", "check_organization_coverage");
  graph.addEdge("check_organization_coverage", "research_organization_wikipedia");
  graph.addEdge("research_organization_wikipedia", "check_organization_normalization_risk");
  graph.addConditionalEdges(
    "check_organization_normalization_risk",
    (state) => state.normalizationRiskStatus === "ambiguous" && state.normalizationCandidates.length === 1
      ? "research_organization_identity"
      : "check_organization_reference_footprint",
    ["research_organization_identity", "check_organization_reference_footprint"],
  );
  graph.addEdge("research_organization_identity", "check_organization_reference_footprint");
  graph.addEdge("check_organization_reference_footprint", "summarize_findings");
  graph.addEdge("summarize_findings", "build_action_plan");
  graph.addEdge("build_action_plan", "evaluate_action_bundle_risk");
  graph.addEdge("evaluate_action_bundle_risk", END);
  return graph.compile({ checkpointer: new MemorySaver() });
}

export type OrganizationDiagnosisGraph = ReturnType<typeof buildOrganizationDiagnosisGraph>;
