import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";

import { createLogger } from "../lib/logger.js";
import { researchNameIdentity } from "../lib/codex-llm.js";
import { normalizeSearchKey } from "../lib/normalize.js";
import { researchProfileWikipedia } from "../lib/wikipedia.js";
import {
  auditMembershipTimelineTool,
  auditPersonNormalizationRiskTool,
  auditPersonalBestConsistencyTool,
  auditProfileCoverageTool,
  loadPersonSnapshotTool,
  resolvePersonTool,
} from "../tools/person-tools.js";
import { recordAgentEvent, recordCheckpoint } from "../db/repositories.js";
import type { ActionBundleItem, SuggestedAction } from "../types/diagnosis.js";
import { PersonDiagnosisStateSchema, type PersonDiagnosisState } from "../state/person-diagnosis.js";

type PersonDiagnosisNode =
  | "resolve_person"
  | "clarification"
  | "load_person_snapshot"
  | "check_profile_coverage"
  | "research_profile_wikipedia"
  | "check_membership_timeline"
  | "check_person_normalization_risk"
  | "research_name_identity"
  | "check_personal_best_consistency"
  | "summarize_findings"
  | "build_action_plan"
  | "evaluate_action_bundle_risk";

function appendNode(state: PersonDiagnosisState, nodeName: PersonDiagnosisNode) {
  return {
    runtimeCurrentNode: nodeName,
    runtimeNodeHistory: [...state.runtimeNodeHistory, nodeName],
  };
}

function mergeNodeState(state: PersonDiagnosisState, update: Partial<PersonDiagnosisState>, nodeName: PersonDiagnosisNode) {
  return {
    ...state,
    ...update,
    ...appendNode(state, nodeName),
  } satisfies PersonDiagnosisState;
}

function instrumentNode(
  nodeName: PersonDiagnosisNode,
  handler: (state: PersonDiagnosisState) => Promise<Partial<PersonDiagnosisState>>,
  logger = createLogger("person-diagnosis-graph"),
) {
  return async (state: PersonDiagnosisState) => {
    logger.debug("node_start", {
      nodeName,
      runId: state.runtimeRunId,
    });

    await recordAgentEvent({
      runId: state.runtimeRunId,
      nodeName,
      level: "debug",
      message: "node_start",
      payload: { state: { runtimeCurrentNode: state.runtimeCurrentNode } },
    });

    const update = await handler(state);
    const merged = mergeNodeState(state, update, nodeName);

    await recordCheckpoint({
      runId: state.runtimeRunId,
      nodeName,
      state: merged,
    });

    await recordAgentEvent({
      runId: state.runtimeRunId,
      nodeName,
      level: "info",
      message: "node_complete",
      payload: {
        findings: merged.findings.length,
        actions: merged.actions.length,
        runtimeStatus: merged.runtimeStatus,
      },
    });

    return {
      ...update,
      ...appendNode(state, nodeName),
    };
  };
}

async function resolvePersonNode(state: PersonDiagnosisState) {
  const clarificationText = state.clarificationAttempts > 0 ? state.inputClarification : null;
  const effectivePersonSlug =
    clarificationText && /^person-[a-z0-9-]+$/i.test(clarificationText)
      ? clarificationText
      : state.inputPersonSlug;
  const effectivePersonName =
    clarificationText ?? state.inputPersonName ?? state.inputClarification;

  const result = await resolvePersonTool({
    personSlug: effectivePersonSlug,
    personId: state.inputPersonId,
    personName: effectivePersonName,
  });

  if (!result.ok) {
    return {
      runtimeStatus: "failed",
      runtimeErrorMessage: result.error?.message ?? "resolve_person_failed",
    } satisfies Partial<PersonDiagnosisState>;
  }

  if (result.data.matchType === "not_found") {
    return {
      resolutionStatus: "not_found",
      runtimeStatus: "completed",
      resultStatus: "not_found",
      resultSummary: "Person could not be resolved from the provided input.",
      resultNotes: [...state.resultNotes, "No person matched the input."],
    } satisfies Partial<PersonDiagnosisState>;
  }

  if (result.data.matchType === "multiple") {
    const clarificationRequired = state.clarificationAttempts === 0 && Boolean(state.inputClarification);
    return {
      resolutionStatus: "multiple",
      candidatePeople: result.data.candidates,
      runtimeStatus: clarificationRequired ? "running" : "need_clarification",
      resultStatus: "need_clarification",
      resultSummary: clarificationRequired
        ? "Multiple people matched the input. Clarification is required."
        : "Multiple people matched the input. Manual follow-up is required.",
      resultNotes: [
        ...state.resultNotes,
        `Matched ${result.data.candidates.length} candidates.`,
      ],
    } satisfies Partial<PersonDiagnosisState>;
  }

  const person = result.data.person;
  return {
    resolutionStatus: "unique",
    targetPersonId: person.personId,
    targetPersonSlug: person.personSlug,
    targetDisplayNameJa: person.displayNameJa,
    candidatePeople: [],
    runtimeStatus: "running",
  } satisfies Partial<PersonDiagnosisState>;
}

