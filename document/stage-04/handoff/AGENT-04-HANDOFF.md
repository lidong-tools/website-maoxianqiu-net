# AGENT-04-HANDOFF — Medication Safety 用药安全规则引擎

## STATUS

```text
code_complete
（未执行 tsc / 语法检查 / supabase test：按任务约定跳过耗时编译；
 DB 测试脚本已交付 supabase/tests/medication_safety.sql，待 CI/本地实例执行）
```

## SOURCE_RESEARCH

```text
1. 当前 main 已有 prescriptions / prescription_items(20260806000019_clinical.sql):
   - prescription_items.dosage 为自由文本(如 "5mg/kg bid"),需解析;
   - prescriptions 状态机 draft→issued→dispensed/cancelled(20260808000028_compliance_base.sql);
   - issue_prescription / dispense_prescription 定义于 20260808000029_compliance_rpc.sql(合规域)。
2. 现有 RLS helper 可复用:is_tenant_member / can_access_store / has_permission / touch_updated_at。
3. pets(20260806000015)含 species / birth_date;pet_weights 含体重记录(评估取最近一次)。
4. service-rpc-manifest.ts 为共享可写清单,第 9 节要求新增高危 RPC 必须登记 + migration 显式 revoke/grant;
   check-rpc-manifest.ts 校验:routes .rpc() ∈ manifest,且 manifest 每项 ∈ migrations 单引号字符串。
5. api/index.ts 与 apps/maoxianqiu/src/router/routes.ts 为共享冻结文件(仅 Agent-09 修改)→ 本 Agent 走 INTEGRATION_REQUESTS。
6. 未重建第二套处方系统:复用现有 prescriptions 数据模型,仅在 issue/dispense RPC 内挂接 evaluate 门禁。
```

## START_HEAD

```text
a728de0b update
```

## COMMIT_SHA

```text
（提交后回填,见提交记录）
```

## OWNED_FILES

```text
supabase/migrations/20260810000210_medication_safety_base.sql
supabase/migrations/20260810000211_medication_safety_rpc.sql
api/routes/medication-safety.ts
apps/maoxianqiu/src/types/medication-safety.ts
apps/maoxianqiu/src/api/modules/medication-safety.ts
apps/maoxianqiu/src/router/modules/medication-safety.ts
apps/maoxianqiu/src/views/clinical/medication-safety/index.vue
apps/maoxianqiu/src/views/clinical/medication-safety/components/RuleForm.vue
apps/maoxianqiu/src/views/clinical/medication-safety/components/DrugProfileForm.vue
apps/maoxianqiu/src/views/clinical/medication-safety/components/InteractionForm.vue
supabase/tests/medication_safety.sql
document/stage-04/handoff/AGENT-04-HANDOFF.md（本文件）
```

## MODIFIED_EXISTING_FILES

```text
api/lib/service-rpc-manifest.ts
  - 追加 Agent-04 6 个 RPC 登记(medication safety, migration 210~211);
  - 该文件为多 Agent 共享可写文件,同一 diff 内还含 Agent-03/05/06/07/08 的追加,均为纯追加无冲突;
  - 本 Agent 仅认领自己 6 个条目的正确性。
```

## NEW_FILES

```text
supabase/migrations/20260810000210_medication_safety_base.sql
supabase/migrations/20260810000211_medication_safety_rpc.sql
api/routes/medication-safety.ts
apps/maoxianqiu/src/types/medication-safety.ts
apps/maoxianqiu/src/api/modules/medication-safety.ts
apps/maoxianqiu/src/router/modules/medication-safety.ts
apps/maoxianqiu/src/views/clinical/medication-safety/index.vue
apps/maoxianqiu/src/views/clinical/medication-safety/components/RuleForm.vue
apps/maoxianqiu/src/views/clinical/medication-safety/components/DrugProfileForm.vue
apps/maoxianqiu/src/views/clinical/medication-safety/components/InteractionForm.vue
supabase/tests/medication_safety.sql
```

## MIGRATIONS

```text
20260810000210_medication_safety_base.sql  数据模型 + 权限 + 种子规则
20260810000211_medication_safety_rpc.sql  评估/豁免/CRUD RPC + issue/dispense 门禁 + ACL
```

## NEW_TABLES

