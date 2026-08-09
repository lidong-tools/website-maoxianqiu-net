# AGENT-07-HANDOFF — Supply Chain (Purchase Request / Purchase Return) & Import Consumers

## STATUS

```text
code_complete
（未执行 tsc / vercel build / supabase db push：按任务约定跳过耗时编译与 DB 迁移执行；
 静态自查 git diff --check 已执行，见 TEST_RESULTS）
```

## SOURCE_RESEARCH

```text
1. api/index.ts 为共享冻结入口，Agent-07 不得直接修改 → 路由挂载见 INTEGRATION_REQUESTS
2. 库存真源唯一：inventory_balances + inventory_batches + inventory_movements(不可变流水)；
   采购/退货过账一律走 Hono Command + PostgreSQL RPC，禁止前端直连改余额
3. 既有 PO 全生命周期(create/draft/submit/approve/receive/post)在 api/routes/inventory.ts 已闭环，
   Agent-07 不重写 PO；采购申请转换 PO 在 PL/pgSQL 内直接调用既有 create_purchase_order RPC(同库函数)
4. 幂等机制：Idempotency-Key header + idempotency_records 表 + SELECT ... FOR UPDATE 行锁，
   post_goods_receipt / post_purchase_order 已实现，采购退货过账复用同语义
5. Import V2(import_center_v2, migration 100)命令队列终态为 awaiting_domain_apply，
   executeEmployee 写 employee_invite_imports(status=pending)、executeOpeningStock 写
   opening_stock_import_requests(status=pending)——本 Agent 实现对应 Consumer 消费收口
6. 员工创建必须经 IAM 域：api/routes/employees.ts /invite 模式 =
   service.auth.admin.createUser(email_confirm:true) → invite_employee RPC → 失败补偿删除 auth 用户
7. 期初库存入账复用 post_goods_receipt 语义：建批次 → 增余额 → 写 receive 流水(reference_type='opening_stock_import')
8. 权限码体系：permissions 表 + role_permissions，requireScopedPermission 单码门店作用域；
   service-rpc-manifest.ts 为高危 RPC 白名单，新增 RPC 必须同步注册 + migration revoke 块
9. Migration 号段确认：Agent-03 用 200~203、Agent-04 用 210~211、Agent-05 用 220~223、
   Agent-06 用 235、Agent-08 用 265~267；Agent-07 使用 250~252 无冲突
```

## START_HEAD

```text
1bb3a079 chore(stage04-02): harden production release and api runtime guard
```

## COMMIT_SHA

（提交后回填，见本次 git log）

## OWNED_FILES

```text
supabase/migrations/20260810000250_purchase_request.sql       （新增，采购申请全链路）
supabase/migrations/20260810000251_purchase_return.sql        （新增，采购退货全链路 + 库存过账）
supabase/migrations/20260810000252_import_consumers.sql       （新增，Import Consumer 命令收口）
api/routes/purchase-requests.ts                               （新增，采购申请 Hono 路由）
api/routes/purchase-returns.ts                                （新增，采购退货 Hono 路由）
api/routes/import-consumers.ts                                （新增，Import Consumer 路由 + Job 收口）
api/services/import-consumers/employee.ts                     （新增，员工导入 Consumer）
api/services/import-consumers/opening-stock.ts                （新增，期初库存 Consumer）
apps/maoxianqiu/src/views/inventory/purchase-requests/index.vue （新增，采购申请页面）
apps/maoxianqiu/src/views/inventory/purchase-returns/index.vue  （新增，采购退货页面）
document/stage-04/handoff/AGENT-07-HANDOFF.md                 （新增，本文件）
```

## MODIFIED_EXISTING_FILES

