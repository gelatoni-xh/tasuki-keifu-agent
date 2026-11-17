# 组织确认边界优化记录

状态：进行中

这份文档记录 `club`、`company`、`unknown` 组织处理规则的调整过程。它保留问题、决策、实现、数据验证和迁移结果；最终稳定规则再同步回 PRD 和技术方案。

## 1. 背景

赛事来源中的参赛组织名称不一定代表一个需要长期维护的组织。俱乐部、同好会、地方陸協、临时代表名称、企业名称和 OCR/导入污染可能都出现在同一个字段中。过去把这些值直接建成 `Organization`，会产生以下问题：

- 创建大量没有稳定身份边界的组织档案。
- 组织名称的简称、全称和赛事临时写法持续制造重复归一化任务。
- 选手可能因为一次参赛名称被错误建立 `Membership`。
- 组织页、选手页和搜索索引暴露未经确认的实体。
- 组织归一化需要调用轻量或重型模型，但模型也无法可靠判断现实中的组织性质。

## 1.1 工作边界

本轮采用双会话分工：数据治理会话负责逐个分析 `club`、`company`、`unknown`，并直接把有充分证据的记录改为正式组织类型或归并到已有正式组织；本开发会话负责实现规则、页面、导入器、快照字段和后续清理迁移。数据治理会话完成前，本开发会话只做代码和只读审计，不删除组织、不清理 Membership、不解绑 RaceResult，也不执行生产迁移。

生产库盘点（2026-11-14 至 2026-11-16）显示：`club` 220 个组织、1,064 条成绩、481 名选手、44 条 Membership；`company` 13 个组织、42 条成绩、21 名选手、5 条 Membership；`unknown` 22 个组织、32 条成绩、32 名选手、0 条 Membership。

## 2. 决策

组织类型分为“已确认组织”和“未确认参赛名称”两层：

### 已确认组织

- `junior_high_school`、`high_school`、`university`：来源明确证明为学校时使用。
- `corporate_team`：来源明确证明为稳定实业团，或经人工确认其跨届、多人持续代表参赛且业务上接受该组织定义时使用。
- `prefecture_representative`、`student_union_select`、`organizer`：继续按现有赛事语义处理。

已确认组织可以有组织页；学校或实业团 Membership 只有在来源支持时才建立。

### 未确认参赛名称

`club`、`company`、`unknown` 统一视为未确认状态：

- 不作为公开组织页展示。
- 不作为选手 Membership 的依据。
- 不因为名称相似自动升级为学校或实业团。
- 比赛成绩仍保留来源提供的原始参赛名称。
- 后续页面只显示纯文本，不提供组织链接。

“未确认”不代表来源名称错误，也不代表选手没有现实中的所属关系；它只表示当前数据治理没有足够证据建立可维护实体。

## 3. 已执行的数据修正

2026-11-16 已在生产库执行并写入 `AuditLog` 的高确定性转换：

- 9 个明确高中名称从 `unknown` 转为 `high_school`。
- `山形大学` 从 `unknown` 转为 `university`。
- `白大学足利高校` 修正为 `白鴎大学足利高校` 并转为 `high_school`。
- 原错误名称保留为 `NameVariant(type=former)`。
- 本次没有自动创建 Membership。

以下记录暂不强行转换：`土浦日大中等`、`自衛隊体育学校`、地方陸協、大学同好会、国家/地区代表名称、来源字段混入选手姓名的记录，以及没有充分实业团证据的 `company`。

### 2026-11-17 数据会话清理进展

- 对 `club/company/unknown` 现存 49 条 Membership，已逐组织事务删除其中 48 条。
- 每条删除均写入 `AuditLog`，批次为 `unconfirmed-org-membership-cleanup-2026-11-17`；已核验 48/48 条审计记录完整。
- `company` 和 `unknown` 已无 Membership；`club` 仅剩 `土浦日大中等` 1 条，等待学校类型核实。
- RaceResult 外键尚未解除，三类组织的成绩关联计数仍为 `company=42`、`club=1064`、`unknown=12`。
- 由于生产库尚未部署 `RaceResult.organizationNameSnapshot`，组织删除和成绩解绑必须等快照迁移上线后进行。
- `ワークマン` 等重复候选暂不归并，必须先拥有来源名称快照和来源证据。

随后数据会话根据官网来源确认 `土浦日本大学中等教育学校`，将旧 club `土浦日大中等` 的关系转移到已有 `junior_high_school`「土浦日大中等中」，并在同一事务中删除空 club。该操作写入 4 条完整 `AuditLog`；来源映射 metadata 和 `NameVariant` 仍保留原始名称。组织计数为：`company` 13 个组织/42 条成绩，`club` 219 个组织/1,064 条成绩，`unknown` 12 个组织/12 条成绩。

### Membership 恢复修正