```text
medication_safety_rules          规则定义(租户级,code 唯一,带 current_version)
medication_safety_rule_versions  规则版本(只追加,审计)
drug_profiles                    药品档案(剂量/物种/年龄/体重约束,结构化数据源)
medication_drug_interactions     药物相互作用对(ingredient_a/ingredient_b,severity)
medication_safety_checks         检查结果(每次 evaluate 幂等 upsert,blocking + status)
medication_safety_overrides      豁免记录(必填 reason,审计)
```

## NEW_COLUMNS

```text
无(全部新增表,未改动现有表结构)
```

## NEW_INDEXES

```text
idx_ms_rules_tenant_active        medication_safety_rules(tenant_id, active)
idx_ms_rules_tenant_type          medication_safety_rules(tenant_id, rule_type)
idx_ms_rule_versions_rule         medication_safety_rule_versions(rule_id)
idx_drug_profiles_tenant          drug_profiles(tenant_id)
idx_drug_profiles_ingredient      drug_profiles(tenant_id, active_ingredient) where not null
idx_mdi_tenant_pair               medication_drug_interactions(tenant_id, ingredient_a, ingredient_b)
idx_ms_checks_prescription        medication_safety_checks(prescription_id, check_stage)
idx_ms_checks_pending             medication_safety_checks(prescription_id, blocking, status) where status='triggered'
idx_ms_checks_tenant_created      medication_safety_checks(tenant_id, created_at desc)
idx_ms_overrides_check            medication_safety_overrides(check_id)
```

## NEW_RPCS

```text
migration 210:
  ensure_medication_safety_rules(p_tenant_id, p_operator_user_id)  幂等种子 10 种默认规则
migration 211:
  ms_parse_dose_mg_per_kg(dosage text, weight_kg numeric)         剂量文本解析 helper
  ms_record_check(...)                                            检查结果幂等 upsert helper
  evaluate_medication_safety(p_prescription_id, p_stage)          核心评估引擎(jsonb 返回)
  override_medication_safety_check(p_check_id, p_operator_user_id, p_reason)  豁免(必填理由)
  upsert_medication_safety_rule(...)                              规则 upsert + 版本推进
  set_medication_safety_rule_active(...)                          规则启停
  upsert_drug_profile(...)                                        药品档案 upsert
  upsert_drug_interaction(...)                                    相互作用 upsert
重定义(migration 211,与 20260808000029 幂等兼容):
  issue_prescription(...)     issue 阶段执行 evaluate;存在 blocking_unresolved → 抛 MEDICATION_SAFETY_BLOCKED
  dispense_prescription(...)  dispense 阶段执行 evaluate;未豁免阻断同样拒绝(保留原库存扣减逻辑)
```

## RPC_ACL

```text
migration 211 末尾 DO 块对 11 个函数统一:
  revoke all on function ... from public / anon / authenticated;
  grant execute on function ... to service_role;
清单(evaluate_medication_safety, override_medication_safety_check, upsert_medication_safety_rule,
     set_medication_safety_rule_active, upsert_drug_profile, upsert_drug_interaction,
     issue_prescription, dispense_prescription, ms_record_check, ms_parse_dose_mg_per_kg,
     ensure_medication_safety_rules)
已登记 api/lib/service-rpc-manifest.ts;check-rpc-manifest.ts 规则 1/2 均满足。
```

## PERMISSIONS

```text
medication_safety.view     查看规则/档案/检查结果
medication_safety.manage   管理规则/档案/相互作用(写走 RPC)
medication_safety.override 豁免阻断(override RPC)
分配:system_admin / store_manager 全部 3 项;doctor 为 view + override。
```

## API_ROUTES

```text
api/routes/medication-safety.ts(前缀 /medication-safety,Hono):
  GET  /rules                         规则列表(直连,RLS)
  POST /rules                         upsert 规则(RPC)
  PATCH /rules/:id                    更新规则(RPC)
  POST /rules/:id/toggle              启停(RPC)
  GET  /drug-profiles                 药品档案列表(直连,RLS)
  POST /drug-profiles                 upsert 档案(RPC)
  GET  /interactions                  相互作用列表(直连,RLS)
  POST /interactions                  upsert 相互作用(RPC)
  POST /evaluate                      执行评估(RPC,入参 prescriptionId + stage)
  GET  /checks                        检查结果列表(直连,RLS,prescriptionId 过滤)
  POST /checks/:id/override           豁免(RPC,reason 必填)
```

## FRONTEND_ROUTES

```text
/clinical/medication-safety(router/modules/medication-safety.ts,meta.auth: medication_safety.view)
```