```text
api/lib/service-rpc-manifest.ts         追加 14 个 service-role-only RPC(见 NEW_RPCS)
apps/maoxianqiu/src/types/inventory.ts  追加 PurchaseRequest/PurchaseReturn 类型与权限常量
apps/maoxianqiu/src/api/modules/inventory.ts  追加采购申请/采购退货 API 函数与行类型
apps/maoxianqiu/src/types/imports.ts    IMPORT_TYPES_ENABLED 启用 employee / opening-stock
apps/maoxianqiu/src/router/modules/inventory.ts  追加 /inventory/purchase-requests、/inventory/purchase-returns 路由
```

## NEW_FILES

```text
supabase/migrations/20260810000250_purchase_request.sql
supabase/migrations/20260810000251_purchase_return.sql
supabase/migrations/20260810000252_import_consumers.sql
api/routes/purchase-requests.ts
api/routes/purchase-returns.ts
api/routes/import-consumers.ts
api/services/import-consumers/employee.ts
api/services/import-consumers/opening-stock.ts
apps/maoxianqiu/src/views/inventory/purchase-requests/index.vue
apps/maoxianqiu/src/views/inventory/purchase-returns/index.vue
document/stage-04/handoff/AGENT-07-HANDOFF.md
```

## MIGRATIONS

```text
20260810000250_purchase_request.sql
20260810000251_purchase_return.sql
20260810000252_import_consumers.sql
（按号段顺序执行；均幂等 create if not exists / create or replace；
 20260810000250 对 purchase_orders 仅加列 source_request_id(if not exists)）
```

## NEW_TABLES

```text
purchase_requests         采购申请主表(tenant/store/warehouse/supplier, request_no 业务号,
                          状态机 draft→submitted→approved→converted_to_po / rejected / cancelled,
                          version 乐观锁, converted_po_id 溯源)
purchase_request_items    采购申请明细(catalog_item_id / requested_qty / estimated_unit_cost / note)
purchase_returns          采购退货主表(tenant/store/warehouse/supplier, source_po_id 溯源,
                          return_amount_snapshot 金额快照,
                          状态机 draft→submitted→approved→posted / cancelled, version 乐观锁)
purchase_return_items     采购退货明细(batch_id / source_po_item_id / quantity / unit_cost / amount)
```

## NEW_COLUMNS

```text
purchase_orders.source_request_id          采购单来源申请(uuid,可空,if not exists 前向迁移)
employee_invite_imports.employee_id / invited_user_id / applied_at / processing_at /
                            error_code / error_message          Consumer 消费结果回写
opening_stock_import_requests.batch_id / movement_id / applied_at / processing_at / error_code
```

## NEW_INDEXES

```text
idx_purchase_requests_tenant_store / tenant_status_created(列表排序)
idx_purchase_request_items_request
idx_purchase_returns_tenant_store / tenant_status_created
idx_purchase_return_items_return
idx_employee_invite_imports_tenant_status(消费队列扫描)
idx_opening_stock_import_requests_tenant_status(消费队列扫描)
```

## NEW_RPCS

