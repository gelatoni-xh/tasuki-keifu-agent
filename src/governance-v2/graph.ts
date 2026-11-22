// 修改节点、连线或路由时，主动提醒用户核对主站观测页的三语 Graph 图例。
// 阶段性改动可暂缓同步；先确认计划发布的流程版本，再更新公开图并核对实际 diff。
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
  prepareMembershipContext, deduplicateMemberships, resolveMembershipRules,
  inferMembershipTimeline, collectMembershipConflicts,
  researchMembershipConflicts, validateMembershipDecisions, finalizeMemberships,
  type MembershipWork,
  verifyFacts,
} from "./agents.js";
import { isMembershipOrganizationType } from "./rules.js";
import { initialNormalization, projectNormalization, lightBatch, crossCheck,
  validateCrossCheck, finalizeNormalization, adjudicate, researchOrganizations, reassess, deepResearch, type NormalizationState } from "./normalization.js";
import type { Researcher } from "./research.js";

const State = Annotation.Root({
  batchId: Annotation<string>(),
  input: Annotation<BatchInput>(),
  context: Annotation<Context>(),
  mode: Annotation<Manifest["mode"]>(),
  resolution: Annotation<Resolution>(),
  normalization: Annotation<NormalizationState>(),
  membership: Annotation<AgentResult>(),
  membershipWork: Annotation<MembershipWork>(),
  facts: Annotation<AgentResult>(),
  plan: Annotation<Plan>(),
});
// 图状态只描述一个 batch 的治理过程；任务租约、审计和业务事务由 runner/database/writer 负责。
export type BatchGraphState = typeof State.State;
export const graphNodeNames = [
  "load_batch_context",
  "organization_rules", "organization_light_batch", "person_rules", "person_light_batch",
  "prepare_cross_check", "normalization_cross_check", "validate_cross_check", "organization_adjudication",
  "organization_network_research", "affected_person_reassessment", "normalization_deep_research", "finalize_normalization",
  "govern_membership",
  "prepare_membership_context", "membership_deduplication", "membership_rules",
  "membership_timeline", "collect_membership_conflicts",
  "membership_deep_research", "validate_membership_decisions", "finalize_membership",
  "verify_person_facts",
  "compare_person_facts", "collect_person_fact_conflicts", "validate_person_fact_decisions",
  "aggregate_governance_result",
] as const;
export function route_membership_agent(
  s: BatchGraphState,
): "govern_membership" | "verify_person_facts" | "aggregate_governance_result" {
  return s.input.rows.some((r) => r.memberships.length ||
    (r.organizationKey && isMembershipOrganizationType(
      s.input.organizations.find(o => o.key === r.organizationKey)?.type,
    ))) ||
    s.context.memberships.some((m) =>
      Object.values(s.resolution.personMap).includes(m.personId),
    )
    ? "govern_membership"
    : route_person_facts_agent(s);
}
export function route_person_facts_agent(
  s: BatchGraphState,
): "verify_person_facts" | "aggregate_governance_result" {
  return s.input.rows.some((r) => r.birthDate || r.hometown || r.registeredPrefecture || r.pbs.length)
    ? "verify_person_facts"
    : "aggregate_governance_result";
}
export function buildMembershipGraph(deps: {
  research: Researcher;
  checkpointer?: BaseCheckpointSaver;
  onNode?: (name: string) => Promise<void>;
  failAfter?: string;
}) {
  const node = <T>(name: string, fn: (s: BatchGraphState) => T | Promise<T>) => async (s: BatchGraphState) => {
    await deps.onNode?.(name);
    const result = await fn(s);
    if (deps.failAfter === name) throw new Error(`Injected interruption at ${name}`);
    return result;
  };
  return new StateGraph(State)
    .addNode("prepare_membership_context", node("prepare_membership_context", s => ({
      membershipWork: prepareMembershipContext(s.input, s.context, s.resolution),
    })))
    .addNode("membership_deduplication", node("membership_deduplication", s => ({
      membershipWork: deduplicateMemberships(s.batchId, s.membershipWork),
    })))
    .addNode("membership_rules", node("membership_rules", s => ({
      membershipWork: resolveMembershipRules(s.batchId, s.input, s.context, s.resolution, s.membershipWork),
    })))
    .addNode("membership_timeline", node("membership_timeline", s => ({
      membershipWork: inferMembershipTimeline(s.membershipWork, s.context),
    })))
    .addNode("collect_membership_conflicts", node("collect_membership_conflicts", s => ({
      membershipWork: collectMembershipConflicts(s.membershipWork),
    })))
    .addNode("membership_deep_research", node("membership_deep_research", async s => ({
      membershipWork: await researchMembershipConflicts(s.input, s.context, s.resolution, s.membershipWork, deps.research),
    })))
    .addNode("validate_membership_decisions", node("validate_membership_decisions", s => ({
      membershipWork: validateMembershipDecisions(s.membershipWork),
    })))
    .addNode("finalize_membership", node("finalize_membership", s => ({
      membership: finalizeMemberships(s.batchId, s.context, s.membershipWork),
    })))
    .addEdge(START, "prepare_membership_context")
    .addEdge("prepare_membership_context", "membership_deduplication")
    .addEdge("membership_deduplication", "membership_rules")
    .addEdge("membership_rules", "membership_timeline")
    .addEdge("membership_timeline", "collect_membership_conflicts")
    .addConditionalEdges("collect_membership_conflicts", s => s.membershipWork.groups.length
      ? "membership_deep_research" : "finalize_membership", ["membership_deep_research", "finalize_membership"])
    .addEdge("membership_deep_research", "validate_membership_decisions")
    .addEdge("validate_membership_decisions", "finalize_membership")
    .addEdge("finalize_membership", END)
    .compile({ name: "membership_governance_graph", checkpointer: deps.checkpointer });
}
export function buildBatchGraph(deps: {
  loadContext: () => Promise<Context>;
  research: Researcher;
  checkpointer?: BaseCheckpointSaver;
  onNode?: (name: string) => Promise<void>;
  failAfter?: string;
}) {
  // 统一包装节点，保证进度记录和测试中断都发生在同一入口。
  const node =
    <T>(name: string, fn: (state: BatchGraphState) => Promise<T> | T) =>
    async (state: BatchGraphState) => {
      await deps.onNode?.(name);
      const value = await fn(state);
      if (deps.failAfter === name)
        throw new Error(`Injected interruption at ${name}`);
      return value;
    };
  const membershipGraph = buildMembershipGraph({ ...deps, checkpointer: undefined });
  const factsGraph = buildPersonFactsGraph(deps);
  // 个人事实图保持轻量：规则先筛选 PB/事实候选，冲突研究节点后续只接收
  // 明确的事实冲突，不复制归一化图的多层实体研究。
  const skipped = (agentKey: string): AgentResult => ({
    agentKey,
    skipped: true,
    findings: [],
    changes: [],
    metrics: emptyMetrics(),
  });
  // 归一化先于履历和事实治理，后续判断使用的是已投影的实体映射。
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
    .addNode("organization_network_research", node("organization_network_research", async s => {
      const metrics = structuredClone(s.resolution.metrics), base = { ...s.resolution, metrics };
      const normalization = await researchOrganizations(s.input, s.context, s.normalization, base, deps.research);
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
    .addEdge("organization_adjudication", "organization_network_research")
    .addEdge("organization_network_research", "affected_person_reassessment")
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

export function buildPersonFactsGraph(deps: {
  onNode?: (name: string) => Promise<void>;
  failAfter?: string;
}) {
  const node = <T>(name: string, fn: (state: BatchGraphState) => T | Promise<T>) => async (state: BatchGraphState) => {
    await deps.onNode?.(name);
    const value = await fn(state);
    if (deps.failAfter === name) throw new Error(`Injected interruption at ${name}`);
    return value;
  };
  return new StateGraph(State)
    .addNode("compare_person_facts", node("compare_person_facts", s => ({
      facts: verifyFacts(s.batchId, s.input, s.context, s.resolution),
    })))
    .addNode("collect_person_fact_conflicts", node("collect_person_fact_conflicts", s => ({ facts: s.facts })))
    .addNode("validate_person_fact_decisions", node("validate_person_fact_decisions", s => ({ facts: s.facts })))
    .addEdge(START, "compare_person_facts")
    .addEdge("compare_person_facts", "collect_person_fact_conflicts")
    .addEdge("collect_person_fact_conflicts", "validate_person_fact_decisions")
    .addEdge("validate_person_fact_decisions", END)
    .compile({ name: "person_facts_graph" });
}
