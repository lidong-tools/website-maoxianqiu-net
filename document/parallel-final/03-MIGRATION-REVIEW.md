# 03 — MIGRATION REVIEW

> S3.1 并发批次 migration 审计(Agent-07)

## 1. 编号分配与冲突

| Agent | 预留 | 实际使用 | 文件 |
| --- | --- | --- | --- |
| Agent-01 | 54–55 | 54 | `20260810000054_platform_tenant_mgmt.sql` |
| Agent-02 | 56–58 | 56/57 | `20260810000056_membership_discount_rules.sql`、`20260810000057_membership_billing_integration.sql` |
| Agent-03 | 59–61 | 59~61 | `20260810000059_imaging_orders.sql`、`...60_imaging_permissions.sql`、`...61_imaging_report_publish_rpc.sql` |
| Agent-04 | 62–64 | 62/63 | `20260810000062_followup_tasks.sql`、`...63_followup_permissions.sql` |
| Agent-05 | 65–69 | 65~69 | `...65_suppliers.sql`、`...66_purchase_orders.sql`、`...67_purchase_lifecycle_rpc.sql`、`...68_purchase_receive_rpc.sql`、`...69_purchase_post_rpc.sql` |
| Agent-06 | 70–73 | 70~73 | `...70_boarding_cage_type_and_permissions.sql`、`...71_boarding_stays.sql`、`...72_boarding_daily_records.sql`、`...73_boarding_service_charges.sql` |
| Agent-07 | 90–99 | 90/91 | `...90_rpc_manifest_reconciliation.sql`、`...91_boarding_checkout_billing.sql` |

- ✅ 无编号冲突;未使用槽位(55/58/64)保留。
- ✅ 未编辑历史 migration(仅新增文件);P0 迁移 `09000054~57`(settings/approval/search 权限)为上一收口轮新增,未改动。

## 2. 顺序应用可行性

按编号升序可空库应用:
- 前置依赖均满足:`touch_updated_at`(000015)、`post_goods_receipt`(000017)、`get_effective_setting`(09055)、`is_tenant_member/can_access_store/has_permission`(000010)、`create_invoice`(00020 → 09055 → 57)。
- 跨迁移引用(boarding_service_charges.catalog_item_id、boarding_stays.customer/pet)在应用时仅列不加 FK,不阻塞。

## 3. RPC 权限一致性

- Agent-06(migration 73)已用 DO 块将 boarding RPC 收紧为 service_role-only ✅。
- Agent-02/03/05 提交的 RPC 使用了旧 `grant authenticated` 模式且未登记 manifest → **Integrator 修复**:`migration 90` 统一 revoke public/anon/authenticated + grant service_role;`manifest` 补 9 个函数名。
- `check:rpc-manifest` → PASS(115 处调用 / 116 个函数 / missing 0)。

## 4. RLS / 索引

- 新表均启用 RLS + 合理索引 + tenant_id/store_id 约束(逐表核对应 Handoff §Migration)。
- 租户停用拦截:Agent-01 迁移 54 让 `is_tenant_member/can_access_store/has_permission` 对 `status != active` 租户返回 false(浏览器直连路径也被拦截);平台管理员由 `is_system_admin()` 短路放行。

## 5. 待 staging 验证

- migration 空库 0→91 与旧库升级演练(本地未执行 `db:push`)。
- RLS/RPC SQL 断言(`supabase/tests/**`)在 staging 执行。