async function clarificationNode(state: PersonDiagnosisState) {
  const nextAttempt = state.clarificationAttempts + 1;
  return {
    clarificationAttempts: nextAttempt,
    runtimeStatus: "running",
    resultStatus: null,
    resultSummary: state.resultSummary ?? "Clarification requested.",
    resultNotes: [
      ...state.resultNotes,
      `Clarification attempt ${nextAttempt} for ${state.inputPersonSlug ?? state.inputPersonName ?? state.inputPersonId ?? "unknown"}.`,
    ],
  } satisfies Partial<PersonDiagnosisState>;
}

async function loadSnapshotNode(state: PersonDiagnosisState) {
  const result = await loadPersonSnapshotTool({ personId: state.targetPersonId ?? state.inputPersonId ?? "" });
  if (!result.ok || !result.data) {
    return {
      runtimeStatus: "failed",
      runtimeErrorMessage: result.error?.message ?? "load_person_snapshot_failed",
    } satisfies Partial<PersonDiagnosisState>;
  }

  return {
    profile: result.data.profile,
    memberships: result.data.memberships,
    personalBests: result.data.personalBests,
    relationCache: result.data.relationCache,
  } satisfies Partial<PersonDiagnosisState>;
}

async function profileCoverageNode(state: PersonDiagnosisState) {
  const result = await auditProfileCoverageTool({
    personId: state.targetPersonId ?? "",
    personSlug: state.targetPersonSlug ?? "",
    displayNameJa: state.targetDisplayNameJa ?? undefined,
  });

  return {
    findings: [...state.findings, ...(result.ok && result.data ? result.data.findings : [])],
  } satisfies Partial<PersonDiagnosisState>;
}

async function researchProfileWikipediaNode(state: PersonDiagnosisState) {
  const profileFinding = state.findings.find((finding) => finding.code === "profile_coverage_missing_fields");
  const missingFields = Array.isArray(profileFinding?.evidence.missing)
    ? profileFinding.evidence.missing.filter((field): field is string => typeof field === "string")
    : [];

  if (missingFields.length === 0) {
    return {
      profileWikipediaResearch: {
        status: "not_needed",
        summary: "Profile 没有需要补查的字段。",
        sourceUrl: null,
        suggestedFields: {},
      },
    } satisfies Partial<PersonDiagnosisState>;
  }

  const research = await researchProfileWikipedia({
    targetName: state.targetDisplayNameJa ?? "",
    missingFields,
  });

  if (research.status === "found") {
    return {
      profileWikipediaResearch: research,
      findings: [
        ...state.findings,
        {
          code: "profile_wikipedia_data_available",
          title: "Wikipedia profile data available",
          severity: "low",
          node: "research_profile_wikipedia",
          summary: research.summary,
          evidence: {
            personId: state.targetPersonId,
            personSlug: state.targetPersonSlug,
            sourceUrl: research.sourceUrl,
            suggestedFields: research.suggestedFields,
          },
        },
      ],
      resultNotes: [...state.resultNotes, `Wikipedia profile 查询：${research.summary}`],
    } satisfies Partial<PersonDiagnosisState>;
  }

  return {
    profileWikipediaResearch: research,
    resultNotes: [...state.resultNotes, `Wikipedia profile 查询未补到字段：${research.summary}`],
  } satisfies Partial<PersonDiagnosisState>;
}

