# 毛线球 Stage-03 / S3.1 并发任务 B
## Daily Closing + Reconciliation（日结与对账）

> 角色：开发员工 B  
> 目标：完成门店每日经营结算与支付渠道对账闭环。  
> 完成状态只能写 `code_complete / integration_pending`。

## 1. 任务边界
只负责：Daily Closing、Closing Snapshot、Closing Adjustment、Reconciliation、Payment Channel Summary、Difference Confirmation、Audit、API/UI/SQL tests。

不要开发：Tenant Initialization、医疗闭环、Audit UI、Follow-up、支付网关、会员/C端/AI。

## 2. Migration
独占 `39~43`。禁止修改 `01~38` 和使用 `44+`。

## 3. Daily Closing
建议 `daily_closings` 包含：tenant_id、store_id、business_date、status、gross_amount、paid_amount、refund_amount、receivable_amount、cash/card/wechat/alipay/stored_value/other_amount、snapshot、closed_by、时间字段。

状态建议：`open / calculating / closed / adjusted`。

硬规则：`tenant + store + business_date` 只能有一个正式 closing。

## 4. Snapshot
必须固化：invoice count、gross、paid、refund、receivable、payment method breakdown、adjustment summary。

关闭后历史读取 snapshot，不重新实时计算覆盖历史。

## 5. 金额
基于真实 invoices/payments/refunds；数据库 numeric 为账务真值，不用 JS float 做最终计算。

业务日期按 `Asia/Shanghai`。

## 6. Command
建议：`close_daily_business`、`adjust_daily_closing`、`save_reconciliation_actual`、`confirm_reconciliation`。

全部走：`Browser → Hono → permission → service role → transactional RPC`，必须幂等/并发安全。

## 7. Reconciliation
建议表 `reconciliation_records`，包含：channel、system_expected、actual_amount、difference、difference_reason、status、confirmed_by/at。

第一版允许系统账面金额 vs 人工录入实际金额，不接真实支付网关。

## 8. 权限
至少：`daily_closing.read/close/adjust`、`reconciliation.read/edit/confirm`。

cashier 只读；store_manager 可 close/confirm；tenant_owner 全门店。doctor 默认不得获得财务管理权限。

## 9. 审计
记录：close、adjust、actual_update、confirm；difference 确认必须有 reason、actor、timestamp、request_id。

## 10. 测试
覆盖：单店单日唯一、A/B 店隔离、tenant_owner 全店、重复/并发 close、payment/refund/partial payment/receivable、多渠道、adjustment、matched/difference、重复 confirm。

建议：`daily_closing_s3_1.sql`、`reconciliation_s3_1.sql`。

## 11. Shared Files
manifest、router/menu、permission seed 仅 append。不要改 current docs。

## 12. 完成标准
`Daily Closing = code_complete`、`Reconciliation = code_complete`、`runtime = integration_pending`。

必须：金额来源明确、snapshot 固化、关闭后不可覆写、adjustment 独立、差异可追溯、并发/重复安全、tenant/store scope 正确。

## 13. 交付
branch、HEAD SHA、commits、migrations 39~43、schema、RPC/API、UI、permissions、audit、tests、manifest/lint/typecheck/build 原始输出、known issues、CONFLICT_PRONE_FILES。

完成后停止。
