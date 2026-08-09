# Agent-04 — Medication Safety 深度执行指导

## 0. 需求目标

Stage03 S3.2 要求：

```text
medication safety rule engine
```

Source13 已有完整 Prescription/Medical Order 基础，但没有正式药物安全规则引擎。

你必须在现有处方工作流上增加：

```text
deterministic
explainable
versioned
auditable
```

的安全检查。

---

# 1. Source13 调研锚点

必须阅读：

```text
supabase/migrations/20260806000016_catalog.sql
20260806000019_clinical.sql
20260808000028_compliance_base.sql
api/routes/clinical.ts
apps/maoxianqiu/src/views/clinical/encounter/detail.vue
apps/maoxianqiu/src/views/clinical/workbench/index.vue
apps/maoxianqiu/src/types/clinical.ts
```

现有：

```text
prescriptions
prescription_items
medical_orders
nurse_tasks
save_prescription
dispense_prescription
```

处方已包含：

```text
drug_name
catalog_item_id
dosage
frequency
duration_days
quantity
unit
instructions
```

宠物已有：

```text
species
breed
birth_date
weight
risk_tags
medical_notes
```

这些是安全规则计算的现有输入。

---

# 2. 非目标

本阶段不是医学知识库项目。

禁止声称：

```text
覆盖所有兽医禁忌
AI 可以自动诊断
AI 自动拒绝处方
规则替代兽医判断
```

V1 只实现**医院可配置 + 系统基础规则框架**。

---

# 3. Ownership

```text
api/routes/medication-safety.ts
api/services/medication-safety/**
apps/.../types/medication-safety.ts
apps/.../api/modules/medication-safety.ts
apps/.../views/clinical/medication-safety/**
supabase/migrations/*210-*219*
supabase/tests/medication_safety*
```

定点接入：

```text
api/routes/clinical.ts
encounter/detail.vue
```

如果同 main 冲突，尽量由 Agent-09 做最终 hook。

---

# 4. 规则数据模型

建议：

## medication_safety_rules

```text
id
tenant_id nullable?（system rule 可 null，若项目不接受 system row 可 seed 每 tenant）
code
name
rule_type
severity
is_blocking
species[]
active
current_version
created_at
updated_at
```

Rule Type：

```text
duplicate_ingredient
duplicate_drug
dose_range
duration_limit
frequency_limit
species_contraindication
age_constraint
weight_constraint
antimicrobial_notice
drug_interaction
```

## medication_safety_rule_versions

```text
rule_id
version
condition jsonb
message
recommendation
effective_from
effective_to
created_by
created_at
```

历史处方必须能追溯当时使用的 Rule Version。

---

# 5. 药物规范化

当前 `prescription_items.drug_name` 是自由文本，同时有可选：

```text
catalog_item_id
```

规则匹配优先：

```text
catalog_item_id
```

如果只靠 drug_name 字符串：

```text
容易别名/大小写/商品名误判
```

建议扩展 Catalog 的药品 metadata：

```text
active_ingredient
strength
strength_unit
route
antimicrobial_class
```

但不要破坏非药品 Catalog。

可使用：

```text
catalog item metadata jsonb
```

或单独 `drug_profiles`。

更推荐单独表：

```text
drug_profiles
catalog_item_id unique
active_ingredient
strength
...
```

---

# 6. 检查结果模型

```text
medication_safety_checks
```

每次保存/签发前记录：

```text
tenant_id
store_id
prescription_id
encounter_id
pet_id
check_stage
rule_id
rule_version
severity
blocking
message_snapshot
context_snapshot
status triggered/overridden/resolved
created_at
```

`context_snapshot` 不要存整个病历，只存必要计算输入。

---

# 7. Override

```text
medication_safety_overrides
```

必须：

```text
check_id
override_by
reason
created_at
```

Blocking Rule：

```text
没有 medication_safety.override
→ 不能继续
```

有权限也必须：

```text
reason required
```

Audit：

```text
medication_safety.override
```

---

# 8. 工作流接入点

Source13 Prescription 流程：

```text
save prescription
→ issue
→ dispense
```

安全检查至少两个阶段：

### Save/Draft

可以提示：

```text
warning
```

不一定阻塞医生录草稿。

### Issue / Finalize

必须重新跑：

```text
最新处方项目
最新宠物体重/年龄
规则版本
```

Blocking 未处理：

```text
拒绝 issue
```

### Dispense

对关键规则可做快速重检：

```text
处方是否已通过安全检查
是否发生 amendment
```

不要在发药时重新创造完全不同的规则结果。

---

# 9. 规则示例

## Duplicate Drug

同一 prescription：

```text
catalog_item_id 重复
```

或同 ingredient 重复。

## Dose Range

若 Drug Profile 有：

```text
mg/kg min/max
```

且宠物有最近体重：

```text
计算 dose
```

没有结构化 dosage 时：

```text
不能假装精确解析
```

应提示：

```text
无法自动校验剂量
```

而不是默认 PASS。

## Duration

```text
duration_days > tenant rule max
```

## Antimicrobial

首版可为：

```text
warning
reason required
```

不要默认 Blocking，除非 Tenant Policy 指定。

---

# 10. Tenant Policy

Stage03 已明确：

```text
部分质控可由 tenant policy/local regulation/SOP 升级为强制
```

因此 Rule 应支持：

```text
Tenant override system defaults
severity/blocking override
```

不要 hardcode：

```text
所有医院都强制双审/阻断
```

---

# 11. API

建议：

```text
GET  /medication-safety/rules
POST /medication-safety/rules
PATCH /medication-safety/rules/:id

POST /medication-safety/evaluate
GET  /medication-safety/checks?prescriptionId=
POST /medication-safety/checks/:id/override
```

真正处方 Issue 时：

```text
Clinical Domain 内部调用 evaluate service/RPC
```

不能依赖前端先调用 evaluate 才安全。

---

# 12. 权限

```text
medication_safety.view
medication_safety.manage
medication_safety.override
```

Rule 管理应 tenant-wide。

Override 可以 store scoped，但必须医生/负责人角色。

---

# 13. 前端

Encounter 处方区：

```text
安全检查状态
红/黄提示
规则名称
触发原因
建议
Override
```

禁止只 Toast 一句。

管理页面：

```text
规则列表
版本
严重度
启停
条件摘要
```

---

# 14. 测试

必须：

```text
same ingredient duplication
species contraindication
no weight → unable_to_evaluate
weight boundary
duration boundary
blocking without permission
override with permission but no reason
override reason
rule version trace
cross tenant rule
disabled rule
```

并验证：

```text
前端不调用 evaluate
直接 Issue
Server 仍会阻止
```

这是关键安全用例。

---

# 15. 失败条件

```text
只做前端校验
Rule 没版本
Override 无理由
无法计算时默认 PASS
重建第二套 Prescription
直接改已签病历
AI 自动判定为权威
```

---

# 16. Handoff

必须额外写：

```text
RULE_TYPES_IMPLEMENTED
STRUCTURED_DRUG_DATA_ASSUMPTION
UNABLE_TO_EVALUATE_POLICY
ISSUE_HOOK
DISPENSE_HOOK
OVERRIDE_POLICY
MEDICAL_LIMITATIONS
```

---

# 17. Commit

```text
feat(stage04-04): add explainable medication safety engine
```