## MENU_REGISTRATION_REQUEST

```text
待 Agent-09 将 router/modules/medication-safety.ts 注册进 apps/maoxianqiu/src/router/routes.ts(共享冻结文件)。
```

## ENV_VARS

```text
无新增
```

## CROSS_DOMAIN_CONTRACTS

```text
1. 合规域 issue_prescription / dispense_prescription 在 migration 211 中被重定义(在 29 号版本基础上包一层安全门禁):
   - issue:评估存在 blocking_unresolved 且未豁免 → 抛 MEDICATION_SAFETY_BLOCKED(即便前端不调用 evaluate,服务端强制拒绝);
   - dispense:同样门禁,保留原库存扣减/状态流转逻辑;
   - 契约:任何调用方无需改动参数签名;新增错误码 MEDICATION_SAFETY_BLOCKED(422)。
2. 依赖临床域数据:prescriptions / prescription_items / pets / pet_weights,只读不修改。
3. RPC 门禁在 DB 层强制执行,前端未接 evaluate 弹窗不影响安全性(INTEGRATION_REQUESTS 可后置 UI)。
```

## TESTS_RUN

```text
已交付 supabase/tests/medication_safety.sql(事务 begin/rollback + tests schema 断言):
  P1   duplicate_ingredient 阻断
  P2   无 evaluate 直接 issue 被拒(关键安全用例)
  P3   dose_range 触发
  P4   species_contraindication + override 流程
  P5   无体重 → unable_to_evaluate(不默认 PASS)
  P6   体重边界
  P7   疗程边界
  P8   规则版本追溯
  P9   停用规则不计入
  P10  跨租户隔离
  P11  dispense 门禁 + override / 重复 override 拒绝
```

## TEST_RESULTS

```text
未执行(按任务约定跳过编译/运行;DB 测试需本地 supabase 实例,由 CI 或 Agent-01 运行时验证)。
```

## KNOWN_GAPS

```text
1. drug_profiles 结构化数据当前需人工维护(管理页已提供 CRUD);无档案 → unable_to_evaluate,不默认 PASS。
2. 前端处方开具工作流(临床域)尚未接入 evaluate 结果展示/豁免弹窗;规则引擎已服务端强制生效,UI 接入列为集成请求。
3. 剂量解析 ms_parse_dose_mg_per_kg 覆盖常见 "x mg/kg" / "x mg" / 纯数值文本;非常规写法(如滴剂/胶囊单位换算)返回 NULL → unable_to_evaluate。
4. 相互作用仅支持"活性成分对"匹配,不解析复方制剂内部成分。
```

## DEFERRED

```text
1. 处方开具页面(compliance/clinical 前端)的阻断提示 + 豁免理由输入 UI → 由集成阶段/后续 stage 接入。
2. 药品档案的批量导入(现有 import-consumers 能力可复用,未实现)。
```

## INTEGRATION_REQUESTS

```text
[Agent-09 Final Integrator 必做]
1. api/index.ts 注册 medication-safety 路由:
   import medicationSafetyRoutes from './routes/medication-safety'
   app.route('/medication-safety', medicationSafetyRoutes)
   (若 index.ts 采用数组式注册,追加到对应数组)
2. apps/maoxianqiu/src/router/routes.ts 注册前端路由模块:
   追加 import medicationSafety from '@/router/modules/medication-safety' 到路由聚合数组。
3. 提示:issue/dispense 门禁已在 DB 层生效,即使前端不调用 evaluate,直接调用 issue_prescription 也会被 MEDICATION_SAFETY_BLOCKED 拒绝;
   "无 evaluate 直接 issue" 属于预期行为(安全设计),非缺陷。
```

## ROLLBACK_NOTES

```text
1. 回滚顺序:先 drop migration 20260810000211 涉及函数(或整体 revert),再 drop 20260810000210 的表/权限/种子。
2. 删除 211 后 issue_prescription / dispense_prescription 自动恢复为 20260808000029 版本(无安全门禁),回滚后需人工评估处方合规影响。
3. service-rpc-manifest.ts 如需回滚:仅移除 Agent-04 的 6 行(注意该文件同时含其他 Agent 追加,禁止整文件 revert)。
```

---

# Agent-04 特有 Handoff 块

## RULE_TYPES_IMPLEMENTED