async function membershipTimelineNode(state: PersonDiagnosisState) {
  const result = await auditMembershipTimelineTool({
    personId: state.targetPersonId ?? "",
    personSlug: state.targetPersonSlug ?? "",
  });

  return {
    findings: [...state.findings, ...(result.ok && result.data ? result.data.findings : [])],
  } satisfies Partial<PersonDiagnosisState>;
}

async function normalizationRiskNode(state: PersonDiagnosisState) {
  const result = await auditPersonNormalizationRiskTool({
    personId: state.targetPersonId ?? "",
    personSlug: state.targetPersonSlug ?? "",
    displayNameJa: state.targetDisplayNameJa ?? undefined,
  });

  return {
    findings: [...state.findings, ...(result.ok && result.data ? result.data.findings : [])],
    normalizationCandidates: result.ok && result.data ? result.data.candidates : [],
    normalizationRiskStatus: result.ok && result.data ? result.data.riskStatus : "not_checked",
  } satisfies Partial<PersonDiagnosisState>;
}

async function researchNameIdentityNode(state: PersonDiagnosisState) {
  const shouldResearch =
    (state.normalizationRiskStatus === "ambiguous" || state.normalizationRiskStatus === "definite")
    && state.normalizationCandidates.length === 1;

  if (!shouldResearch) {
    return {
      normalizationRiskStatus: state.normalizationRiskStatus === "not_checked" ? "no_risk" : state.normalizationRiskStatus,
    } satisfies Partial<PersonDiagnosisState>;
  }

  const research = await researchNameIdentity({
    targetName: state.targetDisplayNameJa ?? "",
    candidates: state.normalizationCandidates,
  });

  if (research.verdict === "same") {
    const hasRuleFinding = state.findings.some(
      (finding) => finding.code === "duplicate_normalized_name" && finding.node === "check_person_normalization_risk",
    );
    return {
      findings: [
        ...state.findings,
        ...(hasRuleFinding
          ? []
          : [{
              code: "duplicate_normalized_name",
              title: "duplicate normalized name",
              severity: "high" as const,
              node: "research_name_identity",
              summary: research.summary,
              evidence: {
                targetPersonId: state.targetPersonId,
                targetPersonSlug: state.targetPersonSlug,
                targetDisplayNameJa: state.targetDisplayNameJa,
                candidates: state.normalizationCandidates,
                reason: research.reason,
                sourceMode: research.sourceMode,
              },
            }]),
      ],
      normalizationRiskStatus: "definite",
      nameIdentityResearchVerdict: "same",
      resultNotes: [...state.resultNotes, `姓名身份研究（same）：${research.summary}`],
    } satisfies Partial<PersonDiagnosisState>;
  }

  if (research.verdict === "uncertain") {
    return {
      findings: [
        ...state.findings.filter(
          (finding) => !(finding.code === "duplicate_normalized_name" && finding.node === "check_person_normalization_risk"),
        ),
        {
          code: "name_identity_uncertain",
          title: "name identity uncertain",
          severity: "medium",
          node: "research_name_identity",
          summary: research.summary,
          evidence: {
            targetPersonId: state.targetPersonId,
            targetPersonSlug: state.targetPersonSlug,
            targetDisplayNameJa: state.targetDisplayNameJa,
            candidates: state.normalizationCandidates,
            reason: research.reason,
            sourceMode: research.sourceMode,
          },
        },
      ],
      nameIdentityResearchVerdict: "uncertain",
      resultNotes: [...state.resultNotes, `姓名身份研究：${research.summary}`],
    } satisfies Partial<PersonDiagnosisState>;
  }

  return {
    findings: state.findings.filter(
      (finding) => !(finding.code === "duplicate_normalized_name" && finding.node === "check_person_normalization_risk"),
    ),
    normalizationRiskStatus: "no_risk",
    nameIdentityResearchVerdict: "different",
    resultNotes: [...state.resultNotes, `姓名身份研究（different）：${research.summary}`],
  } satisfies Partial<PersonDiagnosisState>;
}

async function personalBestConsistencyNode(state: PersonDiagnosisState) {
  const result = await auditPersonalBestConsistencyTool({
    personId: state.targetPersonId ?? "",
    personSlug: state.targetPersonSlug ?? "",
  });

  return {
    findings: [...state.findings, ...(result.ok && result.data ? result.data.findings : [])],
  } satisfies Partial<PersonDiagnosisState>;
}

