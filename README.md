# tasuki-keifu-agent

[![中文](https://img.shields.io/badge/阅读中文-README.md-1677ff?style=flat-square)](README.md) [![English](https://img.shields.io/badge/Read%20English-README.en.md-555?style=flat-square)](README.en.md) [![日本語](https://img.shields.io/badge/日本語で読む-README.ja.md-555?style=flat-square)](README.ja.md)

`tasuki-keifu-agent` 是 `tasuki-keifu` 的内部数据治理服务。当前主流程以赛事和区/组为单位运行：先导入已存在的赛事数据，再逐批治理选手、组织、Membership、成绩与 PB。生产入口是 `src/governance-v2/cli.ts` 的 event governance runner；旧的个人诊断和批处理 CLI 仍保留作兼容用途，不是新赛事导入流程。

## 治理流程

1. 赛事、赛事届次、Race 和 Source 必须先在主站业务库中建立。本服务不会创建赛事壳或调用旧赛事导入写入函数。
2. 每个任务包含一个或多个显式批次。每个批次指定 `unitType`（`leg`、`heat` 或 `group`）、`unitKey`、`sequence`、`raceSlug` 和来源数据。
3. 规则先处理可解释的标准化与确定性匹配。剩余身份疑难进入整批轻量归一化，再进入有预算限制的研究；交叉校验检查组织与选手判断是否相互矛盾。若独立组织证据修正了组织映射，只对受影响选手重评一次，不形成循环。
4. 每批在赛事任务内按顺序运行。严重 unresolved 会保留在治理记录并触发告警，不会自动改写为确定身份；普通 unresolved 不阻断有效行处理。
5. `dry_run` 生成计划和报告，不写业务表。确认计划后，使用新的 `requestKey` 提交 `apply` 任务；apply 通过独立的只读/写入数据库连接和受控事务执行。

完整字段、输入契约、恢复行为、部署要求和回退说明见 [`docs/governance-v2.md`](docs/governance-v2.md)。

## 观测与通知

任务、批次、Agent 执行、模型调用、治理变更和 unresolved 证据记录在主站数据库的 `governance` schema。观测数据包括队列等待、运行和重试耗时，模型/调用次数、输入与输出 tokens、网络查询、估算成本，以及 resolved/unresolved 和计划变更结果。费用仅在配置模型价格时可估算。

邮件由独立 worker 从持久通知队列发送。赛事总结主题带赛事名；告警主题带赛事名和区/组标识。发送失败会重试，稳定 Message-ID 用于识别重复通知。

## 本地开发

```bash
pnpm install
pnpm typecheck
pnpm test:governance
GOVERNANCE_MAIN_REPO=/path/to/tasuki-keifu bash scripts/test-governance-integration.sh
```

集成脚本会启动一次性本机 PostgreSQL、应用主站完整迁移，再运行集成测试；不会连接生产数据库。需要本机安装 PostgreSQL 工具（`initdb`、`pg_ctl`、`createdb`）。

运行治理 CLI 前，设置：

- `GOVERNANCE_DATABASE_URL`：主站业务数据库中含 `governance` schema 的 runtime 连接。
- `GOVERNANCE_READ_DATABASE_URL`：只读连接；apply 模式必须配置独立连接。
- `GOVERNANCE_PAYLOAD_DIR`：持久化原始批次 payload 的绝对路径。
- `GOVERNANCE_WRITE_ENABLED`：默认关闭；仅在已审核计划后启用 apply 写入。
- `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`GOVERNANCE_RESEARCH_MODEL`：可选的显式研究模型配置。未配置时规则流程仍可执行，需研究的严重疑难会保持 unresolved。
- `GOVERNANCE_RESEARCH_REQUESTS`、`GOVERNANCE_RESEARCH_TIMEOUT_MS`：单批研究请求预算和超时。
- `GOVERNANCE_MAIL_ENABLED`、`MAIL_CONFIG`：邮件 worker 的显式开关与 SMTP/Resend 配置。

真实环境配置请参考 [`deploy/governance-v2.env.example`](deploy/governance-v2.env.example)。不要提交凭据或复制生产连接字符串到开发环境。

## 赛事任务命令

```bash
node --import tsx src/governance-v2/cli.ts adapt eventspec.json > manifest.json
node --import tsx src/governance-v2/cli.ts submit manifest.json
node --import tsx src/governance-v2/cli.ts run TASK_UUID
node --import tsx src/governance-v2/cli.ts status TASK_UUID
node --import tsx src/governance-v2/cli.ts worker
node --import tsx src/governance-v2/cli.ts retry TASK_UUID
```

`adapt` 将既有 `RaceImportPayload` 转成受校验的 manifest，不执行写入。先用 `dry_run` 检查计划和报告。只有在计划经过审核、数据库和写入开关已正确配置后，才提交 `apply`。失败任务必须先检查原因，再显式 `retry`；同一个赛事任务中的后续批次会在前序批次失败时停止。

邮件服务运维命令：

```bash
node --import tsx src/governance-v2/cli.ts health
node --import tsx src/governance-v2/cli.ts deliver
node --import tsx src/governance-v2/cli.ts mail-worker
```

部署顺序、checkpoint 初始化、数据库权限、Compose 资源限制与回退流程见治理运行手册。生产任务应由赛事负责人逐组安排和观测；不要把本地 CLI 或 README 示例当作授权去运行真实赛事。
