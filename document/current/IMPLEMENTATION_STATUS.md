# 实施状态文档（IMPLEMENTATION_STATUS）

> 本文件与代码保持对齐，由每次交付更新（Stage-04 Agent-09 Final Integrator 重写为当前事实，不再追加历史流水）。
> 状态值仅使用允许枚举：`implemented` / `source_verified` / `runtime_pending` / `runtime_verified` / `uat_pending` / `uat_verified` / `deferred` / `disabled` / `known_gap`。

## 状态总览

| 阶段 | 内容 | 状态 | 说明 |
| --- | --- | --- | --- |
| DEV-000 | 基线对齐 | source_verified | 代码主体与 v0.5 设计文档对齐 |
| P0-01 ~ P0-10 | 核心闭环任务 | source_verified | 全部落地；runtime 依赖 staging |
| S3.0 | 审计收口（AUD-001~011） | source_verified | 含 scoped permission / report-data 门店收敛 / 库存一致性 |
| S3.0-R | 定向复审（R01~R07） | source_verified | 含 DB scoped permission / SECURITY DEFINER 默认拒绝 / 签署强制本人 |
| S3.0-F | 复审（F01~F04） | source_verified | 平台管理员独立模型 + RPC 全量 revoke + rpc_security.sql |
| S31-MERGE-FINAL | 合并批次收尾 | source_verified | FINAL-01~04（监管签名/兽医数边界/can_access_store） |
| S31-A/B/C/D | S3.1 并发集成收尾 | source_verified | migration 35~49；check:rpc-manifest PASS（96 处/96 个/missing 0） |
| S3.1-PARALLEL | S3.1 并发加速（Agent-01~07） | source_verified | migration 54~73 + 90/91；门禁全绿 |
| S3.2-FINAL | Full12 全量包审计收口 | source_verified | Secret 清理 + Messaging/Analytics 修复 + Import 入口隐藏 |
| Stage-04 | 新需求并发开发（Agent-01~09） | source_verified / runtime_pending | migration 200~285 + 共享入口集成；runtime 由 Agent-01 依据 RUNTIME-HANDOFF 执行 |

## Stage-04 交付明细（当前批次）

> 依据：`document/stage-04/Stage-04-8-Agent/00-Stage04-Source13-Parallel-Orchestration-v2.md`（同 main 并发，Agent 只提交自己的文件）。
> 迁移号段：Agent-03=200-203，Agent-04=210-211，Agent-05=220-223，Agent-06=235，Agent-07=250-252，Agent-08=265-267，Agent-09 修复=285-299。
> 全部新 RPC 已登记 `api/lib/service-rpc-manifest.ts`（当前共 **170 个** service-role-only 函数），migration 侧 revoke/grant 已逐段核对一致。

### Agent-01 Runtime/UAT 基础（commit `06a0266f`）
- `scripts/e2e-setup.sh` / `scripts/runtime-blank-db.sh` / `scripts/runtime-common.sh` / `scripts/runtime-rpc-acl-check.ts`。
- `supabase/tests/stage04_rls_matrix.sql`（RLS 矩阵）。
- `document/testing/STAGE04-*` 一组 runtime/UAT 文档。

### Agent-02 Release Guard（commit `1bb3a079`）
- `scripts/check-api-esm.ts` / `scripts/release-preflight.ts` / `scripts/release-smoke.ts`。
- 根 `package.json` 新增 `check:api-esm` / `release:preflight` / `release:smoke`（Agent-09 在 `check:rpc-manifest` 之后统一补入）。

### Agent-03 钱包/储值（migration 200~203，`api/routes/wallet.ts`）
- 表：`stored_value_accounts` / `stored_value_ledger`；RPC：`open_stored_value_account` / `recharge_stored_value` / `adjust_stored_value` / `set_stored_value_account_status` / `ensure_stored_value_payment_context`。
- 权限：`wallet.view` / `wallet.recharge` / `wallet.adjust` / `wallet.freeze`。
- 跨域：stored_value 扣减与 `process_payment` / `process_refund` 在 migration 203 同事务原子集成（Agent-09 验证签名一致）。

### Agent-04 用药安全（migration 210~211，`api/routes/medication-safety.ts`）
- RPC：`evaluate_medication_safety` / `override_medication_safety_check` / `upsert_medication_safety_rule` / `set_medication_safety_rule_active` / `upsert_drug_profile` / `upsert_drug_interaction`。
- 权限：`medication_safety.view` / `medication_safety.manage` / `medication_safety.override`。
- 跨域：`issue_prescription` / `dispense_prescription` 服务端阻塞 hook 已挂接（非仅前端按钮）。

