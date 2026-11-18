# 治理 v2 可观测性路线图与工作记录

> 本文件跟踪治理 v2 的可观测性建设。LangSmith 是执行轨迹工具之一，不是这个事项的全部。后续讨论、决策、验证结果和未解决问题继续更新这里；部署状态以验证记录和工作清单为准。

## 要解决的问题

用户需要从一次赛事治理任务出发，回答四类问题：

1. **现在发生了什么？** 任务、批次和 attempt 处于什么状态，卡在哪个节点，是否在等待、重试或失败。
2. **为什么得到这个结果？** 哪些规则和研究阶段参与了判断，哪些问题仍未解决，计划与实际业务变更分别是什么，有什么可审阅的依据。
3. **花费与效果如何？** 物理模型请求、模型重试、Responses 内部 web search、token、耗时、估算费用和最终治理结果分别是多少；统计口径能否互相核对。
4. **事后如何复盘？** 某次运行对应哪个代码、Graph 和策略版本，能否找到当时的执行路径、checkpoint 与业务审计；同类任务迭代后能否比较。

可观测性不能改变治理决策、租约、checkpoint 或业务事务。观测服务失效时治理仍应运行；反过来，观测数据丢失必须能被发现，不能被误读为“没有发生调用”。

## 系统边界与数据来源

| 层 | 当前主要记录 | 用途与限制 |
| --- | --- | --- |
| Agent 的 `governance` 数据库 | `EventImportTask`、`GovernanceBatch`、`BatchAttempt`、`AgentExecution`、`GovernanceFinding`、`GovernanceChange`、`NotificationDelivery` | 任务状态、计划、结果和审计的持久来源。`BatchAttempt.metrics` 记录当前节点与失败尝试的模型 journal；`AgentExecution.metrics` 记录阶段和调用指标。 |
| Agent 的 `governance_checkpoint` | LangGraph checkpoint/thread | 恢复执行所需的状态快照，包含业务上下文；不是公开观测 API，也不是永久版本档案。 |
| 个人站 `tasuki-keifu` 的 `/observability` | 通过只读连接查询治理表，并展示任务、批次、Agent 指标、问题、变更与通知 | 面向人查看业务结果；当前不查询 LangSmith，也没有 LangSmith trace 链接。页面读取最近 20 个任务、每任务最多 300 个批次及若干明细上限。 |
| LangSmith 云端 | batch attempt、原生 LangGraph 执行轨迹、节点与物理模型请求 run | 用于检查执行时间线、输入输出、状态流转和请求层指标；开启后会保存治理输入、上下文、计划与研究结果。 |
| 通知邮件 | 任务汇总、失败告警和部分观测汇总 | 主动告知异常；不替代可检索的任务记录和逐步 trace。 |

数据库保留业务事实和审计，LangSmith 展示执行轨迹，站点提供任务入口和业务视图。未来是否进一步联动，需要单独设计关联标识、权限和展示方式。

## Studio Graph 结构视图

`langgraph.json` 注册 `governance_v2_structure`，加载 `src/governance-v2/studio-graph.ts`。它直接复用生产的 `buildBatchGraph()`，因此节点、边和子图随代码更新；适配器不连接业务数据库、不提供真实研究器或 checkpoint，并在任何节点执行前报错。Studio 只用于浏览结构，不是治理任务入口。生产治理仍由持有数据库租约的 `EventRunner` 发起。Tracing 项目中的运行树与 Studio 的完整 Graph 结构是两种不同视图；前者不会自动注册 Agent Server。

2026-11-18 本地验证：Graph 导出包含 18 个节点、20 条边；LangGraph CLI 1.8.0 的开发 Agent Server 注册了 `governance_v2_structure`，`/ok`、`/assistants/search` 和 `/assistants/governance_v2_structure/graph` 均返回预期结果。类型检查与 62 项治理单测通过。这只验证结构加载，不代表生产 Agent Server 已部署。

用户选择在自有 Ubuntu-3 上部署独立 Agent Server，连接 LangSmith Studio。正式自建服务需要 `LANGGRAPH_CLOUD_LICENSE_KEY`、LangSmith API key、独立的 PostgreSQL 数据库和 Redis；还需限制 Studio 入口的访问权限，并将服务构建和发布并入现有主分支部署。当前主机约 2 GiB 内存，检查时可用约 794 MiB；现有治理环境未配置许可、Redis 或 Agent Server 数据库。满足这些条件并完成容量验证前，不应将开发模式 `langgraph dev` 作为生产常驻服务，也不应把 Studio 执行入口接到现有 worker 或业务数据库。生产 Studio URL 和部署 Revision 待实际发布后记录。

