> 项目：毛线球宠物医院 SaaS
> 阶段：Stage-03 / S3.2 并发功能开发
> 文档：S32-E 最终 Integrator 集成报告
> 生成：2026-08-08（agent-E，main 分支）

# S32 集成报告

## 1. 结论

| 项 | 状态 |
|---|---|
| Ownership 审计 | ✅ 通过（A-D 均未越权修改 S3.1 Fix 文件 / e2e / permission helper / billing/clinical/inventory core） |
| Migration 审计 | ✅ 通过（编号锁内、顺序唯一、无历史 migration 修改、无重复 domain/table） |
| 路由集成 | ✅ 完成（/imports /analytics /documents /messaging 注册 + 前端菜单挂载） |
| 权限集成 | ✅ 前端 manifest / 后端授权 / RLS 三层一致（messaging 细粒度拆分 deferred，见 Gaps） |
| 安全核查 | ✅ 通过（无新增 RPC、Import 写边界、Messaging Secret、Analytics Scope、Document 医疗权限门） |
| Typecheck | ✅ API `tsc --noEmit` + 前端 `vue-tsc -b` 通过 |
| Build | ⏭️ 跳过（用户指示；runtime_verification_pending） |

**完成状态：`code_complete` + `integration_complete` + `runtime_verification_pending`（非 production_ready）**

---

## 2. Ownership 审计

核对 4 个 S3.2 Agent 的文件归属（对照编排 §6/§7 与 S32-E 规格 §2）：

