# AGENT-03-HANDOFF — Wallet / Stored Value(储值钱包)

> 编写:Agent-03
> 时间:2026-08-09
> 说明:储值账户体系(账户/充值/赠送/消费/退款返还/人工调整/冻结/不可变流水/收银集成)交付完成;按任务约定跳过 tsc/vue-tsc/eslint/vite build 等耗时检查;实库验证由 Agent-01 Runtime Gate / 发布流程执行。

## STATUS

```text
code_complete
(未执行编译/语法检查:按用户指令跳过耗时检查;SQL 测试脚本经静态推演,实库执行留待 Runtime Gate)
```

## SOURCE_RESEARCH

当前 main(非 Source13)已确认事实:

```text
1. customers.balance(migration 15)是 CRM 历史兼容字段,无 ledger/幂等/冻结模型 → 不作为储值真源;
   储值真源 = 新建 stored_value_accounts(快照)+ stored_value_ledger(审计真相)
2. process_payment/process_refund 为 service-role-only 的 SECURITY DEFINER RPC(billing.sql 原版 +
   migration 92 统一收紧),签名 (uuid, numeric, text, uuid, text, text) / (uuid, numeric, text, uuid, text, uuid)
3. create_invoice 存在 12 参数(20/55)与 13 参数(57, 含 p_apply_membership_discount)两个重载;
   测试必须以命名参数调用消除歧义
4. confirm_invoice 返回 public.invoices 行类型(非 jsonb),接收变量须声明为 invoices 行
5. idempotency_records(migration 09)字段:tenant_id/idempotency_key/action/entity_type/entity_id/
   result_json,unique(tenant_id, idempotency_key) → RPC 幂等写入合法
6. payments/refunds 表:idempotency_key 为 NOT NULL,method 约束原值不含 stored_value
   → migration 203 必须 drop+add 约束(Forward Migration,禁改历史 migration)
7. payment_contexts(migration 35)唯一约束 (tenant_id, store_id, method) → 补插/ensure 用 on conflict 匹配
8. RLS 权限模型(migration 93):has_permission(scope 感知)/is_tenant_member/auth.uid() 读 jwt sub
9. service-rpc-manifest.ts 导出 SERVICE_ROLE_ONLY_RPC,Agent-01 runtime gate 动态读取
```

## START_HEAD

```text
f3254ff9 test(stage04-01): establish runtime db e2e and manual uat gate
(Agent-03 开发起点;开发期间 Agent-01/02 已先行提交)
```

## COMMIT_SHA

```text
(提交后回填,见提交记录)
```

## OWNED_FILES

```text
supabase/migrations/20260810000200_stored_value_accounts.sql
supabase/migrations/20260810000201_stored_value_ledger.sql
supabase/migrations/20260810000202_stored_value_rpc.sql
supabase/migrations/20260810000203_stored_value_billing_integration.sql
api/routes/wallet.ts
apps/maoxianqiu/src/types/wallet.ts
apps/maoxianqiu/src/api/modules/wallet.ts
apps/maoxianqiu/src/views/operations/wallet/index.vue
supabase/tests/wallet_stored_value_s3_1.sql
document/stage-04/handoff/AGENT-03-HANDOFF.md(本文件)
```

## MODIFIED_EXISTING_FILES

```text
api/lib/service-rpc-manifest.ts     追加 5 个 wallet RPC 登记(并发:Agent-05 crm-growth 登记同文件,已保持数组闭合)
api/routes/billing.ts               paymentMethod/method z.enum 加 'stored_value' + mapRpcError 增 WALLET_*/INVOICE_NO_CUSTOMER 映射
api/routes/settings.ts              paymentContextSchema.method z.enum 加 'stored_value'
apps/maoxianqiu/src/types/billing.ts        PaymentMethod 联合类型加 'stored_value' + PAYMENT_METHOD_LABELS.stored_value
apps/maoxianqiu/src/router/modules/operations.ts  追加 /operations/wallet 路由(auth: wallet.view)
apps/maoxianqiu/src/views/billing/cashier/index.vue  储值支付余额加载/预览/校验/提交/UI 面板
```

## NEW_FILES

```text
api/routes/wallet.ts                          Hono 路由(8 端点,wallet.* 权限)
apps/maoxianqiu/src/types/wallet.ts           储值类型 + 标签映射
apps/maoxianqiu/src/api/modules/wallet.ts     API 模块(api.get 查询 / api.post 命令 + 幂等键)
apps/maoxianqiu/src/views/operations/wallet/index.vue  储值账户管理页
supabase/tests/wallet_stored_value_s3_1.sql   单事务 begin/rollback 测试(9 组)
```

## MIGRATIONS

