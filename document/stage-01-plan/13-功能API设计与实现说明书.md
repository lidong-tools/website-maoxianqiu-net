# 【毛线球】功能 API 设计与实现说明书（基于现有代码）

> 版本：v0.4  
> 前端：Vue SPA  
> 浏览器数据访问：Supabase anon client + RLS  
> 服务端：Hono on Vercel  
> 文件：Cloudflare R2

---

## 1. 当前 API 架构

### 1.1 浏览器直连 Supabase

当前模块：

- 登录/注册/密码找回
- profile
- stores
- roles
- store_members

优点：

- 开发快
- RLS 直接生效
- 减少 Function 调用

风险：

- 复杂业务容易散落在页面
- 多表事务无法由浏览器安全完成
- 错误码不统一
- 查询逻辑容易重复
- 业务规则可能只在前端

### 1.2 Hono 服务端 API

当前仅保留浏览器不能安全完成的操作：

```text
GET  /api/health
POST /api/user/create
POST /api/user/reset-password
POST /api/upload
POST /api/files/delete
```

这是合理方向，但需要明确分类。

---

## 2. API 分类规则

### A 类：浏览器可直连 Supabase

仅适用于：

- 简单只读查询
- 单表普通 CRUD
- RLS 足够表达权限
- 不使用 service role
- 不涉及多个业务事实同时提交

示例：

- 查询客户列表
- 查询门店列表
- 修改个人资料
- 读取基础字典

### B 类：必须走 Hono Command API

满足任一条件就必须走后端：

- 需要 service role
- 调用 Auth Admin
- 跨表事务
- 库存变动
- 支付/退款
- 病历签署
- 报告发布
- 用户邀请
- 文件签名
- 外部供应商
- 幂等控制
- 审计要求高

### C 类：数据库 RPC

需要强事务一致性的命令：

- 入库过账
- 盘点过账
- 调拨发货/收货
- 发药
- 支付
- 退款
- 病历签署
- 客户合并

Hono 负责认证、权限、输入校验和调用 RPC。

---

## 3. 当前响应格式问题

当前格式：

```json
{
  "status": 1,
  "error": "",
  "data": {}
}
```

问题：

- `status: 1` 同时可能带 `error`
- 业务错误仍返回 HTTP 200
- 前端依赖字符串错误
- 无稳定错误码
- 无 requestId

建议兼容升级：

```json
{
  "ok": true,
  "data": {},
  "requestId": "req_xxx"
}
```

失败：

```json
{
  "ok": false,
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "库存不足",
    "fieldErrors": {
      "items.0.quantity": ["可用库存为 2"]
    }
  },
  "requestId": "req_xxx"
}
```

HTTP 状态：

- 400 校验失败
- 401 未登录
- 403 无权限
- 404 不存在
- 409 状态/并发冲突
- 422 业务规则失败
- 500 服务端错误

迁移期间 Axios 拦截器同时兼容旧、新格式。

---

## 4. 认证头

当前前端发送：

```text
Token: <access_token>
```

Hono 同时兼容 `Authorization: Bearer`。

建议统一为：

```text
Authorization: Bearer <access_token>
```

不要继续新增依赖 `Token` 的接口。

---

## 5. API 目录结构

当前：

```text
api/
├── index.ts
├── lib/
├── middlewares/
└── routes/
```

建议扩展：

```text
api/
├── index.ts
├── lib/
│   ├── supabase.ts
│   ├── r2.ts
│   ├── result.ts
│   ├── errors.ts
│   ├── validation.ts
│   ├── audit.ts
│   └── request-context.ts
├── middlewares/
│   ├── auth.ts
│   ├── request-id.ts
│   ├── error-handler.ts
│   └── rate-limit.ts
├── routes/
│   ├── users.ts
│   ├── files.ts
│   ├── inventory.ts
│   ├── billing.ts
│   ├── medical-records.ts
│   └── diagnostics.ts
└── schemas/
```

---

## 6. 权限模型修正

当前后端主要使用：

- `hasRole(system_admin)`
- `canManageStore(storeId)`
- `store_manager`

不够满足完整 SaaS。

应逐步升级为：

```ts
requirePermission(c, {
  code: 'inventory.transfer.approve',
  storeId,
})
```

角色只是权限集合，业务代码不应到处判断具体角色名。

### 6.1 当前缺少 tenant

现有表只有 `stores`、`store_members`、`roles`，尚未形成 PRD 中完整的 `tenants` 边界。

在扩展业务 API 前必须先决定：