```text
create_purchase_request(uuid, uuid, uuid, uuid, uuid, text, timestamptz, jsonb, uuid)
  → 创建申请草稿,生成 request_no 'PR'+日期+序列,校验明细非空
update_purchase_request_draft(...) → 仅 draft 可编辑,替换全部明细(version 乐观锁)
submit_purchase_request(uuid, uuid, uuid)      → draft → submitted(校验 EMPTY_ITEMS)
approve_purchase_request(uuid, uuid, uuid)     → submitted → approved(禁止自审 SELF_APPROVAL_FORBIDDEN)
reject_purchase_request(uuid, uuid, uuid, text) → submitted → rejected
cancel_purchase_request(uuid, uuid, uuid)      → draft/submitted → cancelled
convert_purchase_request_to_po(uuid, uuid, uuid) → approved → converted_to_po;
   同库调用 create_purchase_order 生成 PO 草稿 + 回写 purchase_orders.source_request_id;
   幂等:已转换直接返回同一 PO(idempotent=true);转换必须已指定供应商(SUPPLIER_REQUIRED_FOR_CONVERT)
create_purchase_return(uuid, uuid, uuid, uuid, uuid, uuid, text, jsonb, uuid)
  → 创建退货草稿,生成 return_no 'RN'+日期+序列,计算 return_amount_snapshot
update_purchase_return_draft(...) → 仅 draft 可编辑,替换全部明细
submit_purchase_return(uuid, uuid, uuid)       → draft → submitted
approve_purchase_return(uuid, uuid, uuid)      → submitted → approved
cancel_purchase_return(uuid, uuid, uuid)       → draft/submitted → cancelled
post_purchase_return(uuid, uuid, uuid, uuid, text)
  → approved → posted;事务:SELECT batch FOR UPDATE → 校验 quantity_remaining >= quantity →
    扣批次 / 扣余额(on conflict update 负数累加)→ 写不可变流水 movement_type='return'(负数,
    reference_type='purchase_return')→ 标记 posted;幂等键 p_idempotency_key || ':' || item_id 防重放
apply_opening_stock_import(uuid, uuid)
  → 期初入账正式 Command;SELECT ... FOR UPDATE 锁请求行 → 校验 status=processing →
    建批次 → 增余额 → 写 receive 流水(reference_type='opening_stock_import',
    幂等键 'opening_import:' || request_id)→ 标记 applied;幂等:已 applied 直接返回原结果
```

## RPC_ACL

```text
全部 16 个 RPC 均:revoke public / anon / authenticated → grant service_role
（已在各自 migration 的 revoke/grant 块完成，并在 api/lib/service-rpc-manifest.ts 注册）
```

## PERMISSIONS

```text
migration 250: purchase_request.view / create / submit / approve / convert
migration 251: purchase_return.view / create / submit / approve / post
migration 252: imports.employee.execute / imports.opening_stock.execute
以上均授予 system_admin + store_manager(insert into role_permissions select ... from roles where code in (...))
```

## API_ROUTES

```text
POST /inventory/purchase-requests                  创建申请(权限 purchase_request.create)
POST /inventory/purchase-requests/draft            编辑草稿(权限 purchase_request.create)
POST /inventory/purchase-requests/submit           提交(权限 purchase_request.submit)
POST /inventory/purchase-requests/approve          审核(权限 purchase_request.approve)
POST /inventory/purchase-requests/reject           驳回(权限 purchase_request.approve)
POST /inventory/purchase-requests/cancel           取消(权限 purchase_request.create)
POST /inventory/purchase-requests/convert          转换为采购单(权限 purchase_request.convert)
POST /inventory/purchase-returns                   创建退货(权限 purchase_return.create)
POST /inventory/purchase-returns/draft             编辑草稿(权限 purchase_return.create)
POST /inventory/purchase-returns/submit            提交(权限 purchase_return.submit)
POST /inventory/purchase-returns/approve           审核(权限 purchase_return.approve)
POST /inventory/purchase-returns/cancel            取消(权限 purchase_return.create)
POST /inventory/purchase-returns/post              过账扣库存(权限 purchase_return.post,须 idempotency-key)
POST /import-consumers/employee/apply              批量消费员工邀请(权限 imports.employee.execute)
POST /import-consumers/employee/:id/retry          重试失败邀请(权限 imports.employee.execute)
POST /import-consumers/opening-stock/apply         批量消费期初入账(权限 imports.opening_stock.execute)
POST /import-consumers/opening-stock/:id/retry     重试失败期初命令(权限 imports.opening_stock.execute)
POST /import-consumers/jobs/:jobId/apply-domain    消费 Job 并收口终态(权限 imports.execute)
```

## INTEGRATION_REQUESTS

```text
请求 Agent-09(Final Integrator)在 api/index.ts 追加挂载:
  import purchaseRequestRoutes from './routes/purchase-requests.js'
  import purchaseReturnRoutes from './routes/purchase-returns.js'
  import importConsumerRoutes from './routes/import-consumers.js'
  app.route('/inventory/purchase-requests', purchaseRequestRoutes)
  app.route('/inventory/purchase-returns', purchaseReturnRoutes)
  app.route('/import-consumers', importConsumerRoutes)
说明:前端模块 api/modules/inventory.ts 已按上述路径请求;
页面路由已在 apps/maoxianqiu/src/router/modules/inventory.ts 注册(菜单自动出现)。
```

