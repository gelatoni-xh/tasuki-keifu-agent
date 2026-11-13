# 赛事驱动数据治理运行手册

新入口 `src/governance-v2/cli.ts` 独立于旧诊断/批处理流程。主站拥有业务库与 governance migration；本服务拥有新流程唯一受控事务写入器。不导入兄弟仓库模块，不调用旧 importRacePayload。旧 Agent 数据库和运行记录不迁入新版；数据库保留供只读历史案例参考，旧 Agent 服务由新版 worker 替换。

## 环境与上线顺序

1. 在主站审核并执行 `202611110001_event_governance` 迁移。主站 Prisma Client 重新生成。
2. 管理员创建 schema 并设置 owner：`CREATE SCHEMA governance_checkpoint AUTHORIZATION governance_runtime;`。用 runtime 连接运行 `setup-checkpoints`，然后执行主站 grant 脚本；运行容器不保留 DDL 权限，不能授予 superuser。
3. 配置 Agent 运行目录 `/opt/apps/tasuki-keifu-agent/.env.governance`，参考 `deploy/governance-v2.env.example`。两个 DB URL 均须指向主站数据库、分别使用 runtime 与 business_reader 角色，不能连旧 Agent 专用数据库。apply 要求分离连接。
4. worker 使用与主站共享的外部 Docker network 和命名 payload volume，内存限额 256 MiB、Node heap 上限 160 MiB。使用 Agent deploy workflow 更新 image/compose；先执行 `setup-checkpoints`，再启 worker。workflow 等待容器 healthcheck 通过，失败时恢复上一版 compose/image。正常部署移除旧 Agent API container，旧 Agent 数据库仍保留。
5. 规则执行不依赖 LLM。模型显式设置 GOVERNANCE_RESEARCH_MODEL 和 OPENAI_API_KEY；provider 需支持 Responses、structured outputs 和 web_search。未配置时规则仍可运行，严重研究事项成为 unresolved。初始远端部署 `GOVERNANCE_WRITE_ENABLED=false`、`GOVERNANCE_MAIL_ENABLED=false`，不消费待写任务、不发邮件；试点前经 dry_run 验证后再启用。

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

组织 key、行 key 任务批内分别唯一，所属引用必须在该批 organizations 里。结构损坏直接报错，不静默丢行。业务疑难允许未知日期、空 PB、未知组织类型；unresolved 不阻断有效输入导入。已撤回的第 103 回箱根预选数据仍不允许导入。

Membership 可填 grade、startDate/endDate、endState。日期格式 YYYY-MM-DD；endState 默认为 unknown，不凭缺失结束日期当作 ongoing。普通职业团体/俱乐部不默认互斥；有明确业务依据时提供 exclusivityGroup=employment/team_registration。

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

研究默认每批最多 3 次，轻量/交叉/组织裁决共享独立的 5 次预算，重启保留额度。单次超时由 GOVERNANCE_RESEARCH_TIMEOUT_MS 配置（代码默认 25 秒，当前部署使用 120 秒）。预算不足、未配置和资料不足保留 unresolved；API 超时、HTTP/响应结构错误属于技术失败，进入有限重试。普通缺所属、模糊 PB 不联网。规则版本 2026-11-13.2；归一化策略 whole-group-cross-check/5。

严重 unresolved 或技术失败才排队批次告警，赛事所有终态排队总结；邮件中写导入条数、修复操作数、计划修复数与自然语言 unresolved。dry_run 实际修复数是 0。汇报由模板生成，不为统计调用 LLM。SMTP 失败持久重试，Message-ID 稳定，但不保证提供方端到端恰好一次。

远端部署复用 `docker-compose.prod.yml`；`deploy/governance-v2.env.example` 是环境变量模板，实际 `.env.governance` 不入库。邮件 worker 保留 `mail` profile，初次部署不启用。单机 Compose worker 有 256 MiB 容器内存上限；如果复杂真实任务触发 OOM，应停止后重新评估容量/批大小，不要直接移除 host memory safeguards。

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

