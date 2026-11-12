import {
  Annotation,
  END,
  START,
  StateGraph,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import {
  emptyMetrics,
  type AgentResult,
  type BatchInput,
  type Context,
  type Manifest,
  type Plan,
  type Resolution,
} from "./contracts.js";
import {
  buildPlan,
  governMemberships,
  verifyFacts,
} from "./agents.js";
import { initialNormalization, projectNormalization, lightBatch, crossCheck,
  validateCrossCheck, finalizeNormalization, adjudicate, reassess, deepResearch, type NormalizationState } from "./normalization.js";
import type { Researcher } from "./research.js";

const State = Annotation.Root({
  batchId: Annotation<string>(),
  input: Annotation<BatchInput>(),
  context: Annotation<Context>(),
  mode: Annotation<Manifest["mode"]>(),
  resolution: Annotation<Resolution>(),
  normalization: Annotation<NormalizationState>(),
  membership: Annotation<AgentResult>(),
  facts: Annotation<AgentResult>(),
  plan: Annotation<Plan>(),
});
export type BatchGraphState = typeof State.State;
export const graphNodeNames = [
  "load_batch_context",
  "organization_rules", "organization_light_batch", "person_rules", "person_light_batch",
  "prepare_cross_check", "normalization_cross_check", "validate_cross_check", "organization_adjudication",
  "affected_person_reassessment", "normalization_deep_research", "finalize_normalization",
  "govern_membership",
  "verify_person_facts",
  "aggregate_governance_result",
] as const;
export function route_membership_agent(
  s: BatchGraphState,
): "govern_membership" | "verify_person_facts" | "aggregate_governance_result" {
  return s.input.rows.some((r) => r.memberships.length) ||
    s.context.memberships.some((m) =>
      Object.values(s.resolution.personMap).includes(m.personId),
    )
    ? "govern_membership"
    : route_person_facts_agent(s);
}
export function route_person_facts_agent(
  s: BatchGraphState,
): "verify_person_facts" | "aggregate_governance_result" {
  return s.input.rows.some((r) => r.hometown || r.pbs.length)
    ? "verify_person_facts"
    : "aggregate_governance_result";
}
export function buildBatchGraph(deps: {
  loadContext: () => Promise<Context>;
  research: Researcher;
  checkpointer?: BaseCheckpointSaver;
  onNode?: (name: string) => Promise<void>;
  failAfter?: string;
}) {
  const node =
    <T>(name: string, fn: (state: BatchGraphState) => Promise<T> | T) =>
    async (state: BatchGraphState) => {
      await deps.onNode?.(name);
      const value = await fn(state);
      if (deps.failAfter === name)
        throw new Error(`Injected interruption at ${name}`);
      return value;
    };
  const membershipGraph = new StateGraph(State)
    .addNode(
      "resolve_membership_rules_and_conflicts",
      node("resolve_membership_rules_and_conflicts", async (s) => ({
        membership: await governMemberships(
          s.batchId,
          s.input,
          s.context,
          s.resolution,
          deps.research,
        ),
      })),
    )
    .addEdge(START, "resolve_membership_rules_and_conflicts")
    .addEdge("resolve_membership_rules_and_conflicts", END)
    .compile({ name: "membership_governance_graph" });
  const factsGraph = new StateGraph(State)
    .addNode(
      "compare_person_facts",
      node("compare_person_facts", (s) => ({
        facts: verifyFacts(s.batchId, s.input, s.context, s.resolution),
      })),
    )
    .addEdge(START, "compare_person_facts")
    .addEdge("compare_person_facts", END)
    .compile({ name: "person_facts_graph" });
  const skipped = (agentKey: string): AgentResult => ({
    agentKey,
    skipped: true,
    findings: [],
    changes: [],
    metrics: emptyMetrics(),
  });
  return new StateGraph(State)
    .addNode(
      "load_batch_context",
      node("load_batch_context", async () => ({
        context: await deps.loadContext(),
        membership: skipped("membership"),
        facts: skipped("person_facts"),
        normalization: initialNormalization(),
      })),
    )
    .addNode("organization_rules", node("organization_rules", async s => {
      const normalization = structuredClone(s.normalization), metrics = emptyMetrics();
      const resolution = await projectNormalization(s.batchId, s.input, s.context, normalization, metrics, false);
      metrics.ruleDecisions += s.input.organizations.length;
      return { normalization, resolution };
    }))
    .addNode("organization_light_batch", node("organization_light_batch", async s => {
      const metrics = structuredClone(s.resolution.metrics), base = { ...s.resolution, metrics };
      const normalization = await lightBatch("organization", s.normalization, base, s.context, deps.research);
      return { normalization, resolution: await projectNormalization(s.batchId, s.input, s.context, normalization, metrics, false) };
    }))
    .addNode("person_rules", node("person_resolve_identity", async s => {
      const normalization = structuredClone(s.normalization), metrics = structuredClone(s.resolution.metrics);
      const resolution = await projectNormalization(s.batchId, s.input, s.context, normalization, metrics, true);
      metrics.ruleDecisions += s.input.rows.length;
      return { normalization, resolution };
    }))
    .addNode("person_light_batch", node("person_light_batch", async s => {
      const metrics = structuredClone(s.resolution.metrics), base = { ...s.resolution, metrics };
      const normalization = await lightBatch("person", s.normalization, base, s.context, deps.research);
      return { normalization, resolution: await projectNormalization(s.batchId, s.input, s.context, normalization, metrics, true) };
    }))
    .addNode("prepare_cross_check", node("prepare_cross_check", s => ({ normalization: structuredClone(s.normalization) })))
    .addNode("normalization_cross_check", node("normalization_cross_check", async s => {
      const resolution = structuredClone(s.resolution);
      return { resolution, normalization: await crossCheck(s.input, s.context, s.normalization, resolution, deps.research) };
    }))
    .addNode("validate_cross_check", node("validate_cross_check", s => ({ normalization: validateCrossCheck(s.input, s.normalization, s.context) })))
    .addNode("organization_adjudication", node("organization_adjudication", async s => {
      const metrics = structuredClone(s.resolution.metrics), base = { ...s.resolution, metrics };
      const normalization = await adjudicate(s.input, s.context, s.normalization, base, deps.research);
      return { normalization, resolution: await projectNormalization(s.batchId, s.input, s.context, normalization, metrics, true) };
    }))
    .addNode("affected_person_reassessment", node("affected_person_reassessment", async s => {
      const metrics = structuredClone(s.resolution.metrics), base = { ...s.resolution, metrics };
      const normalization = await reassess(s.input, s.context, s.normalization, base, deps.research);
      return { normalization, resolution: await projectNormalization(s.batchId, s.input, s.context, normalization, metrics, true) };
    }))
    .addNode("normalization_deep_research", node("normalization_deep_research", async s => {
      const metrics = structuredClone(s.resolution.metrics), base = { ...s.resolution, metrics };
      const normalization = await deepResearch(s.normalization, base, deps.research);
      return { normalization, resolution: await projectNormalization(s.batchId, s.input, s.context, normalization, metrics, true) };
    }))
    .addNode("finalize_normalization", node("finalize_normalization", s => ({ resolution: finalizeNormalization(s.input, s.normalization, s.resolution) })))
    .addNode("govern_membership", membershipGraph)
    .addNode("verify_person_facts", factsGraph)
    .addNode(
      "aggregate_governance_result",
      node("aggregate_governance_result", (s) => ({
        plan: buildPlan(
          s.batchId,
          s.input,
          s.context,
          s.resolution,
          s.membership,
          s.facts,
          s.mode,
        ),
      })),
    )
    .addEdge(START, "load_batch_context")
    .addEdge("load_batch_context", "organization_rules")
    .addEdge("organization_rules", "organization_light_batch")
    .addEdge("organization_light_batch", "person_rules")
    .addEdge("person_rules", "person_light_batch")
    .addEdge("person_light_batch", "prepare_cross_check")
    .addEdge("prepare_cross_check", "normalization_cross_check")
    .addEdge("normalization_cross_check", "validate_cross_check")
    .addEdge("validate_cross_check", "organization_adjudication")
    .addEdge("organization_adjudication", "affected_person_reassessment")
    .addEdge("affected_person_reassessment", "normalization_deep_research")
    .addEdge("normalization_deep_research", "finalize_normalization")
    .addConditionalEdges("finalize_normalization", route_membership_agent, [
      "govern_membership",
      "verify_person_facts",
      "aggregate_governance_result",
    ])
    .addConditionalEdges("govern_membership", route_person_facts_agent, [
      "verify_person_facts",
      "aggregate_governance_result",
    ])
    .addEdge("verify_person_facts", "aggregate_governance_result")
    .addEdge("aggregate_governance_result", END)
    .compile({
      name: "governance_batch_graph",
      checkpointer: deps.checkpointer,
    });
}
