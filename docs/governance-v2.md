# 赛事驱动数据治理运行手册

组织确认边界和本次优化过程记录见 [`optimization-organization-confidence.md`](./optimization-organization-confidence.md)。组织类型升级由数据治理会话依据来源证据直接执行；本服务只负责后续未确认数据的下线迁移和运行规则。数据治理会话完成前不得执行清理迁移。本手册只保留稳定运行规则；候选组织、迁移对照和未决问题不在这里展开。

新入口 `src/governance-v2/cli.ts` 独立于旧诊断/批处理流程。主站拥有业务库与 governance migration；本服务拥有新流程唯一受控事务写入器。不导入兄弟仓库模块，不调用旧 importRacePayload。旧命令和运行数据没有迁移要求。

## 环境与上线顺序

1. 在主站审核并执行 `202611110001_event_governance` 迁移。主站 Prisma Client 重新生成。
2. 初始化 `governance_checkpoint`：使用有 schema 建立权限的临时管理连接运行 `setup-checkpoints`。
3. 管理员执行主站 `prisma/grants/governance-v2.sql`，配置 runtime/business_reader/site_reader 三角色。运行服务不需要 DDL 权限；不要授予 UserFeedback。
4. 配置本仓 `deploy/governance-v2.env.example`。`GOVERNANCE_DATABASE_URL` 必须是主站业务库，不能是旧 Agent 专库。`GOVERNANCE_READ_DATABASE_URL` 必须连接同一库的业务只读角色，apply 时必须配置。
5. `GOVERNANCE_PAYLOAD_DIR` 为持久绝对目录，worker/submit 必须访问同一存储。Compose 已挂载命名卷；容器临时文件系统不合适。DB 位于现有外部网络，设置 TASUKI_NETWORK；镜像由本仓 Dockerfile 构建，GOVERNANCE_IMAGE 指向该版本。
6. 模型显式设置 GOVERNANCE_RESEARCH_MODEL 和 OPENAI_API_KEY；provider 需支持 Responses、structured outputs 和 web_search。未配置时规则仍可运行，严重研究事项成为 unresolved。没有读取 Codex 本地账户/密钥的逻辑。
7. apply 额外设置 `GOVERNANCE_WRITE_ENABLED=true`；邮件另设 `GOVERNANCE_MAIL_ENABLED=true`。邮件配置复用 `gelatoni-xh` 的 `MAIL_CONFIG` JSON，支持 `smtp` 和 `resend`，不要把凭据提交到仓库。先 dry_run 再对明确区组试点。

配置示例不含真实凭据，环境文件不得提交。命令示例用 `node --import tsx src/governance-v2/cli.ts`，也可用 `pnpm governance:event`。

## 输入示例

赛事、区组对应的 Race、CompetitionEdition 与 Source 必须已存在；本入口治理选手/组织/履历/资料及成绩，不自动创建赛事结构。

```json
{
  "version": "event-governance/1",
  "requestKey": "event-2024-pilot-dry-v1",
  "eventEditionId": "existing-edition-id",
  "mode": "dry_run",
  "batches": [
    {
      "unitType": "leg",
      "unitKey": "1",
      "sequence": 0,
      "sourceId": "existing-source-id",
      "raceSlug": "existing-leg-1-race",
      "organizations": [
        { "key": "u", "name": "大学正式名", "type": "university" }
      ],
      "rows": [
        {
          "key": "source-row-1",
          "sourceKey": "stable-athlete-id-if-known",
          "name": "選手氏名",
          "organizationKey": "u",
          "grade": 1,
          "memberships": [{ "organizationKey": "u", "type": "enrolled" }],
          "pbs": [{ "discipline": "m10000", "mark": "28:30.00" }]
        }
      ]
    }
  ]
}
```

unitType 支持 leg/heat/group；sequence 非负且任务内唯一，按数字排序。多区/组添加 batches，各批显式给自己的 raceSlug/来源/行键；不猜数组顺序。sourceKey 只有来源确实提供稳定人物 ID 时才填，不能将姓名或跨赛事不稳定行号冒充人物 ID。缺失时生成来源赛事观察映射，仍可利用姓名/学校等证据归一。

组织 key、行 key 任务批内分别唯一，所属引用必须在该批 organizations 里。结构损坏直接报错，不静默丢行。业务疑难允许未知日期、空 PB、未知组织类型；unresolved 不阻断有效输入导入。`club`、`company`、`unknown` 只表示未确认的来源参赛名称，不自动创建公开 Organization 或 Membership；`prefecture_representative`、`student_union_select`、`organizer` 也只表示本场赛事的代表/赛事语义，不能单独创建人物 Membership。成绩必须保留来源名称，正式学校/实业团才进入组织归一化。已撤回的第 103 回箱根预选数据仍不允许导入。

Membership 可填 grade、startDate/endDate、endState。日期格式 YYYY-MM-DD；endState 默认为 unknown，不凭缺失结束日期当作 ongoing。普通职业团体/俱乐部不默认互斥；有明确业务依据时提供 exclusivityGroup=employment/team_registration。

### 人物显示名契约