function summarizeFindings(state: PersonDiagnosisState) {
  const issueCount = state.findings.length;
  const highSeverity = state.findings.filter(
    (item: PersonDiagnosisState["findings"][number]) => item.severity === "high" || item.severity === "critical",
  ).length;
  const summary =
    issueCount === 0
      ? "No material issues found."
      : `${issueCount} issues found (${highSeverity} high severity).`;

  const notes = [...state.resultNotes];
  if (issueCount === 0) {
    notes.push("No findings were produced by the current V1 checks.");
  } else {
    notes.push(`Collected ${issueCount} findings across ${state.runtimeNodeHistory.length} nodes.`);
  }

  return {
    resultStatus: "completed",
    resultSummary: summary,
    resultNotes: notes,
  } satisfies Partial<PersonDiagnosisState>;
}

function buildActionPlanNode(state: PersonDiagnosisState) {
  const actionsByCode: Record<string, SuggestedAction> = {
    profile_wikipedia_data_available: {
      code: "backfill_profile_from_wikipedia",
      title: "Backfill profile fields from Wikipedia",
      priority: "medium",
      rationale: "Wikipedia supplied explicit values for one or more currently missing profile fields.",
      relatedIssueCodes: ["profile_wikipedia_data_available"],
    },
    multiple_current_memberships: {
      code: "review_membership_timeline",
      title: "Review concurrent memberships",
      priority: "high",
      rationale: "Multiple current memberships need manual review before any downstream use.",
      relatedIssueCodes: ["multiple_current_memberships"],
    },
    duplicate_normalized_name: {
      code: "review_name_normalization",
      title: "Review normalized name collisions",
      priority: "high",
      rationale: "Duplicate normalized names can indicate merge or split risk.",
      relatedIssueCodes: ["duplicate_normalized_name"],
    },
    duplicate_personal_bests: {
      code: "review_personal_bests",
      title: "Review duplicate PB records",
      priority: "medium",
      rationale: "Duplicate PB rows should be reconciled manually.",
      relatedIssueCodes: ["duplicate_personal_bests"],
    },
    conflicting_personal_best: {
      code: "review_personal_bests",
      title: "Review conflicting PB records",
      priority: "high",
      rationale: "Conflicting PB rows should be reconciled manually.",
      relatedIssueCodes: ["conflicting_personal_best"],
    },
  };

  const actions: SuggestedAction[] = [];
  const seen = new Set<string>();

  for (const issue of state.findings) {
    const action = actionsByCode[issue.code];
    if (!action || seen.has(action.code)) {
      continue;
    }

    seen.add(action.code);
    actions.push(action);
  }

  const nameMergeCandidate = state.nameIdentityResearchVerdict === "same" && state.normalizationCandidates.length === 1
    ? state.normalizationCandidates[0]
    : null;
  const isExactNormalizedNameMatch = nameMergeCandidate
    ? normalizeSearchKey(nameMergeCandidate.displayNameJa) === normalizeSearchKey(state.targetDisplayNameJa ?? "")
    : false;
  const targetIsTemporary = state.targetPersonSlug?.startsWith("person-") ?? false;
  const candidateIsTemporary = nameMergeCandidate?.personSlug.startsWith("person-") ?? false;
  const canChooseCanonical = Boolean(nameMergeCandidate) && targetIsTemporary !== candidateIsTemporary;

  if (nameMergeCandidate && isExactNormalizedNameMatch && canChooseCanonical) {
    const canonical = targetIsTemporary
      ? nameMergeCandidate
      : {
          personId: state.targetPersonId ?? "",
          personSlug: state.targetPersonSlug ?? "",
          displayNameJa: state.targetDisplayNameJa ?? "",
        };
    const duplicate = targetIsTemporary
      ? {
          personId: state.targetPersonId ?? "",
          personSlug: state.targetPersonSlug ?? "",
          displayNameJa: state.targetDisplayNameJa ?? "",
        }
      : nameMergeCandidate;

    const reviewActionIndex = actions.findIndex((action) => action.code === "review_name_normalization");
    if (reviewActionIndex >= 0) {
      actions.splice(reviewActionIndex, 1);
    }

    actions.push({
      code: "merge_person_duplicate",
      title: "Merge confirmed duplicate person",
      priority: "medium",
      rationale: "LLM research confirmed the two records refer to the same person, and the non-temporary slug is selected as canonical.",
      relatedIssueCodes: ["duplicate_normalized_name"],
    });
  }

  const summary =
    actions.length === 0
      ? "No manual follow-up is required from the current checks."
      : `${actions.length} suggested manual actions prepared.`;

  const actionBundleItems: ActionBundleItem[] = actions.map((action, index) => {
    const mergePayload = action.code === "merge_person_duplicate" && nameMergeCandidate && isExactNormalizedNameMatch && canChooseCanonical
      ? {
          canonicalPersonId: targetIsTemporary ? nameMergeCandidate.personId : state.targetPersonId,
          canonicalPersonSlug: targetIsTemporary ? nameMergeCandidate.personSlug : state.targetPersonSlug,
          duplicatePersonId: targetIsTemporary ? state.targetPersonId : nameMergeCandidate.personId,
          duplicatePersonSlug: targetIsTemporary ? state.targetPersonSlug : nameMergeCandidate.personSlug,
          researchSummary: state.findings.find((finding) => finding.node === "research_name_identity")?.summary ?? null,
        }
      : null;
    const mergeKey = mergePayload
      ? [mergePayload.canonicalPersonId, mergePayload.duplicatePersonId].join(":")
      : state.targetPersonId ?? "unresolved";

    return {
      code: action.code,
      title: action.title,
      order: index + 1,
      rationale: action.rationale,
      relatedIssueCodes: action.relatedIssueCodes,
      payload: mergePayload ?? {
        personId: state.targetPersonId,
        personSlug: state.targetPersonSlug,
        findings: state.findings.filter((finding) => action.relatedIssueCodes.includes(finding.code)),
      },
      idempotencyKey: [
        "person",
        mergeKey,
        action.code,
        [...action.relatedIssueCodes].sort().join(",") || "no_issue",
      ].join(":"),
    };
  });

  return {
    actions,
    actionBundle: {
      personId: state.targetPersonId,
      personSlug: state.targetPersonSlug,
      items: actionBundleItems,
    },
    runtimeStatus: "running",
    resultStatus: null,
    resultSummary: state.resultSummary ?? summary,
  } satisfies Partial<PersonDiagnosisState>;
}

