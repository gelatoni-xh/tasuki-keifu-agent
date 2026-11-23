# Governance payload 模板

这里的文件是**示例模板**，不是可直接导入的生产数据。任何字段名、字段类型、Graph 开关或嵌套结构的变更，都必须先与开发者反复确认，再同步更新模板、校验和主站说明。

提交前必须使用当前 `manifestSchema` 校验；未知字段会被拒绝。`sourcePayload` 只保存原始材料，不能替代结构化字段。`agentMode` 可选：`full`、`membership_only`、`person_facts_only`。学校经历统一放在 `rows[].memberships`，通过组织类型和关系类型表达大学、高中、中学等信息；不要新增专用字段。`hometown` 与 `registeredPrefecture` 是独立事实，禁止互相推断。

登录陆协治理规则（不改变 payload 字段结构）：`registeredPrefecture` 接受 47 都道府县的全称或简称，Agent 强制存储不带都／府／県的简称，保留 `北海道`、`学連`。其他标签输出 unresolved，不自动猜测。可靠度至少 3，按该批次 `raceSlug` 对应赛事的日本日期比较资料新旧；禁止以提交、访问或档案更新时间代替。倒序导入时旧值正常跳过；同值的新资料也推进证据日期。缺少赛事日期、既有不同值无日期、同日不同值或同批同人不同值均输出 unresolved。

日期证据存入既有 `SourceReference.metadata.registeredAssociation = {value, asOf, dateBasis: "race_date_jst"}`，`asOf` 为 `YYYY-MM-DD`。已有数据库全量备份会保留该 metadata，不新增 payload 字段。资料不属于所指定赛事日期的情况不得借用该批次提交；如需新的资料日期字段，必须先与开发者反复确认契约变更。
