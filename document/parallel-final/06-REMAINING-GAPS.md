# 06 — REMAINING GAPS

> S3.1 并行批次剩余缺口(Agent-07 收口)

## Runtime / Staging 依赖(发布前必须验证)

| 项 | 说明 |
| --- | --- |
| migration 空库/旧库升级 | 0→91 顺序应用未在真实 DB 演练;建议 `supabase db push` + dry-run |
| RLS/RPC SQL 断言 | 新模块 RLS/RPC 无独立可执行 SQL 测试(`supabase/tests/**`),仅静态检查 |
| 多角色授权矩阵 | store_manager/doctor/nurse/cashier 未逐角色 staging 实测 |
| E2E Runtime | 独立 E2E 线未结束(见 07-E2E-HANDOFF) |

## P1(发布后尽快)

- **会员储值钱包**:本轮仅保留 `stored_value` 支付方式枚举,未建真实储值账户(AGENT-02 已知边界)。
- **采购退货**:仅预留字段设计(received_qty/批次),未做退货单据(AGENT-05 已知边界)。
- **折扣规则表单**:项目 UUID 直填而非 Product 选择器(AGENT-02 已知边界,功能完整可后续优化)。
- **seed.sql 角色权限数组缺口**:`tenant_owner` 数组缺本批权限;运行时依赖 `role_permissions` 关联表兜底。
- **寄养/住院房态看板合并展示**:当前分离(AGENT-06 可选)。

## P2(优化)

- 平台租户列表一次性拉全量 + 前端过滤,租户量大需后端分页/筛选。
- 影像附件 category 白名单(支持图片,PDF/外院报告待补充)。
- `lab-workbench`「先取 500 再 JS 过滤」MVP,数据量大需 DB 侧聚合。

## 已知边界(设计内)

- 回访负责人无 self-scope(有 followup.view 即当前 Store 全部,MVP 约定)。
- 平台租户管理仅 `platform_admin` 可操作(`platform_support/auditor` 未纳入)。
- `boarding_service_charges.catalog_item_id` 依赖管理员先在 Catalog 创建 type=boarding 目录项。
