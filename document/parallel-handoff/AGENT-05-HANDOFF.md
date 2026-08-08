> Agent-05 HANDOFF — Inventory + 供应商与采购订单
> 环境说明:所有 Agent 共用同一工作目录与 `main` 分支,本 HANDOFF 按此记录。

# Agent-05 Handoff

## 1. 基础信息

- Base Commit: `d32e862a update`(HEAD)
- 分支:共享 `main` 工作树(未建独立分支,与其他 Agent 同一目录)
- 模块:供应商主数据 + 采购订单全流程(草稿 → 提交 → 审核 → 收货 → 过账入库)
- 状态:开发完成;API 与前端对本 Agent 文件 typecheck 全部通过

## 2. 修改文件

| 文件 | 改动 |
|---|---|
| `api/routes/inventory.ts` | 新增供应商 CRUD(create/update/status)+ 采购订单全部流转路由(create/draft/submit/approve/cancel/receive/post);`mapRpcError` 扩展采购错误码 |
| `apps/maoxianqiu/src/types/inventory.ts` | 新增 Supplier/PurchaseOrder/PurchaseOrderItem 类型 + 状态标签 + SUPPLIER_PERMISSIONS/PURCHASE_PERMISSIONS |
| `apps/maoxianqiu/src/api/modules/inventory.ts` | 新增 listSuppliers/listPurchaseOrders/listPurchaseOrderItems + 供应商与采购 7 个写方法(过账带幂等头) |
| `apps/maoxianqiu/src/router/modules/inventory.ts` | 新增 `/inventory/suppliers`(supplier.view)与 `/inventory/purchasing`(purchase.view) |
| `apps/maoxianqiu/src/views/inventory/suppliers/index.vue` | 新增供应商页:列表 + 详情抽屉(含采购历史)+ 新建/编辑弹窗 + 停用/启用 |
| `apps/maoxianqiu/src/views/inventory/purchasing/index.vue` | 新增采购页:列表 + 新建草稿(明细行编辑)+ 详情抽屉(状态时间线 + 明细表 + 状态流转操作)+ 收货弹窗 |

## 3. Migration(Agent-05 预留 65–69)

| Migration | 内容 |
|---|---|
| `20260810000065_suppliers.sql` | `suppliers` 表(租户级)+ RLS(select 仅 `is_tenant_member`,写仅 service role)+ 权限 supplier.view/manage |
| `20260810000066_purchase_orders.sql` | `purchase_orders` / `purchase_order_items` 表 + po_no 序列 + RLS(select 按 `can_access_store`)+ 权限 purchase.view/create/submit/approve/receive/post |
| `20260810000067_purchase_lifecycle_rpc.sql` | `create_purchase_order` / `update_purchase_order_draft` / `submit_purchase_order` / `approve_purchase_order` / `cancel_purchase_order` |
| `20260810000068_purchase_receive_rpc.sql` | `receive_purchase_order`(记录实收/批次/效期,过账前可调整) |
| `20260810000069_purchase_post_rpc.sql` | `post_purchase_order`:**复用既有 `post_goods_receipt`** 逐明细生成批次/余额/流水,不复制库存算法;幂等 + PO 行锁,posted 后不可改 |

## 4. 新增权限

```text
supplier.view / supplier.manage
purchase.view / purchase.create / purchase.submit
purchase.approve / purchase.receive / purchase.post
```
角色映射:system_admin 与 store_manager 全量(现有角色,未新增角色)。`roles.permissions` 数组与 `role_permissions` 关联表均已同步(RLS `has_permission` 读数组)。

## 5. 新增 API(全部走 Hono Command,service role)

```text
POST /inventory/suppliers             # 新增供应商(生成 SUP 编码,审计)
POST /inventory/suppliers/update      # 更新供应商
POST /inventory/suppliers/status      # 停用/启用
POST /inventory/purchase-orders       # 创建草稿(create_purchase_order RPC)
POST /inventory/purchase-orders/draft # 编辑草稿(update_purchase_order_draft RPC)
POST /inventory/purchase-orders/submit  # 提交(purchase.submit)
POST /inventory/purchase-orders/approve # 审核(purchase.approve)
POST /inventory/purchase-orders/cancel  # 取消(draft/submitted)
POST /inventory/purchase-orders/receive # 收货(approved/received)
POST /inventory/purchase-orders/post    # 过账(post_purchase_order RPC,Idempotency-Key 幂等)
```
查询全部浏览器直连 supabase + RLS(供应商租户级、采购单门店级)。

## 6. 新增 Route

```text
/inventory/suppliers   供应商管理(auth: supplier.view)
/inventory/purchasing  采购管理(auth: purchase.view)
```

## 7. 跨域 Hook

- **采购过账 → 库存**:在 Agent-05 域内完成,复用 `post_goods_receipt`(不动库存 RPC),生成 inventory_batches/balances/movements,`reference_type=goods_receipt`、`reference_id=po_no`。
- **采购审批**:本轮为采购详情内独立审批(purchase.approve)。若未来接入统一 Approval Center,由 Integrator 依据状态机在 `api/routes/approvals.ts` 挂接(本 Agent 未改该文件)。
- 快速入库 `/inventory/receipt` 保留原样,未回归。

## 8. 未完成项 / 已知边界

1. **Full Build 未能在本 Agent 侧通过**:共享工作树中其他 Agent(02/03/04/01/06)在制品存在 TS typecheck 错误
   (`customers.ts`、`search.ts`、`diagnostics.ts`、`operations.ts`、`diagnostics/imaging/index.vue`、`operations/approvals/index.vue`、`system/tenants/*`、`system/store/detail.vue` 等),
   导致整仓 `vue-tsc -b` / `tsc -p api` 非零退出。**本 Agent 文件无 typecheck 错误**;请 Integrator 合并后统一处理。
2. 采购退货仅预留字段设计(received_qty/批次),未做退货单据;不阻塞闭环。
3. 供应商编码由应用层生成(`SUP-YYYYMMDD-随机6位`),唯一索引兜底;极端并发下 23505 冲突会提示重试,未做自动重试。
4. 未跑真实 DB migration(`db:push`);建议 Integrator 对 65–69 做 dry-run。采购过账依赖既有 `post_goods_receipt`(000017)与 `touch_updated_at`(000015),migration 按序应用即可。
5. 未运行 E2E(本批约定 E2E 独立,不改 `e2e/**`)。

## 9. 风险

- `post_purchase_order` 在 RPC 内嵌套调用 `post_goods_receipt`(同为 security definer);同一事务,任一条失败整体回滚,PO 状态不残留。已在 Hono 层与幂等键双重保障。
- 采购单为门店级数据,RLS 用 `can_access_store`;新建时 Hono 用 `requireScopedPermission(purchase.create, storeId)` 校验门店作用域。
- `purchase_orders.store_id/warehouse_id/supplier_id` 加了 FK(on delete restrict),删除门店/仓库/供应商前需先处理采购单。

## 10. 验证证据

```text
- tsc --noEmit -p api/tsconfig.json:routes/inventory.ts 无错误(inventory 相关 0 报错)
- vue-tsc -b(apps/maoxianqiu):views/inventory/*、api/modules/inventory.ts、types/inventory.ts、router/modules/inventory.ts 无错误
- 整仓 typecheck 当前因其他 Agent 在制品非零退出(见 §8.1),与本次改动无关
- 未运行 E2E
```