| Agent | 交付形态 | 文件范围 | 越权 |
|---|---|---|---|
| S32-A Import | 未跟踪（工作区） | routes/imports.ts、services/imports/*、modules/imports.ts、components/imports/*、types/imports.ts、views/operations/imports/index.vue、migrations 100-101 | ✅ 无 |
| S32-B Analytics | staged | routes/analytics.ts、services/analytics/*、modules/analytics.ts、components/analytics/*、views/analytics/*、composables/useAnalyticsContext.ts、types/analytics.ts、migrations 104-105、KPI-DEFINITIONS | ✅ 无 |
| S32-C Documents | committed `d0439135` | routes/documents.ts、services/documents/*、modules/documents.ts、components/documents/*、views/operations/documents/index.vue、migrations 108-109 | ✅ 无 |
| S32-D Messaging | committed `5854aca4` `79bc0496` | routes/messaging.ts、services/messaging/*、providers/*、modules/messaging.ts、views/operations/messaging/index.vue、migrations 112 | ✅ 无 |

未发现任何 S3.2 文件修改：
- `api/lib/permission*` / `api/lib/me-context*` / `api/routes/{user,billing,clinical,diagnostics,inventory,inpatient,settings,approvals}.ts`
- `apps/maoxianqiu/src/store/modules/app/{account,tenant}.ts`
- `e2e/**`

> ⚠️ 注意：工作区存在 `supabase/migrations/20260806000021_inpatient.sql` 的历史 migration 修改（笼位释放逻辑），经核查为 **S3.1 Fix** 在途改动（住院核心事务），非 S3.2 所为。S32-E 未触碰；已在 S32-REMAINING-GAPS.md 记录该风险，由 S3.1 主线合并时裁决。

---

## 3. Migration 审计

| Agent | 编号 | 文件 | 内容 | 结论 |
|---|---|---|---|---|
| A | 100-101 | `...00100_import_center_v2.sql` `...00101_import_center_v2_permissions.sql` | import_jobs 扩展 + import_job_errors + 命令队列表 + RLS + 权限 seed | ✅ |
| B | 104-105 | `...00104_analytics_permissions.sql` `...00105_analytics_report_indexes.sql` | 权限码/授权 + 只读聚合索引（无表结构变更） | ✅ |
| C | 108-109 | `...00108_document_templates.sql` `...00109_document_default_templates.sql` | document_templates + document_history + RLS + 8 类默认模板 + 权限 seed | ✅ |
| D | 112 | `...00112_messaging_provider.sql` | message_deliveries 扩展列 + message_delivery_attempts + RLS | ✅ |

- 编号均在锁内：A(100-103) B(104-107) C(108-111) D(112-115)，未抢用 S3.1 的 92-99。
- 顺序唯一、递增；无重复 table/domain。
- **无新增 RPC**（4 个 migration 均无 `create function`），`service-rpc-manifest.ts` 无需改动，RPC ACL 未被扩大。

---

## 4. 路由集成（S32-E 独占改动）

### 服务端 `api/index.ts`
注册 4 个模块（与 `/operations` 并列，路径无冲突）：

```text
/imports    → S32-A 导入中心 V2
/analytics  → S32-B 经营报表（只读聚合）
/documents  → S32-C 业务文档中心 V2
/messaging  → S32-D 消息通知真实 Provider
```

### 前端路由
| 文件 | 改动 |
|---|---|
| `router/modules/analytics.ts` | **新建**：dashboard/revenue/customers/clinical/inventory 5 个报表页 |
| `router/routes.ts` | 新增「经营分析」一级菜单组（运营管理之后、监管运营之前） |
| `router/modules/operations.ts` | 新增 `/operations/documents`；`/operations/message/{templates,deliveries}` → 替换为 `/operations/messaging`（新消息中心为超集，含 templates/send/deliveries 三 tab） |

导航规则遵守：Import/Documents/Messaging 挂 Operations 二级；Analytics 独立一级；未新增大量一级导航。

---

## 5. 权限集成（三层一致）

汇总权限码：

| 模块 | 权限码 | 后端授权 | RLS | 前端 manifest |
|---|---|---|---|---|
| imports | view/create/execute/cancel（+manage 兼容） | ✅ requireScopedPermission | ✅（只读给租户成员，写仅 service role） | ✅ 已补 4 码 |
| analytics | view.store / view.tenant / export | ✅ resolveAnalyticsScope + export 校验 | ✅（无新表，聚合走既有表 RLS） | ✅ 已补 3 码 |
| documents | view / print / template.manage | ✅ requireScopedPermission(dataScope) + 医疗业务权限门 | ✅（SELECT 租户成员+系统模板，写仅 service role） | ✅ 已补 3 码 |
| messaging | message.manage（沿用旧码） | ✅ requireScopedPermission | ✅（attempts 只读策略） | ✅（沿用既有 message.manage） |

说明：
- `imports.upload/mapping/validate`、`documents.render/template.create/template.update`、`messaging.*` 均为 **audit action**（写入 `audit_logs`），非权限码。
- messaging 规格想要的 `messaging.view/send/template.manage/retry` 细粒度码未实现，当前统一用 `message.manage`（粗粒度但安全）。见 Gaps。

---

## 6. 安全核查（S32-E §14）

| 项 | 结论 |
|---|---|
| RPC ACL | ✅ 无新增 RPC，未扩大 ACL |
| RLS | ✅ 新表（import_jobs 扩展/errors/命令队列/document_*/message_delivery_attempts）均 RLS，写仅 service role |
| Tenant/Store Context | ✅ 全部经 requireScopedPermission / resolveAnalyticsScope 收敛 |
| Import 写边界 | ✅ 只写 customers/pets/catalog_items（导入业务目标）+ 命令队列表；不直改 inventory_balances/batches，不建 auth 用户 |
| Document 医疗权限 | ✅ imaging_report→imaging.view、discharge_summary→inpatient.view、boarding_handover→boarding.view 业务权限门 + documents.view |
| Messaging Secret | ✅ API Key 仅服务端 env（config.ts），不下发前端/不进模板字段 |
| Analytics Scope | ✅ storeId→view.store（单店）；无 storeId→view.tenant（全院）+ allowedStoreIds 收敛 |

---

## 7. 构建 / Typecheck

- API：`npx tsc --noEmit`（api/）✅
- 前端：`npx vue-tsc -b`（apps/maoxianqiu/）✅
- Build：按用户指示跳过；`runtime_verification_pending`，主线合并后需补 `vite build` 与冒烟。

---

## 8. 遗留项

见 `S32-REMAINING-GAPS.md`。核心：
1. Messaging Webhook（`POST /api/messaging/provider/:provider/webhook`）本轮未实现（delivery confirmation deferred）。
2. 跨域 Hook：Opening Stock → Inventory Command；Employee Invite → IAM 邀请（等 S3.1 合并后接）。
3. 旧打印中心（`print_templates`）与新文档中心（`document_templates`）是否收敛，待主线裁决。
