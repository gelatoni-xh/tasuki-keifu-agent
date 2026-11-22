# Governance payload 模板

这里的文件是**示例模板**，不是可直接导入的生产数据。任何字段名、字段类型、Graph 开关或嵌套结构的变更，都必须先与开发者反复确认，再同步更新模板、校验和主站说明。

提交前必须使用当前 `manifestSchema` 校验；未知字段会被拒绝。`sourcePayload` 只保存原始材料，不能替代结构化字段。`agentMode` 可选：`full`、`membership_only`、`person_facts_only`。学校经历统一放在 `rows[].memberships`，通过组织类型和关系类型表达大学、高中、中学等信息；不要新增专用字段。`hometown` 与 `registeredPrefecture` 是独立事实，禁止互相推断。