## CONTRACTS

```text
PURCHASE_REQUEST_TO_PO_CONTRACT:
  convert_purchase_request_to_po 在 PL/pgSQL 内直接调用既有 public.create_purchase_order RPC
  (同库函数调用,非 HTTP),生成 PO 草稿;purchase_orders.source_request_id 回写溯源;
  幂等:converted_to_po 后重复调用返回同一 PO(idempotent=true),不重复建单。

RETURN_INVENTORY_MOVEMENT_TYPE:
  采购退货过账写入 inventory_movements.movement_type='return'(负数流水),
  语义:扣批次 quantity_remaining + 扣余额 quantity_on_hand(负数 on conflict update 累加)。
  复用既有 return 类型(20260806000017_inventory.sql 已定义),无需新增 movement_type。

RETURN_FINANCE_BOUNDARY:
  采购退货仅记录 return_amount_snapshot(金额快照) + 供应商 + source_po_id 溯源,
  不引入总账/应收账款;财务入账留待 Finance 阶段(DEFERRED)。

EMPLOYEE_CONSUMER_DOMAIN_CALL:
  员工导入 Consumer 必须经 IAM 域:service.auth.admin.createUser(email_confirm:true,
  随机初始密码) → invite_employee RPC;失败补偿 service.auth.admin.deleteUser 删除刚建账号,
  避免孤立 auth 用户;不直接写 auth.users 或 employees。

OPENING_STOCK_COMMAND:
  期初库存入账复用 post_goods_receipt 语义(建批次 → 增余额 → 写 receive 流水),
  通过 apply_opening_stock_import RPC 在单个事务内完成,reference_type='opening_stock_import';
  禁止绕过 RPC 直接改 inventory_balances。

IMPORT_TERMINAL_STATE_RULE:
  领域命令消费后收口 import_jobs:全部 applied → completed;有成功有失败 →
  partially_completed(20260810000252 扩展 status 约束);全失败 → failed;
  仍有 pending → 保持 awaiting_domain_apply(可再次触发,幂等)。
```

## KNOWN_GAPS

```text
1. 采购退货过账不区分批次效期(按选定 batch 直接扣减);FEFO 过期校验留待后续阶段
2. 采购退货退货金额不触发任何财务/应付动作(见 RETURN_FINANCE_BOUNDARY,DEFERRED)
3. 员工导入仅分配单一角色 + 主门店;多门店/多角色分配留待后续阶段(DEFERRED,
   employee_invite_imports.store_codes 数组已保留,仅取首个)
4. Import Consumer 为同步执行(limit 上限 500),超大任务建议后续迁移到异步 Worker(DEFERRED)
5. purchase_request 转换 PO 后,PO 明细单价取申请明细 estimated_unit_cost;实际采购价调整
   仍在 PO 草稿阶段手工编辑(DEFERRED 自动同步)
```

## TEST_RESULTS

```text
静态自查:
  git diff --check 无空白错误
  未执行 tsc / build / supabase db push(任务约定跳过耗时步骤)
建议 Agent-09 集成后补充:
  - supabase db reset 后执行 stage04_rls_matrix / 手工冒烟
  - 采购申请: 创建→提交→审核→转换→PO 详情核对 source_request_id
  - 采购退货: 创建→提交→审核→过账(带 idempotency-key)→inventory_movements 出现 return 流水
  - Import: employee 导入启动→/import-consumers/employee/apply→employee 存在且 auth 用户可登录
  - Import: opening-stock 导入启动→/import-consumers/opening-stock/apply→余额/批次/流水正确
  - 重复过账:同一 idempotency-key 二次请求仅一次入账
```