## 当前已实现的 LangSmith 接入

当前独立工作区的 v2 CLI 在 `run`、`work-once`、`worker` 命令中，开启 `GOVERNANCE_LANGSMITH_TRACING=true` 后，每个 batch attempt 建立根 run；Graph 节点与实际 Responses API 请求作为子 run。`membership_only` 绕过 Graph，仍记录 attempt 和研究请求。研究内部重试按实际物理请求分别计数；web search 是 Responses 内部工具调用，不是独立 LangGraph 节点。

根据用户决定，v2 不做业务内容脱敏。开启开关时，runner 给 LangGraph 显式注入原生 LangSmith tracer；原生 trace 可记录 Graph 输入、节点状态与输出。手工 attempt run 记录批次输入和最终计划，研究 run 记录请求上下文与结果及物理请求计数。API key 仍只用于认证，不作为 trace 字段。原生 Graph trace 和手工 attempt trace 当前是两组记录，通过 task/batch/attempt 标识关联；节点仅由原生 Graph trace 记录。物理请求 run 目前保存研究层请求与最终结果，尚未逐次保存 Responses 的原始 wire prompt/response。

LangSmith 客户端使用 1 秒超时，传输层在失败时立即停止 SDK 的重复尝试。手工发送异常只记一条本地警告，不抛入治理路径；结束时最多等待 1.5 秒冲刷，因此异常退出或持续网络故障仍可能丢失 trace。CLI 关闭环境变量触发的默认 Graph tracer，避免另起一个使用默认长超时的客户端；未开启 v2 tracing 时也不会自动上报。原生 tracer 在服务不可用时仍会输出 SDK 警告，后续可再收敛日志。

配置：项目名默认 `tasuki-keifu-agent-v2`，可由 `GOVERNANCE_LANGSMITH_PROJECT` 覆盖；可设置 `LANGSMITH_WORKSPACE_ID`、`LANGSMITH_ENDPOINT`。密钥优先读 `LANGSMITH_API_KEY`，否则读本机 `~/.codex/secrets/langsmith_api_key`。密钥不得进入仓库、文档或站点。这个 v2 开关独立于 v1 的 `LANGSMITH_TRACING`。

**验证记录（2026-11-18）**：PR #43 合并为 `f1ff4ee`，GitHub Actions `44276382639` 成功部署到 Ubuntu-3。worker 健康且 0 次重启；容器内 v2 tracing 开关、项目、workspace 与密钥配置均已生效。部署前后任务状态计数一致：completed 12、completed_with_unresolved 24、failed 8，没有 queued/running。生产镜像执行了不连接业务数据库的合成 Graph，LangSmith 云端 `tasuki-keifu-agent-v2` 项目可查到原生节点输入输出与 attempt 的完整输入、计划，根 run ID 为 `8698816b-2a1d-41d4-9e6a-6123f9044199`。没有启动或重试真实治理任务；真实任务端到端轨迹仍待下一次业务运行核验。部署前类型检查和 62 项治理单测通过；不可访问端点测试中 Graph 仍返回预期结果，进程约 1.5 秒内结束。历史运行不会自动补录 LangSmith。

## 观测契约待确定

后续迭代先统一口径，再扩充图表或告警。以下是需要讨论和验证的契约，不代表已经实现：

| 问题 | 建议口径 / 待决策点 |
| --- | --- |
| 运行标识 | 用 `taskId → batchId → attemptId → graphThreadId` 关联数据库和 trace；是否在数据库保存 LangSmith 根 run ID，以便站点直接跳转。 |
| 调用次数 | `llmCalls` 指实际模型 HTTP 请求；内部重试分别计入。`networkCalls` 指 Responses 返回的 `web_search_call` 项数；不能把“允许联网的请求”直接算作搜索次数。 |
| 时间 | 分开排队等待、attempt 总耗时、节点耗时、模型请求耗时和重试耗时；明确并行或包含关系，避免直接相加。 |
| 成本 | token 价格未配置或使用量未返回时应显示未知；估算费用不等于账单费用，搜索费用是否可得需核实。 |
| 结果 | 区分 `dry_run` 计划、`apply` 已提交业务变更、resolved/unresolved、失败与部分完成；不能用模型调用成功代替治理成功。 |
| 缺失与投递 | 区分零次调用、未启用 tracing、云端发送失败和 trace 尚未可见；是否需要本地投递成功率或丢失计数。 |
| 数据边界 | 用户决定 LangSmith 可保存完整治理业务内容；站点和邮件仍维持各自现有的访问控制。API key、数据库凭据等认证材料不能进入 trace。 |
| 版本与快照 | 记录代码提交、Graph/策略版本、模型配置与运行 ID 的关系；checkpoint 是恢复状态，不等于长期保留的版本快照。 |