- 引入 `tenants`
- stores 带 `tenant_id`
- roles 带 tenant 或系统模板范围
- 所有业务表带 `tenant_id`

---

## 7. 当前 API 安全问题与改进

### 7.1 店铺删除

当前前端直接：

```ts
supabase.from('stores').delete()
```

正式系统不应物理删除门店，应改为：

```text
POST /api/stores/:id/archive
```

并检查历史业务记录。

### 7.2 文件上传

当前上传：

- Vercel 中转
- 公共 URL
- 10MB
- R2 key 不含 tenant/store
- MIME 校验不足
- `r2_files` 主要按 user 归属

正式设计：

```text
POST /api/files/upload-intents
POST /api/files/:id/complete
POST /api/files/:id/download-url
POST /api/files/:id/archive
```

对象 key：

```text
{env}/tenant/{tenantId}/store/{storeId}/{domain}/{yyyy}/{mm}/{uuid}.{ext}
```

### 7.3 用户创建补偿

当前先创建 Auth 用户，再插入 store member。第二步失败时会留下孤立 Auth 用户。

必须实现：

- 后端补偿删除 Auth 用户
- 或使用 invitation 状态
- 返回明确错误码
- 记录审计

### 7.4 修改密码

当前 `editPassword` 参数包含旧密码，但实际没有验证旧密码。UI 和 API 契约需要一致：

- 已登录用户修改密码：重新认证后更新
- 管理员重置密码：单独权限 API

---

## 8. 前端 API 模块规范

每个模块：

```ts
// src/api/modules/customer.ts
export interface CustomerListParams {}
export interface CustomerListResult {}

export const customerApi = {
  list(params: CustomerListParams),
  detail(id: string),
  create(input: CreateCustomerInput),
  update(id: string, input: UpdateCustomerInput),
  archive(id: string),
}
```

禁止 `data: any`。

Supabase 的数据库类型应由：

```text
pnpm db:gen-types
```

生成后引用。

---

## 9. 通用查询契约

列表参数：

```ts
interface ListParams {
  page: number
  pageSize: number
  keyword?: string
  storeId?: string
  status?: string[]
  createdFrom?: string
  createdTo?: string
  sort?: string
  order?: 'asc' | 'desc'
}
```

返回：

```ts
interface PageResult<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
}
```

禁止不同模块分别返回 `list`、`rows`、`records`。

---

## 10. 系统管理 API

### 10.1 门店

```text
GET    /api/stores
POST   /api/stores
GET    /api/stores/:id
PATCH  /api/stores/:id
POST   /api/stores/:id/archive
POST   /api/stores/:id/restore
```

简单列表可暂时直连 Supabase，但创建、归档应走 Command API。

### 10.2 员工

```text
GET    /api/employees
POST   /api/employees/invite
GET    /api/employees/:id
PATCH  /api/employees/:id
POST   /api/employees/:id/assign-store
POST   /api/employees/:id/change-role
POST   /api/employees/:id/disable
POST   /api/employees/:id/reset-password
```

### 10.3 角色

```text
GET    /api/roles
POST   /api/roles
PATCH  /api/roles/:id
POST   /api/roles/:id/archive
GET    /api/permissions
```

系统角色不可删除。

---

## 11. 工作台聚合 API

```text
GET    /api/workbench
```

工作台使用聚合端点，按角色返回不同数据：

- 前台：预约、候诊、收费
- 医生：我的候诊、未完成病历、检验结果
- 护士：待执行、超时、住院任务
- 店长：收入、客流、退款、库存预警

查询参数：

- `storeId`：门店 ID（必填）
- `role`：可选角色覆盖

前端不应为工作台并发请求十几个独立列表 API。

---

## 12. 客户与宠物 API

```text
GET    /api/customers
POST   /api/customers
GET    /api/customers/:id
PATCH  /api/customers/:id
POST   /api/customers/:id/archive
POST   /api/customers/merge

GET    /api/pets
POST   /api/pets
GET    /api/pets/:id
PATCH  /api/pets/:id
POST   /api/pets/:id/archive
POST   /api/pets/:id/weights
GET    /api/pets/:id/timeline
```

客户合并必须是后端 command/RPC。

---

## 13. 预约和候诊 API

```text
GET    /api/appointments
POST   /api/appointments
PATCH  /api/appointments/:id
POST   /api/appointments/:id/confirm
POST   /api/appointments/:id/cancel
POST   /api/appointments/:id/arrive
POST   /api/appointments/:id/no-show

POST   /api/encounters/check-in
GET    /api/queues
POST   /api/queues/:id/call
POST   /api/queues/:id/skip
POST   /api/queues/:id/start
```