```text
20260810000200_stored_value_accounts.sql        账户表(快照)+ RLS SELECT-only + 表级 revoke DML + wallet.* 权限 seed
20260810000201_stored_value_ledger.sql          不可变流水表 + partial unique(tenant_id, idempotency_key) + 表级 revoke DML(含 service_role)
20260810000202_stored_value_rpc.sql             4 个 service-role-only 领域 RPC(开户/充值/调整/状态)
20260810000203_stored_value_billing_integration.sql  Billing 约束统一 + payment_contexts 补插 +
                                                  ensure_stored_value_payment_context +
                                                  process_payment/process_refund 重定义(stored_value 同事务原子性)
号段:200~203(合规 200-209);未修改任何历史 migration(121 及以前)
```

## NEW_TABLES / NEW_COLUMNS / NEW_INDEXES

```text
NEW_TABLES:
  stored_value_accounts(id/tenant_id/customer_id/currency/balance/status/version/opened_at/closed_at/created_by/created_at/updated_at)
  stored_value_ledger(id/tenant_id/account_id/customer_id/direction/type/amount/balance_before/balance_after/reference_type/reference_id/idempotency_key/operator_id/reason/metadata/created_at)
NEW_INDEXES:
  idx_sva_tenant_customer_currency unique(tenant_id, customer_id, currency)
  idx_sv_ledger_tenant_idem partial unique(tenant_id, idempotency_key) where idempotency_key is not null
  idx_sv_ledger_account_time / idx_sv_ledger_customer_time / idx_sv_ledger_reference
NEW_COLUMNS: 无(不修改既有表结构;仅 drop+add 约束属约束调整,非列)
```

## NEW_RPCS

```text
open_stored_value_account(uuid, uuid, text, uuid, text)                     开户(幂等/归属校验/币种校验)
recharge_stored_value(uuid, numeric, numeric, text, text, text, uuid, text, text)  充值(本金+赠送记账区分/幂等/来源必填)
adjust_stored_value(uuid, numeric, text, uuid, text)                        人工调整(±/reason 必填/余额不为负/幂等)
set_stored_value_account_status(uuid, text, text, uuid)                     冻结/解冻/销户(销户须清零)
ensure_stored_value_payment_context(uuid, uuid, boolean, uuid)              启用/停用门店储值支付方式(幂等 upsert)
重定义(同签名覆盖,ACL 由 92 号收紧 + 203 再次锁定):
  process_payment(uuid, numeric, text, uuid, text, text)                    新增 stored_value 分支(同事务扣 Wallet+写 Payment)
  process_refund(uuid, numeric, text, uuid, text, uuid)                     新增 refundedToWallet 分支(同事务 Wallet credit+写 refunds)
```

## RPC_ACL

```text
全部 service-role-only:
  revoke all on function ... from public / anon / authenticated
  grant execute on function ... to service_role
覆盖函数:open_stored_value_account / recharge_stored_value / adjust_stored_value /
  set_stored_value_account_status / ensure_stored_value_payment_context / process_payment / process_refund
已登记 api/lib/service-rpc-manifest.ts(Agent-01 runtime-rpc-acl-check.ts 会自动覆盖校验)
```

## PERMISSIONS

```text
新增权限码(module=wallet):wallet.view / wallet.recharge / wallet.adjust / wallet.freeze
角色矩阵:
  system_admin / tenant_owner / store_manager:4 个全量
  cashier:仅 wallet.view + wallet.recharge(普通收银不授予人工调账/冻结)
同步 roles.permissions 数组(兼容旧读取)
```

## API_ROUTES

```text
api/routes/wallet.ts(新路由模块,Agent-09 需挂载到 api/index.ts):
  GET  /wallet/accounts                 列表(联客户姓名/手机,keyword/status/分页)   wallet.view
  GET  /wallet/accounts/:id             详情                                        wallet.view
  GET  /wallet/accounts/:id/ledger      流水(不可变,只读)                           wallet.view
  POST /wallet/accounts                 开户                                        wallet.recharge
  POST /wallet/accounts/:id/recharge    充值(本金+赠送)                             wallet.recharge
  POST /wallet/accounts/:id/adjust      人工调整(±,reason 必填)                     wallet.adjust
  POST /wallet/accounts/:id/status      冻结/解冻/销户                              wallet.freeze
  POST /wallet/payment-contexts/ensure  启用/停用储值支付方式                        wallet.recharge
全部端点:requireScopedPermission + writeAudit;命令走 service.rpc(service-role-only)
```

## FRONTEND_ROUTES

```text
/operations/wallet(name: operationsWallet, auth: wallet.view, icon: i-ri:wallet-3-line)
已注册于 apps/maoxianqiu/src/router/modules/operations.ts(非冻结文件)
```

## MENU_REGISTRATION_REQUEST

```text
无额外请求。储值账户菜单随 operations.ts 路由自动生成(菜单源读路由 meta)。
```

## ENV_VARS

```text
无新增环境变量。
收银台余额预览使用浏览器直连 supabase(RLS 租户成员可读 stored_value_accounts),真源校验在服务端。
```

## CROSS_DOMAIN_CONTRACTS

