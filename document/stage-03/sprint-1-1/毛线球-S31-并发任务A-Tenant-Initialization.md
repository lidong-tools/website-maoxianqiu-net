# 毛线球 Stage-03 / S3.1 并发任务 A
## Tenant Initialization（租户初始化）

> 角色：开发员工 A  
> 目标：完成“新医院创建后即可进入可营业状态”的租户初始化闭环。  
> 完成状态只能写 `code_complete / integration_pending`。

## 1. 任务边界
只负责：Tenant、First Store、tenant_owner、默认角色/权限、默认仓库、默认收银/支付上下文、基础字典、打印配置、初始化状态、失败恢复/幂等、审计、API/UI、测试。

不要开发：日结、对账、护士任务、检验、住院、Audit UI、Follow-up、C端、会员、营销、AI。

## 2. Migration
独占 `35~38`，禁止修改 `01~34`，禁止使用 `39+`。

## 3. 核心流程
`Create Tenant → First Store → Tenant Owner → Default Roles → Default Warehouse → Default Cashier / Payment Context → Base Dictionaries → Print Settings → Audit → Initialization Completed`

## 4. 初始化状态
建议：`pending / running / completed / failed`。

必须：幂等、可恢复、同一 tenant 同时仅一个 active initialization。

## 5. tenant_owner
必须是：`role.scope=tenant`、`employee_role_assignments.store_id=NULL`。不得用 `system_admin` 替代。

## 6. 默认资源
至少创建：active 默认仓库；cash/card/wechat/alipay/other 支付上下文；Pilot 必需字典；58mm/80mm/A4 默认打印设置。

当前中国大陆 Pilot：`timezone = Asia/Shanghai`。

## 7. Transaction / Workflow
优先：`Browser → Hono → service role → initialize_tenant() RPC`。

如果 Auth/外部资源不能单事务，必须设计 resumable workflow。禁止前端串多个 API 冒充事务。

## 8. Idempotency
重复请求不得重复创建：tenant/store/warehouse/owner role/payment method。

## 9. 权限与审计
必要时增加：`tenant.initialize`、`tenant.initialization.read`。

审计至少：start/complete/fail/retry。

## 10. 测试
至少覆盖：fresh success、重复初始化、失败恢复、tenant_owner、默认仓库、支付上下文、打印配置、tenant A/B 隔离。

建议测试：`tenant_initialization_s3_1.sql`。

## 11. Shared Files
`service-rpc-manifest.ts`、router/menu、permission seed、components.d.ts 仅最小 append。

不要修改：`IMPLEMENTATION_STATUS.md`、`KNOWN_GAPS.md`、`RELEASE_CHECKLIST.md`。

## 12. 完成标准
`Tenant Initialization = code_complete`，`runtime = integration_pending`。

必须满足：幂等、可恢复、tenant_owner 正确、默认 store/warehouse/payment/config 完整、无跨 tenant、RPC manifest 无遗漏。

## 13. 交付
提交：branch、HEAD SHA、commit list、实际使用 migrations 35~38、schema、RPC/API、UI、permissions、audit、tests、manifest/lint/typecheck/build 原始输出、known issues、CONFLICT_PRONE_FILES。

完成后停止，不进入下一任务。