### Agent-05 CRM 增长与营销（migration 220~223，`api/routes/crm-growth.ts` + `api/routes/marketing.ts`）
- CRM：客户分层/流失预警（`crm.segment.view` / `crm.segment.manage` / `crm.churn.view`），RPC：`evaluate_customer_segments` / `compute_customer_churn` / `refresh_*` / `customer_profile_snapshot`。
- 营销：优惠券 / 服务套餐 / 活动 / 转介绍（`marketing.view` / `marketing.manage` / `marketing.adjust_entitlement` / `marketing.publish`），RPC：`gen_coupon_code` / `issue_coupons` / `preview_coupon_discount` / `redeem_coupon` / `cancel_coupon_issue` / `purchase_package` / `redeem_package` / `reverse_package_redemption` / `refund_package` / `generate_referral_code` / `register_referral` / `publish_campaign`。
- 真源原则：Segment = Audience 真源，Marketing 不复制第二套 Audience Engine；定价优先级唯一（membership → coupon → package → manual）。

### Agent-06 保险与文档归档（migration 235，`api/routes/insurance.ts` + `api/routes/document-artifacts.ts`）
- 权限：`insurance.view` / `insurance.generate`；`documents.pdf.generate` / `documents.archive.view` / `documents.signature.manage`。
- RPC：`create_insurance_claim_pack` / `update_insurance_claim_pack_items` / `transition_insurance_claim_pack` / `create_insurance_claim_export` / `create_signature_request` / `transition_signature_request` / `record_signature_event`。
- 跨域：保险理赔包复用 Documents Adapter（PDF/归档），无独立 `insurance_pdf_templates` 体系。

### Agent-07 采购/退货/导入（migration 250~252，`api/routes/purchase-requests.ts` + `purchase-returns.ts` + `import-consumers.ts`）
- 权限：`purchase_request.create/submit/approve/convert`；`purchase_return.create/submit/approve/post`；`imports.employee.execute` / `imports.opening_stock.execute` / `imports.execute`。
- 跨域：采购退货最终写 `inventory_movements`（同一库存体系，幂等 + 批次 + warehouse scope）；Import Consumer 经 `invite_employee` RPC（IAM 域契约），失败 `deleteUser` 补偿，无直接 auth.admin.createUser。

### Agent-08 客户门户与消息 Webhook（migration 265~267，`api/routes/portal.ts` + `api/routes/messaging-webhook.ts`）
- 权限：`portal.identity.view/manage`、`portal.pet.access.view/manage`、`portal.consent.view`、`portal.subscription.view`、`portal.webhook.view`；`messaging.*`（兼容 `message.manage`）。
- RPC：`portal_create_otp_challenge` / `portal_verify_otp` / `create_portal_appointment` / `apply_provider_event`。
- 跨域：C 端独立 portal session（HMAC token），员工 IAM 仅用于 `/portal/admin/*`；预约走 RPC（幂等），报告只暴露 `customer_visible && published`；Webhook 验签失败 401。

### Agent-09 Final Integrator（共享入口 + 修复 + 文档）
- `api/index.ts`：注册 `crm-growth` / `marketing` / `medication-safety` / `insurance` / `document-artifacts` / `portal` / `wallet` / `purchase-requests` / `purchase-returns` / `import-consumers` / `messaging/webhook`（具体路由先于父路由挂载，避免动态路由吞具体路由）。
- `apps/maoxianqiu/src/router/routes.ts`：新增菜单「营销增长」（MarketingModule）、「客户门户」（PortalModule），客户宠物挂 CRM Growth，诊疗核心挂 Medication Safety，运营管理挂 Insurance；权限 meta 与后端权限码一致。
- 根 `package.json`：补 Agent-02 请求的 `check:api-esm` / `release:preflight` / `release:smoke` 脚本。
- **migration 285**（Agent-09 修复）：`appointments_source_check` 增加 `customer_portal`（migration 19 定义不含该值，阻塞 Agent-08 `create_portal_appointment`）；幂等 drop+add，附审计。

## 权限一致性（Stage-04 收口）

- 全部新权限码在各自 migration 内 INSERT permissions 目录 + 角色数组扩展（`permissions || array[...]`），与 seed.sql 无重复、无语义重叠（无 `wallet.manage`/`wallet.admin`/`stored_value.manage` 三套同义词）。
- 前端菜单 `meta.auth` 与后端 `requireScopedPermission` 权限码逐一对应。
- 前端无 `supabase.rpc()` 直连新 RPC（全部经 Hono `service.rpc()` + scoped 授权）。