此前一次过早清理曾将 48 条 Membership 删除，后已根据原删除 AuditLog 的完整 `oldValue` 在生产库单事务中全部恢复，保留原 ID、关联和字段，并逐条写入恢复 AuditLog；恢复批次为 `restore-premature-unconfirmed-memberships-2026-11-17`，已独立核验 48/48 条数据和 48/48 条审计记录。当前正确计数为：`company=5`、`club=43`、`unknown=0`。`土浦日大中等` 的关系已在正式初中组织下，不属于本次恢复范围。此前“这三类均无 Membership”的结论作废，后续必须先完成分类和迁移映射，再处理 Membership。

当前类型识别仍在继续，必须先完成升级判断再进入清理阶段。最新候选包括：`ワークマン`（company/corporate_team，两边均出现赤井大樹）、`アス・ラボ`（club/corporate_team，两边均出现高橋佑輔）、`team F.O.R`/`teamFOR`（名称近似但选手不同）、`薬王堂IIIFTC`/`薬王堂IIIF`（club/corporate_team）。这些候选不能只按名称或单个选手自动合并；大学同好会也不能直接升级为大学组织。确认前不移动有成绩引用的组织外键。

### 分类盘点结论

分类盘点已完成：生产库剩余 `club=219`、`company=13`、`unknown=12`，没有新增可直接升级为学校或实业团的记录。命中学校关键词的 club 均为大学同好会或陸上同好会；`unknown`「小松大起　獨協大学」属于姓名字段污染，不能直接按组织类型处理。此前删除的 48 条 Membership 已按审计快照恢复，后续必须依据最终组织分类和迁移映射逐条处理。四组跨类型候选仍需独立来源核实；在快照列部署并完成候选决策前，不移动有成绩引用的外键。

### 最终下线迁移（2026-11-17）

在组织分类和合并完成后，主站先部署 `202611170001_add_race_result_organization_snapshot`，再执行批次 `unconfirmed-organization-cleanup-2026-11-17`。事务结果：1,055 条 RaceResult 写入来源名称快照并解除未确认组织外键，48 条 Membership 删除，241 个未确认 Organization 删除；相应 AuditLog 分别为 1,055、48、241 条。迁移后未确认类型组织、Membership、SourceReference、NameVariant 和 TeamCompetitionResult 均无残留，比赛成绩总数保持 34,375。`player-detail` 和 `competition-detail` 缓存版本已刷新。

## 4. 归一化复核结果

### 赛事代表名称不等于 Membership

`三重陸協` 这类地方陸協/代表名称暴露了另一条边界：选手代表某个地区参加一场比赛，不等于该地区是选手的长期所属。若把这种名称当作 Membership 证据，资料越不完整，越容易把正确的人物归一化阻断在 unresolved。自规则版本 `2026-11-17.1` 起，`prefecture_representative`、`student_union_select`、`organizer` 与已下线的 `club/company/unknown` 一样，只保留为成绩来源名称，不创建人物 Membership，也不作为人物候选的所属匹配依据；只有学校或经过确认的实业团等稳定组织，才可用于 Membership。

本次第 333 回第 11 组的 `橋本真宙 / 三重陸協` 按该规则合并到已有同名同读音人物档案。三重陸協没有创建正式 Organization，成绩保留 `organizationNameSnapshot`；未来若出现另一位不同大学的同名橋本真宙，再以新的独立履历冲突进入研究。

第 333 回第 18 组 `中田蒼空 / 学法石川高校` 也验证了同一边界：来源赛事中的正式成绩、年级与学校可用于人物识别；之前的 `平中` 是南砺市立平中学校的历史简称，并非与高中 Membership 冲突。南砺市官方在 2026 年记载该校于当年春闭校并并入五箇山学舎；DB 原组织仅以「平中」作为正式名，故已补全为「南砺市立平中学校」，保留「平中」别名及历史 Membership。2024 年和 2025 年的中学成绩、2026 年学法石川高校一年级成绩与本次成绩构成连续履历，因此本次人物档案合并至既有中田蒼空；来源中的 `ナカタ` 与旧资料 `ナカダ` 差异保留为来源差异，不覆盖既有读音。

对全库组织名称进行了 NFKC、空白/标点、学校后缀、陸協全称等规范化匹配。发现的高优先级重复候选包括：

### 别名字段复核

当前组织归一化已经使用组织别名：数据库上下文会加载 `NameVariant` 和 `shortName`，组织节点对正式名与别名执行 NFKC、空白、学校后缀和字形规范化后的精确匹配；唯一候选可以直接复用，多个候选才进入后续判断。但这不是完整的别名治理：候选预筛选的 SQL 与节点规范化函数不完全一致，`NameVariant` 的 `former/media` 等类型目前也没有不同权重，别名命中没有单独观测指标。因此别名可以减少一部分 LLM 调用，但还不能把所有别名命中视为同等强度的自动确认。后续应统一预筛选和节点规范化函数，区分当前别名与历史别名，并记录 `alias_exact_match`、`short_name_match`、`canonical_name_match` 等命中指标。