预约创建由后端检查资源冲突。

---

## 14. 就诊、病历和处方 API

```text
GET    /api/encounters
GET    /api/encounters/:id
POST   /api/encounters/:id/start
POST   /api/encounters/:id/complete

GET    /api/medical-records/:id
PUT    /api/medical-records/:id/draft
POST   /api/medical-records/:id/sign
POST   /api/medical-records/:id/revise

POST   /api/prescriptions
PATCH  /api/prescriptions/:id
POST   /api/prescriptions/:id/submit
POST   /api/prescriptions/:id/void
POST   /api/prescriptions/:id/dispense
```

### 13.1 病历草稿

草稿保存可允许较高频率，但：

- 使用 version
- 防止两个窗口覆盖
- 返回 `updatedAt`
- 签署时检查最新 version

---

## 15. 收费和退款 API

```text
POST   /api/invoices
GET    /api/invoices/:id
PATCH  /api/invoices/:id/draft
POST   /api/invoices/:id/issue
POST   /api/payments
POST   /api/refunds
POST   /api/refunds/:id/approve
POST   /api/refunds/:id/execute
```

所有 Command 接受：

```text
Idempotency-Key
```

或请求 body 的 `idempotencyKey`。

---

## 16. 库存 API

```text
GET    /api/inventory/balances
GET    /api/inventory/movements

POST   /api/goods-receipts
POST   /api/goods-receipts/:id/submit
POST   /api/goods-receipts/:id/approve
POST   /api/goods-receipts/:id/post

POST   /api/stock-counts
POST   /api/stock-counts/:id/submit
POST   /api/stock-counts/:id/approve
POST   /api/stock-counts/:id/post

POST   /api/transfers
POST   /api/transfers/:id/submit
POST   /api/transfers/:id/approve
POST   /api/transfers/:id/ship
POST   /api/transfers/:id/receive
```

这些接口不能由浏览器直接 insert/update 多张表。

---

## 17. 检验 API

```text
POST   /api/diagnostic-orders
POST   /api/diagnostic-orders/:id/collect
POST   /api/diagnostic-orders/:id/receive
POST   /api/diagnostic-orders/:id/results
POST   /api/diagnostic-orders/:id/submit-verification
POST   /api/diagnostic-orders/:id/publish
POST   /api/diagnostic-orders/:id/revise
```

已发布报告不允许普通 update。

---

## 18. 住院 API

```text
GET    /api/inpatient/board
GET    /api/admissions
POST   /api/admissions
POST   /api/admissions/:id/change-unit
POST   /api/admissions/:id/discharge-request
POST   /api/admissions/:id/discharge

POST   /api/care-orders
POST   /api/care-tasks/:id/start
POST   /api/care-tasks/:id/complete
POST   /api/care-tasks/:id/skip
```

房位分配必须在数据库事务内防冲突。

---

## 19. 导入 API

```text
POST   /api/imports/upload
POST   /api/imports/:id/mapping
POST   /api/imports/:id/validate
POST   /api/imports/:id/commit
GET    /api/imports/:id
GET    /api/imports/:id/errors
```

导入任务异步执行，前端轮询或订阅状态。

---

## 20. API 实现模板

Hono route：

```ts
route.post('/:id/approve', requireAuth(), async (c) => {
  const requestId = c.get('requestId')
  const input = schema.parse(await c.req.json())
  const actor = await requirePermission(c, {
    code: 'inventory.transfer.approve',
    storeId: input.storeId,
  })

  const result = await service.rpc('approve_inventory_transfer', {
    p_transfer_id: c.req.param('id'),
    p_actor_id: actor.employeeId,
    p_idempotency_key: input.idempotencyKey,
  })

  return ok(c, result, requestId)
})
```

---

## 21. API 测试要求

每个 Command 至少测试：

- 未登录
- 无权限
- 跨店
- 跨租户
- 错误状态
- 参数错误
- 重复请求
- 并发请求
- 正常成功
- 审计日志

---

## 22. API 开发顺序

1. 统一 Result/Error
2. request ID
3. tenant/store context
4. permission helper
5. RLS 测试
6. 用户邀请补偿
7. 文件预签名
8. 客户宠物
9. 目录
10. 预约病历
11. 收费库存
12. 检验住院

未完成前 5 项，不扩张业务 API。
