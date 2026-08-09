# STAGE04-RUNTIME-HANDOFF（Agent-09 → Agent-01）

> 依据：`document/stage-04/Stage-04-8-Agent/Agent-09-Final-Integrator-DEEP.md` §21。
> 目的：Agent-01 不应自己猜 Stage-04 新域怎么测。本文档列出 Stage-04（Agent-03~09）全部运行时验证所需事实。
> 当前状态：**source_verified / runtime_pending** —— 代码与静态集成已完成；真实 DB / RLS / RPC ACL / E2E / UAT 全部依赖 staging。

## 1. Migration range

```text
200  open_stored_value_accounts         (Agent-03)
201  stored_value_ledger                (Agent-03)
202  stored_value_rpc                   (Agent-03)
203  stored_value_billing_integration   (Agent-03)
210  medication_safety_base             (Agent-04)
211  medication_safety_rpc              (Agent-04)
220  crm_segment_churn                  (Agent-05)
221  coupons                            (Agent-05)
222  service_packages                   (Agent-05)
223  marketing_campaign_referral        (Agent-05)
235  insurance_documents_archive        (Agent-06)
250  purchase_request                   (Agent-07)
251  purchase_return                    (Agent-07)
252  import_consumers                   (Agent-07)
265  portal_identity                    (Agent-08)
266  portal_appointment                 (Agent-08)
267  messaging_webhook_permissions      (Agent-08)
285  portal_appointment_source_constraint (Agent-09 集成修复)
```

规则：
- 空库/旧库升级必须从 0 跑到最新（当前最新 = 285）。
- 285 是 Forward Fix：`appointments_source_check` 幂等 drop + 重建（原值 + `customer_portal`）；已应用 266 的库直接应用 285 即可，无需回滚。

## 2. New tables

| Migration | 表 |
| --- | --- |
| 200/201 | `stored_value_accounts`、`stored_value_ledger` |
| 210 | `medication_safety_rules`、`drug_profiles`、`drug_interactions`、`medication_safety_checks`（审计/阻断记录） |
| 220 | `crm_segments`、`crm_segment_rules`、`crm_segment_memberships`、`crm_churn_scores` |
| 221 | `coupon_templates`、`customer_coupons` |
| 222 | `service_packages`、`customer_packages`、`package_redemptions` |
| 223 | `marketing_campaigns`、`referral_records` |
| 235 | `insurance_claim_packs`、`insurance_claim_pack_items`、`insurance_claim_exports`、`signature_requests`、`signature_events`（文档归档复用既有 `document_archives`） |
| 250 | `purchase_requests`、`purchase_request_items` |
| 251 | `purchase_returns`、`purchase_return_items` |
| 252 | `import_tasks`（复用既有表，新增 domain apply 状态 `awaiting_domain_apply`） |
| 265 | `customer_identities`、`customer_pet_access`、`customer_consents`、`notification_subscriptions`、`verification_challenges` |
| 266 | `portal_verification_codes`（如存在）或复用 `verification_challenges`；预约经 `create_portal_appointment` |

## 3. New RPC（全部 service-role-only，已登记 manifest 共 170 个）

| Agent | RPC |
| --- | --- |
| 03 | `open_stored_value_account` / `recharge_stored_value` / `adjust_stored_value` / `set_stored_value_account_status` / `ensure_stored_value_payment_context` |
| 04 | `evaluate_medication_safety` / `override_medication_safety_check` / `upsert_medication_safety_rule` / `set_medication_safety_rule_active` / `upsert_drug_profile` / `upsert_drug_interaction` |
| 05 | `customer_profile_snapshot` / `evaluate_customer_segments` / `compute_customer_churn` / `refresh_segment_memberships` / `refresh_churn_scores` / `gen_coupon_code` / `issue_coupons` / `preview_coupon_discount` / `redeem_coupon` / `cancel_coupon_issue` / `purchase_package` / `redeem_package` / `reverse_package_redemption` / `refund_package` / `generate_referral_code` / `register_referral` / `publish_campaign` |
| 06 | `create_insurance_claim_pack` / `update_insurance_claim_pack_items` / `transition_insurance_claim_pack` / `create_insurance_claim_export` / `create_signature_request` / `transition_signature_request` / `record_signature_event` |
| 08 | `portal_create_otp_challenge` / `portal_verify_otp` / `create_portal_appointment` / `apply_provider_event` |

各 RPC 的 revoke public/anon/authenticated + grant service_role 已在对应 migration 落地（Agent-09 已逐段核对签名一致）。运行 `scripts/runtime-rpc-acl-check.ts` 动态验证全部 170 个函数。

## 4. Permissions（新增权限码，均已在各自 migration INSERT permissions + 角色数组）