```text
Billing 领域(Agent-01/其他既有实现)契约:
  - process_payment p_method='stored_value' 时要求 invoice.customer_id 非空(INVOICE_NO_CUSTOMER);
  - 原支付方式为 stored_value 的退款自动返还 Wallet(refundedToWallet=true),refunds.payment_id 可定位原支付;
  - payments/invoices/payment_contexts method 约束统一含 stored_value;
收银台集成:apps/maoxianqiu/src/views/billing/cashier/index.vue 在 method=stored_value 时加载余额并校验。
```

## TESTS_RUN

```text
未运行 SQL(需实库,遵循用户指令不执行耗时检查)。
静态推演完成:wallet_stored_value_s3_1.sql 与 migration 200~203 及既有表/函数签名逐一比对:
  - open/recharge/adjust/status/ensure RPC 参数签名与测试调用一致
  - create_invoice 13 参数重载(命名参数消除歧义)/ confirm_invoice 返回 invoices 行
  - idempotency_records 字段匹配 / payments.refunds NOT NULL 幂等键均显式传入
  - RLS 断言修正:表级 revoke 使 authenticated UPDATE/DELETE 抛 permission denied(assert_raises)
  - payment_contexts 唯一约束匹配 on conflict
git diff --check 待提交前执行。
```

## TEST_RESULTS

```text
(git diff --check 提交前执行,PASS 后回填)
```

## KNOWN_GAPS

```text
1. api/index.ts 挂载 walletRoutes 需 Agent-09 集成(见 INTEGRATION_REQUESTS)
2. customers.balance 未双写:CRM 旧余额与储值余额并存,展示口径由各页自我声明(储值以新表为准)
3. 充值仅记账区分本金/赠送,当前不拆分余额(赠送金不可单独冻结/限制,产品后续可扩展 ledger metadata)
4. 手工退款入口未暴露(仅 Billing process_refund 自动返还 Wallet),符合"退款必须回 Wallet"约束
5. wallet_stored_value_s3_1.sql 依赖 DB 真实执行,由 Agent-01 Runtime Gate 阶段运行
```

## DEFERRED

```text
- 实库执行 SQL 测试(待可运行 Supabase 库)
- 收银台储值余额实时刷新推送(当前选择客户/切换方式时拉取,足够)
- 储值账户导出/报表(待后续迭代)
```

## INTEGRATION_REQUESTS

给 Agent-09(Final Integrator):

```text
1. 请在 api/index.ts 挂载 walletRoutes:
     import walletRoutes from './routes/wallet.js'
     app.route('/api/wallet', walletRoutes)
   挂载路径前缀 /api/wallet(路由内部端点以 /accounts 等开头)
2. api/routes/billing.ts / api/routes/settings.ts / api/lib/service-rpc-manifest.ts 为本 Agent
   修改(manifest 与 Agent-05 并发同文件,已确认数组闭合,请复核)
3. 将 wallet 相关端点纳入最终 Release Gate 冒烟清单(GET /api/wallet/accounts 需 wallet.view 权限)
```

给 Agent-01(Runtime/UAT):

```text
1. runtime-rpc-acl-check.ts 已自动覆盖 5 个新 RPC + process_payment/process_refund(manifest 已登记)
2. wallet_stored_value_s3_1.sql 需在含全量 migration 的测试库执行(单事务 rollback,无残留)
3. 测试文件依赖 psql 以超级用户运行(set local role authenticated 需 superuser)
```

## ROLLBACK_NOTES

```text
- 4 个 migration 均为新增高位文件(200~203),回滚 = 删除文件 + 不触发后续依赖;
  process_payment/process_refund 重定义会在删除 203 后恢复为 billing.sql 原版(92 号收紧仍有效)
- 共享文件修改(manifest/billing.ts/settings.ts)回滚需注意 Agent-05 在 manifest 的登记,勿整文件 revert
- 无破坏性数据变更;203 补插 payment_contexts 为幂等 upsert
```

## 完成条件对照

```text
- 储值账户表/流水表 + RLS SELECT-only + 表级 revoke DML(含 service_role):✅ migration 200/201
- service-role-only 领域 RPC + manifest 登记:✅ migration 202 + api/lib/service-rpc-manifest.ts
- 收银原子性:process_payment/process_refund stored_value 同事务扣/返 Wallet:✅ migration 203
- 不可变流水(无 UPDATE/DELETE):✅ 表级 revoke + RLS 无 update/delete 策略
- 幂等(tenant 级):✅ idempotency_records + partial unique(tenant_id, idempotency_key) + ledger key 后缀
- Billing method 约束统一(不只改前端 enum):✅ payments/invoices/payment_contexts 约束 + z.enum + 前端类型
- 权限矩阵:✅ wallet.view/recharge/adjust/freeze(调整/冻结仅管理角色)
- 前端页面/路由/API 模块:✅ views/operations/wallet + api/modules/wallet + router
- 收银台集成:✅ cashier/index.vue(余额预览/校验/UI)
```

提交信息(由本 Agent 执行):

```text
feat(stage04-03): implement transactional stored value wallet
```
