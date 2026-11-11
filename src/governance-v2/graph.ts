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
  normalizeOrganizations,
  normalizePeople,
  verifyFacts,
} from "./agents.js";
import type { Researcher } from "./research.js";

const State = Annotation.Root({
  batchId: Annotation<string>(),
  input: Annotation<BatchInput>(),
  context: Annotation<Context>(),
  mode: Annotation<Manifest["mode"]>(),
  resolution: Annotation<Resolution>(),
  membership: Annotation<AgentResult>(),
  facts: Annotation<AgentResult>(),
  plan: Annotation<Plan>(),
});
export type BatchGraphState = typeof State.State;
export const graphNodeNames = [
  "load_batch_context",
  "normalize_organization",
  "normalize_person",
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
  // Subgraphs share the parent's persistent checkpointer and namespace automatically.
  const orgGraph = new StateGraph(State)
    .addNode(
      "org_resolve_identity",
      node("org_resolve_identity", async (s) => ({
        resolution: await normalizeOrganizations(
          s.batchId,
          s.input,
          s.context,
          deps.research,
        ),
      })),
    )
    .addEdge(START, "org_resolve_identity")
    .addEdge("org_resolve_identity", END)
    .compile({ name: "organization_normalization_graph" });
  const personGraph = new StateGraph(State)
    .addNode(
      "person_resolve_identity",
      node("person_resolve_identity", async (s) => ({
        resolution: await normalizePeople(
          s.batchId,
          s.input,
          s.context,
          s.resolution,
          deps.research,
        ),
      })),
    )
    .addEdge(START, "person_resolve_identity")
    .addEdge("person_resolve_identity", END)
    .compile({ name: "person_normalization_graph" });
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
      })),
    )
    .addNode("normalize_organization", orgGraph)
    .addNode("normalize_person", personGraph)
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
    .addEdge("load_batch_context", "normalize_organization")
    .addEdge("normalize_organization", "normalize_person")
    .addConditionalEdges("normalize_person", route_membership_agent, [
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