```text
wallet.view / wallet.recharge / wallet.adjust / wallet.freeze
medication_safety.view / medication_safety.manage / medication_safety.override
crm.segment.view / crm.segment.manage / crm.churn.view
marketing.view / marketing.manage / marketing.adjust_entitlement / marketing.publish
insurance.view / insurance.generate
documents.pdf.generate / documents.archive.view / documents.signature.manage
purchase_request.create / purchase_request.submit / purchase_request.approve / purchase_request.convert
purchase_return.create / purchase_return.submit / purchase_return.approve / purchase_return.post
imports.employee.execute / imports.opening_stock.execute / imports.execute
portal.identity.view / portal.identity.manage / portal.pet.access.view / portal.pet.access.manage
portal.consent.view / portal.subscription.view / portal.webhook.view
messaging.*（细粒度，兼容 message.manage；requireAnyScopedPermission 任一命中）
```

## 5. API 路由（已挂载，注意顺序）

```text
/api/inventory/purchase-requests        （先于 /inventory 具体路由）
/api/inventory/purchase-returns
/api/import-consumers
/api/messaging/webhook                  （先于 /messaging，避免动态路由吞具体路由）
/api/messaging
/api/wallet
/api/medication-safety
/api/crm-growth
/api/marketing
/api/insurance
/api/document-artifacts
/api/portal（C 端无员工鉴权 / admin 走员工 IAM）
```

## 6. Critical runtime cases（必须逐一验证）

1. **钱包 ↔ 计费原子性**（migration 203）：`process_payment`（stored_value 扣减 + payment insert）同一事务；失败整体回滚；幂等重试；退款对称。手工 SQL 或 E2E 断言余额与流水一致。
2. **用药安全服务端 hook**（211）：`issue_prescription` / `dispense_prescription` 命中禁忌/超量规则 → 阻塞；`override_medication_safety_check` 需 `medication_safety.override` + reason + audit 落库。
3. **采购退货写库存**（251）：`purchase_return.post` → `inventory_movements` 负数入账；幂等（重复 post 拒绝）；批次与 warehouse scope 正确。
4. **门户预约**（266 + 285）：`create_portal_appointment` 以 `source='customer_portal'` 插入 appointments —— 285 修复后必须成功（修复前 CHECK violation）；`Idempotency-Key` 重复提交返回原结果。
5. **门户 OTP**（265）：`portal_create_otp_challenge`（60s 速率限制）/ `portal_verify_otp`（hash 校验 + 一次性 + 过期）；生产未配置 Provider 返回 PROVIDER_NOT_CONFIGURED。
6. **Portal 会话隔离**：C 端 token 无法访问 `/portal/admin/*`；员工 token 无法访问 C 端业务（分离鉴权）。
7. **Webhook 收件**（267）：`apply_provider_event` 幂等 + CAS 状态推进；验签失败 401；未配置渠道 503。
8. **权限矩阵**：`supabase/tests/stage04_rls_matrix.sql`（Agent-01 M1~M11）对 Stage-04 新表逐角色验证。
9. **RPC ACL**：`scripts/runtime-rpc-acl-check.ts` 动态校验 170 个 manifest 函数均为 service-role-only。
10. **前端菜单权限**：营销增长 / 客户门户 / 钱包 / 用药安全 / 保险 / 采购请求与退货 / 导入消费者，按角色登录验证可见性。

## 7. Required env（staging）

```text
DATABASE_URL / STAGING_DATABASE_URL
SUPABASE_SERVICE_ROLE_KEY / VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
RUNTIME_DB_MODE（local | staging-reset | upgrade-rehearsal）
ALLOW_DESTRUCTIVE_DB_RESET=YES（仅 staging）
E2E_USERNAME / E2E_PASSWORD
消息 Provider 凭据（Email/SMS；未配置时 Portal OTP / Messaging 发送拒绝，不影响其余模块）
R2（文件/文档归档）—— 仅文档/PDF 模块需要
```

## 8. Fixtures

- `scripts/seed-demo-data.mjs`（已扩展：回访任务 24 条 + `source_id` 关联，供 CRM/回访演示）。
- `supabase/seed.sql`：系统角色与既有权限目录（Stage-04 新权限在各自 migration 内 seed，不依赖 seed.sql）。
- 新建：储值账户、药典/规则、分层/流失、券/套餐/活动、保险理赔包、采购请求/退货、门户身份（验证码 hash）——建议按 Agent 的 migration 注释构造 fixture。

## 9. Known risks

- 285 是唯一跨 Agent 的 Forward Fix；若实际库已有其它 `appointments.source` 值（非四个枚举），drop+add 会失败 → 验证前先 `select distinct source from appointments`。
- Marketing/CRM 真源约束：Segment = Audience 真源，禁止 Marketing 侧再建第二套 Audience Engine。
- Import Consumer（employee/opening-stock）的 `awaiting_domain_apply` 终态 Consumer 未实现（P1-06），入口已由 `IMPORT_TYPES_ENABLED` 隐藏；不要放开入口，直到 Consumer 完成。
- `check:rpc-manifest` 当前静态口径 170 个函数 / missing 0（本批次未重跑脚本，Agent-01 在 staging 阶段执行 `pnpm check:rpc-manifest` 确认）。
- 所有 Stage-04 行为未在真实 DB 执行过，任何 RPC 签名/RLS 细节以 migration 为准（manifest 与 migration revoke 已静态对齐）。
