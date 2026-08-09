# Stage-04 RLS / RPC Runtime 报告(Agent-01)

> 维护者:Agent-01  
> 状态:⏳ 资产就绪,实库执行结果待 Wave 3 回填(业务 Agent Wave 1 完成 + Runtime DB 可用后)

## 1. G3 RPC ACL(Runtime 级)

### 1.1 方法

不依赖静态 `pnpm check:rpc-manifest`(那只是开发 Gate)。直接查询 PostgreSQL 元数据:

```sql
SELECT p.proname, count(*) AS overloads,
       bool_or(has_function_privilege('public', p.oid, 'EXECUTE')) AS pub_ok,
       bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')) AS anon_ok,
       bool_or(has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_ok,
       bool_or(has_function_privilege('service_role', p.oid, 'EXECUTE')) AS svc_ok
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN (/* manifest 全量 */)
GROUP BY p.proname;
```

### 1.2 判定标准

| 角色 | 期望 |
|---|---|
| PUBLIC | false(不可执行) |
| anon | false |
| authenticated | false |
| service_role | true |

任一违反(含 manifest 函数在 DB 不存在)→ G3 FAIL。

### 1.3 执行

```bash
pnpm exec tsx scripts/runtime-rpc-acl-check.ts
# 无 psql 时:
pnpm exec tsx scripts/runtime-rpc-acl-check.ts --emit-sql
```

### 1.4 结果表(待回填)

| # | 函数 | overloads | public | anon | authenticated | service_role | 判定 |
|---|---|---|---|---|---|---|---|
| (执行后回填) | | | | | | | |

## 2. G4 RLS Matrix

### 2.1 资产

`supabase/tests/stage04_rls_matrix.sql`(事务内,rollback 无残留;断言失败即 RAISE 并回滚)

### 2.2 角色矩阵

| 角色 | scope | 租户/门店 | 用途 |
|---|---|---|---|
| platform_admin | system | 平台 | M9 短路验证 |
| tenant_owner | tenant | 租户 A | tenant-wide 权限/全门店访问 |
| store_manager | store | A1 / B1 / C1 / D1 / E1 | 门店管理 |
| doctor | store | A1 | 诊疗/处方 |
| nurse | store | A1 | 护理 |
| cashier | store | A2 | 收银 |
| staff | store | A1 | 普通店员(仅 store:view) |
| inventory_role(自定义) | store | A1 | 库存专员(DEEP §7 inventory role) |
| 无角色员工 | - | A1 | M4 最小权限 |

### 2.3 租户状态矩阵

| 租户 | status | trial_ends_at | 预期 |
|---|---|---|---|
| A | active | - | 正常 |
| B | active | - | 正常(跨租户隔离目标) |
| C | suspended | - | 业务不可用,权限全拦截 |
| D | trial | 已过期 | 业务不可用,权限全拦截 |
| E | trial | 未过期 | 正常 |

### 2.4 断言矩阵(M1~M11)

| ID | 场景 | 期望 |
|---|---|---|
| M1 | A 员工对 Tenant B 任何上下文 | 无权限 |
| M2 | A1 store 角色访问 A2(未授权门店) | 无权限 |
| M3 | store 角色 tenant 上下文(禁止提升) | 无权限;tenant_owner 放行 |
| M4 | 无角色员工门店上下文 | 无权限 |
| M5 | 合法角色合法上下文正向 | 各自权限有效;未授权门店无效 |
| M6 | suspended 租户 | is_tenant_business_active=false,权限全拦截 |
| M7 | trial 已过期 | 同 M6 |
| M8 | trial 未过期 | 正常业务可用 |
| M9 | platform_admin | 跨租户 / suspended 租户均可管理(短路) |
| M10 | RLS 直连:跨租户 insert | 0 行(拒绝) |
| M11 | RLS 直连:本店可见/跨店不可见/跨租户不可见 | 隔离成立 |

### 2.5 执行

```bash
supabase db reset --linked --yes   # 需 destructive 安全门,见 STAGE04-RUNTIME-GATE.md §2.1
psql "$DATABASE_URL" -f supabase/tests/stage04_rls_matrix.sql
```

### 2.6 结果表(待回填)

| ID | 场景 | 结果 | 备注 |
|---|---|---|---|
| M1~M11 | (执行后回填) | | |

## 3. 结论

```text
G3 RPC ACL Runtime : ⏳ 待执行
G4 RLS Matrix      : ⏳ 待执行
综合               : integration_pending
```

任何 FAIL 将同时记入 `STAGE04-PILOT-BLOCKERS.md`(含 Owner Agent / Severity / Repro / Evidence)。