## 工作清单

状态只描述当前事实：`已部署` 包含生产镜像的合成验证，`待验证` 需真实治理运行，`待讨论` 尚未定方案。

| 优先级 | 工作 | 状态 | 验收关注点 |
| --- | --- | --- | --- |
| P0 | v2 完整 Graph 与研究 tracing | 已部署（合成验证通过） | Graph 输入输出、节点流转与研究请求可查；观测故障不影响治理。 |
| P0 | 真实 v2 任务端到端核验 | 待验证 | 同一 task 的 attempt、节点、模型重试和搜索计数与数据库指标一致，失败及恢复路径可辨。 |
| P1 | Studio Graph 结构视图 | 代码已验证，生产待部署 | 自建 Agent Server 可供 Studio 读取完整拓扑；Studio 运行不触发治理；需许可、独立存储、访问控制及容量验证。 |
| P1 | 统一任务关联与跳转 | 待讨论 | 从站点任务或批次能定位相应 LangSmith trace；无 trace 时显示明确原因，不泄漏密钥。 |
| P1 | 指标口径和数据质量检查 | 待讨论 | 站点、报告、数据库、LangSmith 的调用数/耗时/费用差异有解释；失败尝试不会漏计或重计。 |
| P1 | 观测页的信息结构和异常定位 | 待讨论 | 能快速从失败任务定位到 attempt、当前节点、失败类别、重试及未解决问题；移动端可读。 |
| P2 | 版本、策略与运行快照关联 | 待讨论 | 某次运行能找到当时代码/Graph/策略标识；明确保留期及 checkpoint 与审计的边界。 |
| P2 | 告警、趋势和对比 | 待讨论 | 在有实际运行样本后选择有效阈值，比较模型成本、未解决率、失败率和阶段耗时。 |
| P2 | 评估与反馈闭环 | 待讨论 | 有可复查的样本集和人工判断时，再评估 LangSmith dataset/evaluation 等能力是否适合本项目。 |

## 当前限制和开放问题

- LangSmith 只记录本次代码部署后的新运行；旧治理记录不会凭空出现当时的 Graph 路径。历史汇总是否需要迁移，先确认用途和可重建程度。
- 目前未把 LangSmith 根 run ID 写入数据库。仅凭共享的 task/batch/attempt ID 可搜索定位，但站点无法提供稳定直达链接。
- 原生 Graph trace 与手工 attempt trace 尚未合为一棵树；后续应确定统一关联方式，避免在 LangSmith 统计中混淆两种 run。
- 真实模型请求是否总能返回 token 和 web search 用量，仍需在受控运行中核验；云端合成 trace 不能验证这一点。
- trace 发送采用限时异步冲刷，暂没有持久队列、投递成功指标或自动补传机制。是否值得增加，取决于实际丢失风险和个人项目成本。
- 站点观测页在另一个仓库 `tasuki-keifu`，后续页面改动应在那里实施；Agent 仓库只负责产生可关联的运行数据。

## 讨论与决策记录

| 日期 | 结论 / 待续 | 依据 |
| --- | --- | --- |
| 2026-11-18 | 可观测性是长期事项，LangSmith 接入只是起点。本文件作为后续讨论的持续记录。 | 用户明确希望覆盖整个观测需求，而非仅记录工具配置。 |
| 2026-11-18 | 用户明确不需要治理业务内容脱敏；v2 改为上传完整 Graph 与研究上下文。 | 完整的执行与决策复盘优先于先前的摘要式接入。 |
| 2026-11-18 | 合成 trace 的云端接收已确认；真实治理任务与站点联动仍待验证和设计。 | 云端根 run 与子 run 可查，尚未运行真实任务或修改站点。 |
| 2026-11-18 | v2 LangSmith 代码和服务器配置已部署；真实任务追踪留待下一次治理运行验证。 | main 部署工作流成功，worker 健康，生产镜像的合成 Graph trace 可在云端查询。 |