function evaluateActionBundleRiskNode(state: PersonDiagnosisState) {
  const bundle = state.actionBundle;
  const items = bundle?.items ?? [];
  const reasons: string[] = [];

  if (state.findings.some((finding) => finding.code === "name_identity_uncertain")) {
    reasons.push("姓名身份研究结果不确定，不能执行归一化写动作。");
  }

  if (state.normalizationRiskStatus === "overflow") {
    reasons.push("归一化候选数量异常，优先排查召回规则或导入问题。");
  }

  if (items.some((item) => item.code === "review_name_normalization")) {
    reasons.push("当前归一化 finding 尚未给出明确的保留记录和删除记录，不能自动合并。");
  }

  if (items.some((item) => item.code === "review_membership_timeline" || item.code === "review_personal_bests")) {
    reasons.push("membership 和 PB 修复规则尚未进入第一批自动写入范围。");
  }

  if (reasons.length > 0) {
    return {
      actionRiskAssessment: {
        level: "high",
        reasons,
        executionStatus: "held",
      },
      runtimeStatus: "completed",
      runtimeEndedAt: new Date().toISOString(),
      resultStatus: "completed",
    } satisfies Partial<PersonDiagnosisState>;
  }

  if (items.length === 0) {
    return {
      actionRiskAssessment: {
        level: "low",
        reasons: ["当前没有需要执行的写动作。"],
        executionStatus: "skipped",
      },
      runtimeStatus: "completed",
      runtimeEndedAt: new Date().toISOString(),
      resultStatus: "completed",
    } satisfies Partial<PersonDiagnosisState>;
  }

  if (items.every((item) => item.code === "merge_person_duplicate")) {
    return {
      actionRiskAssessment: {
        level: "medium",
        reasons: ["姓名身份已由 LLM 研究确认，且 action bundle 已明确保留与合并记录。"],
        executionStatus: "planned",
      },
      runtimeStatus: "completed",
      runtimeEndedAt: new Date().toISOString(),
      resultStatus: "completed",
    } satisfies Partial<PersonDiagnosisState>;
  }

  return {
    actionRiskAssessment: {
      level: "medium",
      reasons: ["动作已结构化，但当前执行器尚未接入此动作类型。"],
      executionStatus: "held",
    },
    runtimeStatus: "completed",
    runtimeEndedAt: new Date().toISOString(),
    resultStatus: "completed",
  } satisfies Partial<PersonDiagnosisState>;
}