## 下游依赖与观测修复（2026-11-13）

当前来源行的 DNS（notes 或 mark）不进入选手轻量/深度研究，不据此推断 Membership 或更新人物事实；能够由安全规则确认的映射仍保留，否则保留独立来源档案与成绩状态。历史 DNS 仍可作为身份线索，不代表实际出场。

组织轻量/追加裁决仍未确认时，挂起该组织所有关联选手的暂定匹配，不能仅因组织 ID 未变化而跳过失效处理。未确认的依赖不进入选手追加复核或重型研究；确认后只复核受影响选手一次。交叉校验保留相关证据，移除其他组织/人物的已知无关引用；未知引用、越界目标仍是阻碍项。引用相关性检查是实体范围校验，不是对模型推理正确性的保证。

Membership 的 API/解析失败传播为技术失败；同一回答中的日期修正先整体校验，含越界、无效时间或未消除冲突时不部分应用。人物事实节点跳过未确认身份。

观测保留规则命中、各阶段 input/resolved/remaining、DNS 跳过行及受影响/复核人数。未填写或无效单价为未知，显式 0 才表示免费单价；重试日志合并不能把未知成本变成已知。费用仍只估算配置的 token 单价，不包含未配置的搜索服务费用。

## 单组织网络核验（2026-11-13）

DAG 顺序为：组织规则 → 组织整组轻量 → 选手规则 → 选手整组轻量 → 全组交叉校验 → 组织追加裁决 → **单组织网络核验** → 受影响选手一次复核 → 选手深度研究 → Membership / 人物事实。没有回边。

组织轻量 unresolved 或组织问题追加裁决未解决时进入网络核验，候选只有一个也可进入；没有疑问的新组织不为补齐资料自动搜索。每次请求仅包含一个来源组织、候选、赛事日期和问题摘要，不附带全库合并足迹或暂定人物匹配。复用已有模型路由、持久请求日志和每批研究预算（默认 3 次），与后续选手/Membership 重型研究共享；按输入组织顺序处理，预算耗尽的对象保留 unresolved。

只接受 match / distinct / unresolved；match 限于候选 ID。确认结论必须包含实际 web_search_call 和响应中可追溯 URL、非空引文；不能自动合并、拆分或推断履历。工具返回 URL 只能验证来源可追溯，不保证引文事实正确。模型未执行搜索或没有可引用来源时保留 unresolved，API/响应故障仍作为阻碍项。

organizationResearch 逐对象记录候选数、进入原因及结果，normalizationStages 记录核验人数与解决数。阶段计数含预算拒绝的尝试，实际物理请求/搜索次数以 researchCalls/llmCalls/networkCalls 为准。本次只完成模拟响应与隔离数据库验证，未调用线上模型、未重跑赛事；中转服务是否真正支持该模型的 web_search 仍待下一次受控试跑观测。

### 交叉校验来源键与首组 apply（2026-11-13）

交叉校验输出的 `personKeys` 必须是当前输入的 `rows[].key`，不能是候选人物 ID 或 `gov_` 暂定人物 ID。请求的结构化输出 schema 按本批行键、组织键和证据键生成枚举；返回后再次按同一范围校验。跨组织问题拆为各组织的问题，不放宽业务校验或人工替代判断。候选集合是宽松召回，暂定来源档案、没有 catalog 匹配及 DNS 独立档案本身不构成身份矛盾。

首组 apply 的交叉请求曾成功返回但耗时 112.7 秒，接近生产 120 秒限制；生产单次请求超时调整为 240 秒，现有归一化预算 5、研究预算 3 及 attempt 上限 3 保持。正式导入仍提交新的 `mode=apply` 任务，不将 dry-run 历史直接改为已写入。常驻 worker 保持禁止写入；授权的首组通过一次性 write-enabled runner 执行，结束恢复常驻 worker。
