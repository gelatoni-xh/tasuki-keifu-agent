import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";

import { createLogger } from "../lib/logger.js";
import {
  auditMembershipTimelineTool,
  auditPersonNormalizationRiskTool,
  auditPersonalBestConsistencyTool,
  auditProfileCoverageTool,
  checkRelationCacheTool,
  loadPersonSnapshotTool,
  resolvePersonTool,
} from "../tools/person-tools.js";
import { recordAgentEvent, recordCheckpoint } from "../db/repositories.js";
import type { SuggestedAction } from "../types/diagnosis.js";
import { PersonDiagnosisStateSchema, type PersonDiagnosisState } from "../state/person-diagnosis.js";

type PersonDiagnosisNode =
  | "resolve_person"
  | "clarification"
  | "load_person_snapshot"
  | "check_profile_coverage"
  | "check_membership_timeline"
  | "check_person_normalization_risk"
  | "check_personal_best_consistency"
  | "check_relation_cache_status"
  | "summarize_findings"
  | "build_action_plan";

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

async function relationCacheNode(state: PersonDiagnosisState) {
  const result = await checkRelationCacheTool({
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
    profile_coverage_missing_fields: {
      code: "backfill_profile_fields",
      title: "Backfill missing profile fields",
      priority: "medium",
      rationale: "Profile coverage gaps should be reviewed and completed from trusted sources.",
      relatedIssueCodes: ["profile_coverage_missing_fields"],
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
    relation_cache_missing: {
      code: "rebuild_relation_cache",
      title: "Rebuild relation cache",
      priority: "low",
      rationale: "Derived relation cache is missing and should be regenerated by the normal maintenance path.",
      relatedIssueCodes: ["relation_cache_missing"],
    },
    relation_cache_stale: {
      code: "refresh_relation_cache",
      title: "Refresh relation cache",
      priority: "low",
      rationale: "Derived relation cache is stale relative to the underlying person data.",
      relatedIssueCodes: ["relation_cache_stale"],
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

  const summary =
    actions.length === 0
      ? "No manual follow-up is required from the current checks."
      : `${actions.length} suggested manual actions prepared.`;

  return {
    actions,
    runtimeStatus: "completed",
    runtimeEndedAt: new Date().toISOString(),
    resultStatus: "completed",
    resultSummary: state.resultSummary ?? summary,
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
  graph.addNode("check_membership_timeline", instrumentNode("check_membership_timeline", membershipTimelineNode, logger));
  graph.addNode("check_person_normalization_risk", instrumentNode("check_person_normalization_risk", normalizationRiskNode, logger));
  graph.addNode("check_personal_best_consistency", instrumentNode("check_personal_best_consistency", personalBestConsistencyNode, logger));
  graph.addNode("check_relation_cache_status", instrumentNode("check_relation_cache_status", relationCacheNode, logger));
  graph.addNode("summarize_findings", instrumentNode("summarize_findings", async (state) => summarizeFindings(state), logger));
  graph.addNode("build_action_plan", instrumentNode("build_action_plan", async (state) => buildActionPlanNode(state), logger));

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
  graph.addEdge("check_profile_coverage", "check_membership_timeline");
  graph.addEdge("check_membership_timeline", "check_person_normalization_risk");
  graph.addEdge("check_person_normalization_risk", "check_personal_best_consistency");
  graph.addEdge("check_personal_best_consistency", "check_relation_cache_status");
  graph.addEdge("check_relation_cache_status", "summarize_findings");
  graph.addEdge("summarize_findings", "build_action_plan");
  graph.addEdge("build_action_plan", END);

  return graph.compile({
    checkpointer: new MemorySaver(),
  });
}

export type PersonDiagnosisGraph = ReturnType<typeof buildPersonDiagnosisGraph>;