export function buildPersonDiagnosisGraph() {
  const logger = createLogger("person-diagnosis-graph");
  const graph = new StateGraph<typeof PersonDiagnosisStateSchema, PersonDiagnosisState, Partial<PersonDiagnosisState>, PersonDiagnosisNode>(
    PersonDiagnosisStateSchema,
  );

  graph.addNode("resolve_person", instrumentNode("resolve_person", resolvePersonNode, logger));
  graph.addNode("clarification", instrumentNode("clarification", clarificationNode, logger));
  graph.addNode("load_person_snapshot", instrumentNode("load_person_snapshot", loadSnapshotNode, logger));
  graph.addNode("check_profile_coverage", instrumentNode("check_profile_coverage", profileCoverageNode, logger));
  graph.addNode("research_profile_wikipedia", instrumentNode("research_profile_wikipedia", researchProfileWikipediaNode, logger));
  graph.addNode("check_membership_timeline", instrumentNode("check_membership_timeline", membershipTimelineNode, logger));
  graph.addNode("check_person_normalization_risk", instrumentNode("check_person_normalization_risk", normalizationRiskNode, logger));
  graph.addNode("research_name_identity", instrumentNode("research_name_identity", researchNameIdentityNode, logger));
  graph.addNode("check_personal_best_consistency", instrumentNode("check_personal_best_consistency", personalBestConsistencyNode, logger));
  graph.addNode("summarize_findings", instrumentNode("summarize_findings", async (state) => summarizeFindings(state), logger));
  graph.addNode("build_action_plan", instrumentNode("build_action_plan", async (state) => buildActionPlanNode(state), logger));
  graph.addNode("evaluate_action_bundle_risk", instrumentNode("evaluate_action_bundle_risk", async (state) => evaluateActionBundleRiskNode(state), logger));

  graph.addEdge(START, "resolve_person");
  graph.addConditionalEdges(
    "resolve_person",
    (state) => {
      if (state.runtimeStatus === "failed") {
        return END;
      }

      if (state.resolutionStatus === "not_found") {
        return END;
      }

      if (state.resolutionStatus === "multiple") {
        return state.clarificationAttempts === 0 && Boolean(state.inputClarification) ? "clarification" : END;
      }

      if (state.resolutionStatus === "unique") {
        return "load_person_snapshot";
      }

      return END;
    },
    ["clarification", "load_person_snapshot", END],
  );
  graph.addConditionalEdges("clarification", (state) => {
    if (state.runtimeStatus === "failed") {
      return END;
    }

    if (state.inputClarification && state.clarificationAttempts > 0) {
      return "resolve_person";
    }

    return END;
  }, ["resolve_person", END]);
  graph.addEdge("load_person_snapshot", "check_profile_coverage");
  graph.addEdge("check_profile_coverage", "research_profile_wikipedia");
  graph.addEdge("research_profile_wikipedia", "check_membership_timeline");
  graph.addEdge("check_membership_timeline", "check_person_normalization_risk");
  graph.addConditionalEdges(
    "check_person_normalization_risk",
    (state) =>
      (state.normalizationRiskStatus === "ambiguous" || state.normalizationRiskStatus === "definite")
      && state.normalizationCandidates.length === 1
        ? "research_name_identity"
        : "check_personal_best_consistency",
    ["research_name_identity", "check_personal_best_consistency"],
  );
  graph.addEdge("research_name_identity", "check_personal_best_consistency");
  graph.addEdge("check_personal_best_consistency", "summarize_findings");
  graph.addEdge("summarize_findings", "build_action_plan");
  graph.addEdge("build_action_plan", "evaluate_action_bundle_risk");
  graph.addEdge("evaluate_action_bundle_risk", END);

  return graph.compile({
    checkpointer: new MemorySaver(),
  });
}

export type PersonDiagnosisGraph = ReturnType<typeof buildPersonDiagnosisGraph>;
