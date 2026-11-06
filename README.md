# tasuki-keifu-agent

[![中文](https://img.shields.io/badge/阅读中文-README.md-1677ff?style=flat-square)](README.md) [![English](https://img.shields.io/badge/Read%20English-README.en.md-555?style=flat-square)](README.en.md) [![日本語](https://img.shields.io/badge/日本語で読む-README.ja.md-555?style=flat-square)](README.ja.md)

基于 LangGraph 的内部数据诊断 Agent，用于 `tasuki-keifu`。

V1 范围：

- 选手诊断图（`person diagnosis graph`）
- 只读访问主业务数据库 `tasuki_keifu`
- 将运行数据写入独立的 `tasuki_keifu_agent` 数据库
- 输出结构化发现和建议的人工操作
- 提供治理批处理，每位选手的操作包均有审计记录
- 通过标准 `LANGCHAIN_*` 环境变量接入 LangSmith 追踪
- 可选使用 GPT-5.4 对存在歧义的姓名归一化候选进行身份研究
- 直接调用 Wikipedia MediaWiki API 核对档案，支持标准 HTTP 代理设置和 macOS 系统代理

## 本地配置

```bash
pnpm install
pnpm prisma:generate
cp .env.example .env
```

设置以下环境变量：

- `TASUKI_KEIFU_BUSINESS_DATABASE_URL`
- `TASUKI_KEIFU_BUSINESS_WRITE_DATABASE_URL`：仅在启用业务写入时设置
- `TASUKI_KEIFU_AGENT_DATABASE_URL`
- `LANGSMITH_API_KEY`
- `LANGSMITH_WORKSPACE_ID`
- `LANGSMITH_TRACING=true`
- `LANGSMITH_PROJECT=tasuki-keifu-agent-v1`
- 可选 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `OPENAI_MODEL`；省略时使用本地 Codex 配置
- 可选 `HTTPS_PROXY` 或 `HTTP_PROXY`，用于 Wikipedia API；macOS 下未设置时会回退到系统代理

## 运行

```bash
pnpm diagnose -- --person-slug example-person
pnpm diagnose -- --person-id cmxxxx
pnpm diagnose -- --person-name "選手名"
npm run inspect -- --limit 5
npm run inspect -- --person-slug example-person
```

## 冒烟检查

```bash
npm run smoke:diagnosis
npm run smoke:tools
npm run smoke:nodes
```

当前覆盖：

- `smoke:diagnosis`：使用真实样例验证诊断图的端到端输出
- `smoke:tools`：直接检查核心诊断工具的发现结果
- `smoke:nodes`：回归关键解析分支的图节点路径，包括真实歧义姓名经由 `research_name_identity` 的处理路径
- `inspect`：查看近期 Agent 运行与诊断结果

当前版本会在 Agent 数据库中记录诊断结果、操作包、风险挂起与批处理审计数据。已注册的业务写入操作仅在满足下述显式写入保护条件时可用。

## 治理批处理

```bash
npm run governance:batch -- --limit 20
npm run governance:batch -- --limit 20 --execute
```

批处理会比较 `Person` / `Membership` / `PersonalBest` 的最新更新时间与该选手最近一次已结束的治理运行。因风险而挂起的结果也视为已结束，避免对没有变化的案例反复执行。

- 默认使用试运行（dry-run）模式。
- 即使传入 `--execute`，也只有同时设置 `TASUKI_AGENT_WRITE_ENABLED=true` 和 `TASUKI_KEIFU_BUSINESS_WRITE_DATABASE_URL` 才会执行业务写入。
- `merge_person_duplicate`：合并一对由 LLM 确认、归一化姓名相同且具有明确非临时规范 slug 的选手。执行器在同一事务中锁定双方、迁移关联记录、保留姓名变体、清理关系缓存、写入业务 `AuditLog`，最后删除重复记录。
- `backfill_profile_from_wikipedia`：仅从精确匹配的 Wikipedia 页面补齐缺失档案字段。
- `upsert_personal_bests_from_wikipedia`：写入 Wikipedia 明确列出的 PB；同一项目已有多条记录时，保留既有的分阶段 PB。
- `mark_memberships_conflicting` 和 `mark_personal_bests_conflicting`：将内部不一致的记录标记为 `conflicting`，不删除记录，也不猜测替代事实。
- 高风险选手会被挂起，不影响批次中的其他选手。
