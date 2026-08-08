> 项目：毛线球宠物医院 SaaS  
> 基线代码：`website-maoxianqiu-net-main (9)`  
> 阶段：Stage-03 / S3.1 并发加速开发  
> 原则：**一个文件只能有一个写入 Owner；跨域修改必须通过 Handoff，由最终 Integrator 处理。**  
> E2E：当前独立执行，本批任务不得修改 `e2e/**`，也不以 E2E 完成作为本批开发验收条件。  

# Agent-01 — IAM / Context + 新需求：平台租户管理

## 1. 任务目标

本 Agent 同时负责：

### 当前 P0 收口

- 前端权限来源统一；
- Tenant / Store Context 真实性；
- Tenant Role 不跨 Tenant 污染；
- Primary Store；
- Platform Admin Context；
- 切换门店基础刷新协议；
- Password Recovery / 账号上下文细节。

### 新需求

开发：

```text
平台租户管理
+
门店详情页
```

---

# 2. 独占文件区域

允许修改：

```text
api/routes/user.ts
api/routes/tenants.ts
api/routes/stores.ts

apps/maoxianqiu/src/store/modules/app/account.ts
apps/maoxianqiu/src/store/modules/app/tenant.ts

apps/maoxianqiu/src/components/AppAccountButton/**
apps/maoxianqiu/src/components/AppAccountForm/**
apps/maoxianqiu/src/components/**Context**/

apps/maoxianqiu/src/views/auth/**
apps/maoxianqiu/src/views/system/tenant-init/**
apps/maoxianqiu/src/views/system/tenants/**
apps/maoxianqiu/src/views/system/store/**

apps/maoxianqiu/src/router/modules/system.ts
```

Migration：

```text
20260810000054_*
20260810000055_*
```

---

# 3. 禁止修改

```text
api/index.ts
apps/maoxianqiu/src/router/routes.ts

api/routes/billing.ts
api/routes/settings.ts
api/routes/clinical.ts
api/routes/diagnostics.ts
api/routes/customers.ts
api/routes/inventory.ts
api/routes/inpatient.ts

e2e/**
```

---

# 4. P0：建立唯一 `/api/user/context`

目标：

浏览器不再自行用多张表计算权限。

建议：

```http
GET /api/user/context
```

返回：

```ts
{
  user: {
    id,
    email,
    displayName
  },

  mode: "platform" | "tenant",

  platformRoles: [],

  tenants: [
    {
      id,
      name,
      roles,
      stores: [
        {
          id,
          name,
          isPrimary,
          roles,
          permissions
        }
      ]
    }
  ]
}
```

后端必须使用现有：

```text
employee_role_assignments
roles
role_permissions
platform_user_roles
employee_store_assignments
```

作为事实来源。

Legacy：

```text
store_members
```

只能做迁移兼容，不再作为主权限来源。

---

# 5. Context 初始化

顺序：

```text
加载 /api/user/context
↓
读取当前用户自己的 persisted context
↓
仍有权限？
  是 → 恢复
  否 → Primary Store
↓
没有 Primary → 第一个授权 Store
```

Storage Key：

```text
mxq:{userId}:tenant
mxq:{userId}:store
```

Logout：

```text
清除当前用户 context
```

---

# 6. Platform Mode

如果用户存在：

```text
platform_user_roles
```

则：

```text
mode=platform
```

Platform Admin 不应被伪装成普通 Employee。

需要支持：

```text
平台视图
↓
选择目标 Tenant
↓
进入 Tenant Context
```

---

# 7. 新需求：平台租户列表

新增：

```text
/system/tenants
```

仅 Platform Admin 可进入。

页面：

```text
租户管理

[搜索名称/ID] [状态] [试用状态]

医院名称
简称
状态
门店数
员工数
试用截止
创建时间
操作
```

Primary Action：

```text
查看
```

More：

```text
停用
恢复
```

---

# 8. Tenant Detail

```text
/system/tenants/:id
```

布局：

```text
Tenant Summary

Tabs:
概览
门店
人员
配置摘要
审计
```

Pilot 最低实现：

```text
概览
门店
人员
```

不要在本 Agent 重做完整 System Settings。

---

# 9. Tenant Stop / Resume

必须：

```text
Platform Admin
+
Reason
+
Audit
```

API：

```http
POST /api/tenants/:id/suspend
POST /api/tenants/:id/resume
```

规则：

- 禁止直接前端 UPDATE status；
- 停用后新业务 Command 必须无法继续；
- 不删除历史数据；
- 恢复后原业务数据继续存在。

如果当前 `tenants.status` 的合法值与命名不同，必须沿用现有约束，不能私自引入另一套状态。

---

# 10. 新需求：门店详情

新增隐藏详情：

```text
/system/store/:id
```

Tabs：

```text
概览
营业设置
仓库
人员
支付
打印
```

本 Agent 只负责：

```text
概览
人员
基础门店信息
```

系统设置中的营业/支付/打印仍由 Agent-02 负责。

通过 Deep Link：

```text
门店详情 → 系统设置对应 Store
```

即可。

---

# 11. Store Switch Refresh Contract

本 Agent 不修改所有业务页。

需要提供统一机制，例如：

```ts
registerContextReload(id, callback)
```

或：

```text
context revision
```

当门店切换：

```text
revision++
```

业务页面后续可监听统一 revision。

必须在 Handoff 写清：

```text
Agent-02~06 如何接入。
```

---

# 12. Password Recovery

修正：

```text
/auth/reset-password
```

要求：

- anonymous route 可进入；
- 只接受真实 `PASSWORD_RECOVERY`；
- 普通登录 session 不等于 recovery；
- `resetPasswordForEmail` 指定 redirectTo；
- 成功后回登录或安全页。

---

# 13. DB

优先复用：

```text
tenants
stores
employees
employee_store_assignments
employee_role_assignments
platform_user_roles
```

除非真实缺字段，不新建“platform_tenants”重复表。

Migration 54/55 只允许用于：

- 必要索引；
- status/audit command；
- Primary Store 修复；
- 权限安全修补。

---

# 14. 验收

```text
[ ] 新员工权限前后端一致
[ ] Platform Admin 正常进入平台上下文
[ ] 多 Tenant Role 不互相污染
[ ] Primary Store 生效
[ ] 切换未授权 Store 不可能
[ ] 不同账号 Context 不串
[ ] 租户可停用/恢复
[ ] 停用写审计
[ ] 租户列表/详情可用
[ ] 门店详情可用
[ ] Password Recovery 正常
[ ] Typecheck
[ ] Build
```

---

# 15. Handoff

生成：

```text
document/parallel-handoff/AGENT-01-HANDOFF.md
```

重点告诉 Agent-07：

```text
Context DTO
Platform Mode
Store Refresh Contract
新增 routes
新增 permissions
Migration
```
