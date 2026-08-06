# Supabase(数据库迁移与种子)

采用 Supabase CLI 管理数据库结构。前端浏览器用 anon key 直连,RLS 是唯一数据边界(见 `migrations/*_rls_full.sql` 的 helper 函数与策略)。

## 目录约定

| 路径 | 用途 |
|---|---|
| `migrations/` | 按时间戳命名 `YYYYMMDDHHMMSS_描述.sql`,`supabase db push` 按序应用 |
| `seed.sql` | 种子数据,`supabase db reset` 后自动执行(幂等) |

## 常用命令(根目录 pnpm scripts)

```bash
pnpm db:link             # 关联远端项目(首次)
pnpm db:push             # 应用新迁移到远端
pnpm db:pull             # 从远端拉取迁移(反向)
pnpm db:reset            # 重置远端(重跑迁移 + seed)
pnpm db:new-migration    # 新建迁移文件
pnpm db:gen-types        # 生成 TypeScript 类型到 apps/maoxianqiu/src/lib/supabase/types.ts
pnpm db:update           # db:push + db:gen-types
```

前置:安装 [Supabase CLI](https://supabase.com/docs/guides/cli),并 `pnpm db:login`。

## 说明

- **服务端密钥**:`SUPABASE_SERVICE_ROLE_KEY` 只在 Hono 后端(Vercel 环境变量)使用;浏览器只用 `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`。
- **首个系统管理员**:`db:reset` 只建角色不认人,需在 SQL Editor 手动执行(把邮箱/店铺编码换成实际值):
```sql
insert into public.store_members (user_id, store_id, role_id)
select u.id, s.id, r.id
from auth.users u, public.stores s, public.roles r
where u.email = '你的超管邮箱' and s.code = '你的店铺编码' and r.code = 'system_admin';
```