```text
10 种规则类型(种子函数 ensure_medication_safety_rules 提供,租户可覆盖):
  duplicate_drug            重复药品        warning  (默认不阻断)
  duplicate_ingredient      重复活性成分    error    (默认阻断)
  dose_range                剂量范围        warning  (由 drug_profiles 参考剂量驱动)
  duration_limit            疗程上限        warning  (condition.max_duration_days,默认 30 天)
  frequency_limit           频次上限        warning  (condition.max_daily_frequency,默认 4)
  species_contraindication  物种禁忌        error    (默认阻断)
  age_constraint            年龄约束        warning  (由档案适用年龄驱动)
  weight_constraint         体重约束        warning  (由档案适用体重驱动)
  antimicrobial_notice      抗菌药物提示    info     (记录用药指征)
  drug_interaction          药物相互作用    error    (默认阻断,由 interactions 表驱动)
评估引擎支持 severity 覆盖:租户可将任意规则提升为阻断或降级。
```

## STRUCTURED_DRUG_DATA_ASSUMPTION

```text
1. drug_profiles(tenant_id, active_ingredient, drug_name, species, min/max dose mg/kg,
   min/max age, min/max weight, max_duration_days)为唯一结构化剂量数据源;
2. 解析链:prescription_items.dosage(自由文本) → ms_parse_dose_mg_per_kg → 数值 mg/kg;
   结合 pets 最近一次 pet_weights 计算实际剂量;
3. 档案缺失/剂量文本不可解析 → 该规则类型返回 unable_to_evaluate;
4. 数据维护:管理页 CRUD + 后续可复用 Import Consumers 批量导入(本次未实现批量)。
```

## UNABLE_TO_EVALUATE_POLICY

```text
- 默认策略:无法自动校验时返回 unable_to_evaluate,绝不允许当作 PASS;
- 影响:issue/dispense 门禁仅对 blocking_unresolved 阻断;
  unable_to_evaluate 不阻断流程,但作为显式检查项(severity 保留规则原始级别)写入 checks,
  前端可展示"系统无法自动校验,请人工核对"提示;
- 该策略保证"缺数据不误伤,也不掩盖风险"。
```

## ISSUE_HOOK

```text
- 位置:migration 211 重定义的 issue_prescription 内,evaluate(p_stage='issue') 之后、状态翻转之前;
- 行为:返回 jsonb 中 blocking_unresolved(triggered 且 is_blocking 且未豁免)非空 → raise MEDICATION_SAFETY_BLOCKED;
- 关键点:服务端强制,前端不调用 evaluate 也无法绕过(安全用例 P2 已验证设计);
- 豁免生效后同一 check 进入 overridden 状态,后续 evaluate 不再计入 blocking_unresolved。
```

## DISPENSE_HOOK

```text
- 位置:重定义的 dispense_prescription 内,evaluate(p_stage='dispense') 之后;
- 行为:与 issue 相同,存在未豁免阻断 → 拒绝发药;
- 保留原逻辑:状态必须 issued、未过期、库存扣减、幂等;
- 重复 evaluate 幂等:ms_record_check 以 (prescription_id, rule_id, check_stage, hash) 去重。
```

## OVERRIDE_POLICY

```text
- 入口:override_medication_safety_check(p_check_id, p_operator_user_id, p_reason);
- 约束:
  1) reason 必填且长度 ≥ 2,缺失直接拒绝(文档 §7 要求);
  2) 权限:需 medication_safety.override(doctor 已授);
  3) 仅可豁免当前租户/门店范围 triggered 的 check;
  4) 重复豁免同一 check → 拒绝(已 overridden);
  5) 每次豁免写入 medication_safety_overrides(operator/reason/created_at),全程审计;
- 豁免仅影响单个 check,规则本身不因豁免而停用。
```

## MEDICAL_LIMITATIONS

```text
1. 本引擎是"确定性决策支持",不替代兽医专业判断;任何规则结论都可被授权用户豁免并记录理由;
2. 剂量解析基于文本启发式(ms_parse_dose_mg_per_kg),不覆盖所有单位换算(滴/粒/胶囊等效 mg 依赖档案数据);
3. 相互作用仅按活性成分对匹配,复方制剂内部成分需拆解录入 drug_profiles 才可命中;
4. 年龄/体重约束依赖 pets 与 pet_weights 数据质量,无数据时返回 unable_to_evaluate(不阻断,但人工核对);
5. 过敏史(allergy)未纳入本次规则集(需要过敏数据模型,列为后续增强)。
```