人物输入 `rows[].name` 是来源显示名。进入人物归一化和 writer 后，含汉字的日文/中文姓名统一移除姓名中间空格；片假名、拉丁字母及其他非汉字姓名先折叠空白为一个半角空格并保留分隔。`displayNameJaSearch` 仍使用无空白的检索键。此规则只规范显示格式，不代表同名人物应合并；身份归并必须另有来源证据。

## 既有 payload 适配

建立 eventspec.json：

```json
{
  "version": "event-governance/1",
  "requestKey": "event-adapt-dry-v1",
  "eventEditionId": "existing-edition-id",
  "mode": "dry_run",
  "batches": [
    {
      "unitType": "leg",
      "unitKey": "1",
      "sequence": 0,
      "payloadFile": "leg-1.json"
    }
  ]
}
```

payloadFile 相对 eventspec 文件。适配旧 RaceImportPayload，原始对象一并保存在该批 gzip；不会调用旧写入函数。

```bash
node --import tsx src/governance-v2/cli.ts adapt eventspec.json > manifest.json
node --import tsx src/governance-v2/cli.ts submit manifest.json
node --import tsx src/governance-v2/cli.ts run TASK_UUID
node --import tsx src/governance-v2/cli.ts status TASK_UUID
```

相同 requestKey + 相同输入返回同任务；相同键不同输入拒绝。dry_run 改 apply 需新 requestKey，不篡改已提交任务。dry_run 不写业务数据，后批看到的仍是数据库现状，不能把 dry_run 当作顺序提交模拟器。

## 持续执行、恢复与通知

```bash
node --import tsx src/governance-v2/cli.ts worker
node --import tsx src/governance-v2/cli.ts work-once
node --import tsx src/governance-v2/cli.ts retry TASK_UUID
node --import tsx src/governance-v2/cli.ts run TASK_UUID
node --import tsx src/governance-v2/cli.ts deliver
node --import tsx src/governance-v2/cli.ts mail-worker
node --import tsx src/governance-v2/cli.ts cleanup-checkpoints
```

worker 通过数据库租约领取任务，赛事内严格串行。有限技术重试耗尽后任务失败、后续区组不执行；排查并 retry 后从未完成处恢复。已完成区组不再写入，提交后崩溃只补收尾。leaseToken fencing 阻止过时 worker 提交。输入文件损坏须修复持久存储里的原对象，不能绕过 hash 校验。

研究默认每批最多 3 次、单次 25 秒，重启保留额度；超时/预算不足/资料不足为 unresolved。普通缺所属、模糊 PB 不联网。规则版本 2026-11-11.1；后续修复应更新版本和 fixture。

严重 unresolved 或技术失败才排队批次告警，赛事所有终态排队总结；邮件中写导入条数、修复操作数、计划修复数与自然语言 unresolved。dry_run 实际修复数是 0。汇报由模板生成，不为统计调用 LLM。SMTP 失败持久重试，Message-ID 稳定，但不保证提供方端到端恰好一次。

赛事汇总同时返回运行指标：从任务创建到终态的总耗时、首次 attempt 前的排队等待、attempt/重试次数和耗时、Agent 累计执行耗时、规则判断数、LLM/网络调用、总 tokens/估算费用、模型级调用与 tokens、resolved/unresolved 数，以及每导入行/计划行成本。attempt 耗时允许因并行 Agent 大于赛事墙钟耗时；cost per imported row 在 dry_run 或零导入时为空，避免制造误导数字。上述指标来自现有 task/batch/attempt/execution/finding 记录，不代表已完成站点图表或真实模型成本校准。

Compose：`docker compose --env-file .env.governance -f deploy/governance-v2.compose.yml up -d`；启用独立邮件 worker 加 `--profile mail`。env_file 路径相对 deploy 目录，文件应放 `deploy/.env.governance`，CLI 的 --env-file 同样传该路径。运行前只执行一次 setup-checkpoints，不能让 runtime 临时获得建表权限。

checkpoint 默认只清理完成 7 天后的成功/过时 attempt；失败任务恢复点保留。原始输入、审计和通知不自动清理，上线前明确保留/备份策略。

## 验证

```bash
pnpm typecheck
pnpm test:governance
bash scripts/test-governance-integration.sh
```

最后一项要求本机 initdb/pg_ctl/createdb、主站依赖已安装，默认兄弟目录 tasuki-keifu，可用 GOVERNANCE_MAIN_REPO 改测试位置。脚本创建 Unix socket 的一次性 PostgreSQL，部署主站完整 migration 链，再执行集成测试并销毁；不会使用 .env 中生产连接。单独运行集成测试必须显式给本地 \*\_test 数据库 URL。

测试覆盖规则、研究契约、两批顺序、事务回滚、恢复、合并拆分、PB、通知重试。真实模型/web_search 与真实赛事尚未验证；fixture 通过不代表真实研究效果已达标。

## 回退与审计

停止 worker/邮件 worker 即停止新任务，不自动撤销已提交业务数据。应用回退保留 additive schema，不能直接 drop governance 或新 Membership 字段。已发生业务修复依据 GovernanceChange.businessAuditRef 和 AuditLog 审阅，必要时执行单独补偿任务；合并/拆分原档案与关联迁移摘要保存在审计中，不提供未经审阅的“一键回滚”。

本地实现没有迁移旧 Agent 历史数据，没有生产执行，也没有发送真实邮件。