| 未确认或旧类型 | 已存在候选 | 处理意见 |
|---|---|---|
| `ワークマン`（company） | `ワークマン`（corporate_team） | 核验来源后迁移成绩，不能只按名称合并 |
| `team F.O.R`（club） | `teamFOR`（corporate_team） | 核验是否同一实业团 |
| `アス・ラボ`（club） | `アス・ラボ`（corporate_team） | 核验来源和 Membership 后处理 |
| `新庄地区陸協`（club） | `新庄地区陸上競技協会`（corporate_team） | 协会全称/简称核验，不能把协会性质误作实业团 |
| `宝塚市陸協`（club） | `宝塚市陸上競技協会`（corporate_team） | 同上 |

同类 club 之间的简称/全称重复（例如 `川崎市陸協` / `川崎市陸上競技協会`）不再优先做组织合并；它们将在纯文本迁移中保留原始名称。

## 5. 目标数据模型

正式组织外键和来源参赛名称必须分离。推荐在 `RaceResult` 增加来源快照字段，例如 `organizationNameSnapshot`：

```text
confirmed school/corporate team:
  organizationId = confirmed organization
  organizationNameSnapshot = source-visible name (optional but preserved)

unconfirmed club/company/unknown:
  organizationId = null
  organizationNameSnapshot = source-visible name
```

迁移必须先写入快照并验证数量，再清理未确认组织的外键、Membership 和公开入口。不能先删除 Organization 再尝试恢复成绩展示。

## 6. Agent 和导入行为

后续规则版本需要：

1. 输入适配器保留 `raceOrganizationName`，并把它与可治理的 `organizationKey` 分开。
2. `club`、`company`、`unknown` 不进入组织创建、组织研究和组织 Membership 推断。
3. 未确认参赛名称仍可参与人物身份的上下文展示，但不能作为“同人”或“不同人”的单独证据。
4. 只有显式来源类型或已确认映射才能建立学校/实业团 Membership。
5. 赛事成绩必须完整写入；组织无法确认不应阻止成绩写入，也不应静默丢掉原始名称。

## 7. 分阶段实施

### 阶段 A：兼容代码

- 增加成绩来源名称快照字段。
- 页面支持“正式组织链接 / 未确认纯文本”双路径。
- 导入器停止为未确认类型创建新 Organization。
- Agent 旁路未确认组织的深度归一化和 Membership 推断。

### 阶段 B：迁移 dry-run

- 读取数据会话确认的升级映射。
- 统计每个组织的成绩、选手、赛事届次、Membership、SourceReference 和 NameVariant。
- 生成每条 RaceResult 的外键变更和名称快照预览。
- 检查是否存在同名正式组织、重复成绩和 Membership 级联风险。

### 阶段 C：生产迁移

- 事务内写入名称快照。
- 先迁移确认的学校/实业团，再清理未确认组织关联。
- 删除或隐藏未确认 Organization 前，确认没有遗漏页面、搜索、PB、团队成绩和来源引用。
- 写入迁移批次 AuditLog，保存变更前后计数。

### 阶段 D：清理旧入口

- 组织列表和筛选移除未确认类型。
- 旧导入 payload 的 `club/company/unknown` 只作为来源名称输入。
- 删除不再使用的组织归一化分支和相关模型提示。
- 更新本地采集 Skill、治理运行手册和测试 fixture。

## 8. 验证清单

- [ ] 未确认参赛名称仍出现在比赛页和选手页。
- [ ] 未确认名称不生成组织链接、组织页、Membership 或搜索索引。
- [ ] 正式学校/实业团仍可链接，已有 Membership 不被误删。
- [ ] DNS、DNF、无成绩行也保留原始参赛名称。
- [ ] 同名 club/company 与正式实业团迁移前有来源依据。
- [ ] 迁移前后 RaceResult、Person、PB、SourceReference 数量有对照。
- [ ] 事务失败时不产生半迁移状态。
- [ ] Agent 在未确认组织场景下不触发不必要的组织 LLM 研究。

本轮代码验证已完成：Agent TypeScript 检查通过，治理规则/研究/归一化测试 28 项通过；主站 TypeScript 检查通过。主站提供只读审计命令 `pnpm maint:audit-unconfirmed-organizations`，输出三类未确认组织的计数、来源快照清理所需字段和同名正式组织候选，不执行删除或解绑。

## 9. 当前未决事项

- `RaceResult` 快照字段的最终命名和是否同步到 `TeamCompetitionResult`。
- `ワークマン`、`team F.O.R`、`アス・ラボ` 等候选是否确实为同一正式实业团。
- `自衛隊体育学校`、`土浦日大中等` 的正式组织类型。
- 未确认 Organization 是物理删除，还是保留内部迁移墓碑但不公开。