## 未验证项（runtime_pending，须 staging 验证）

- Stage-04 migration 200~285 空库/旧库升级演练（含 285 约束重建幂等）。
- Stage-04 RLS / RPC 矩阵（`stage04_rls_matrix.sql`）真实执行。
- 钱包↔计费原子性、用药安全服务端 hook、采购退货库存写、门户预约、Webhook 收件在真实 DB 验证。
- 前端新模块 UI 联调（营销增长 / 客户门户 / 钱包 / 用药安全 / 保险 / 采购请求/退货 / 导入消费者）。
- Agent-01 E2E / UAT gate 按 `document/stage-04/STAGE04-RUNTIME-HANDOFF.md` 执行。

## 已交付任务明细（历史阶段摘要）

### P0-01 scoped permission
- `requireScopedPermission({ code, tenantId, storeId })`，按调用者成员身份解析真实作用域；平台管理员以 `PLATFORM_ADMIN_ROLE = 'system_admin'` 判定。

### P0-02 service role route 收口
- 全部 domain 路由补 scoped 授权并强制按 `scope.tenantId` 过滤；禁止客户端自由指定 tenant 后 service role 直查。

### P0-03 旧文件接口下线
- 下线 `/api/upload`、`/api/files`，统一 files 表 + R2 私有签名 URL。

### P0-05 打印真实数据
- print-data 接口绑定真实业务 DTO；打印页接入。

### P0-06 报表统一
- Hono `/operations/report-data/:reportCode` 服务端聚合；挂载先于 `/operations`；前端删除浏览器跨表聚合。

### P0-07 消息策略
- 决策：方案 A（消息退出 MVP），页面/接口按 MVP 边界裁剪。

### P0-08 库存一致性
- migration 25：FEFO 批次扣减 + `reserved_until` 释放 + 处方发药/取消联动。

### P0-09 真实闭环 E2E
- 闭环 A/B/C 编写并通过 tsc（staging 执行）。

### P0-10 文档与命令修正
- 根 package.json `test:e2e` 系列；AGENTS.md 重写；本组文档新增。

## S3.0 审计收口（AUD-001~011）
- scoped permission 作用域串用修复（`allowedStoreIds`）、report-data 门店数据范围、宠物新增 UI、表单 Picker 化、打印选择器收口、库存过期预留确认修复、E2E 禁止核心 skip、闭环 A 顺序确认、门禁全绿、文档对齐。

## S3.0 定向复审（S30-R01~R07）
- DB `has_permission()` scope 感知（migration 26）；Hono role scope 校验 + `validate_era_scope()` 触发器；SECURITY DEFINER RPC 全量 revoke + 前端改走 Hono；employee.id / auth.users.id 语义修复；闭环 A UI 建宠物 + UI 签署；Picker 最后清场；证据文档。

## S3.0 复审（S30-F01~F04）
- 平台管理员独立模型（`platform_user_roles`，`is_system_admin()` 只读来源）；RPC 默认拒绝（migration 27 revoke 55 函数名，manifest + CI 静态规则）；`rpc_security.sql` 独立可执行；文档证据。

## S31-MERGE-FINAL（FINAL-01~04）
- 监管 RPC 函数签名修复（DEFAULT 后无默认参数）、年度报告兽医数时间/门店边界、`can_access_store` store↔tenant 自校验、当前源码 RPC 口径（72 处 / 67 unique / 72 manifest / missing 0）。

## S31-A/B/C/D（migration 35~49）
- 租户初始化 / 日结对账 / 医疗闭环合并入主线；RPC manifest 96 处/96 个/missing 0；前端直连 RPC=0；seed 权限全量同步。

## S3.1-PARALLEL（migration 54~73 + 90/91）
- 平台租户 / 会员产品化 / 影像 / 回访 / 采购 / 寄养六个模块；Integrator 修复 RPC manifest（90）+ 寄养→计费原子（91）+ 自动回访；门禁全绿。

## S3.2-FINAL（Full12 全量包审计）
- Secret 清理（删除 9 个 tmp 明文凭据文件 + e2e-setup 全环境变量化）；Messaging 修复（updated_at/sending_claimed_at + CAS claim + 晚到丢弃 + sending 状态）；Analytics 修复（Refund 形状/Catalog 对账方案 A/Doctor 未归因）；Import 隐藏 employee/opening-stock 入口。
