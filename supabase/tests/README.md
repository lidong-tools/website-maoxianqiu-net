# RLS / 数据库测试

## 文件

| 文件 | 说明 |
|---|---|
| `rls_tenant_store.sql` | 两租户两门店 RLS 隔离测试(MXQ-3007),事务内执行,断言失败即报错并回滚 |

## 执行方式

需要可运行的 Supabase 数据库(本地 Docker 或 CI):

```bash
# 1) 本地重置并应用全部 migrations + seed
supabase db reset

# 2) 执行 RLS 测试(psql 需已配置 DATABASE_URL)
psql "$DATABASE_URL" -f supabase/tests/rls_tenant_store.sql
# 或:复制脚本内容到 Supabase SQL Editor 以 postgres 角色执行
```

## 断言矩阵

- T1 跨租户不可读(A 用户读取 B 租户数据 = 0)
- T2 跨租户不可写(A 用户写入 B 租户数据 = 拒绝)
- T3 无权门店不可读(A1 员工读取 A2 门店明细 = 0)
- T4 无权门店不可写(A1 员工写入 A2 门店 = 拒绝)
- T5 合法门店访问成功(A1 员工读写本店 = 成功)
- T6 管理员特殊访问有审计(system_admin 跨店读取成功;审计可写,普通角色不可读)

## 当前状态

- 2026-08-06:测试脚本已编写,但因本地 Docker Desktop 无法启动,未在本地执行。
- 可选执行环境:链接的远程 Supabase 项目(`maoxianqiu-app`,ref `bxhvtbhwuktrpxxygikj`)或 CI。
  远程库属共享环境,执行前需与负责人确认。
