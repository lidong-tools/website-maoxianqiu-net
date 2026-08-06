# 仓库基线审计（BASELINE_AUDIT）

> 版本：v0.4
> 基线 commit：`eb44aa97`（refactor: 前端全量直连 Supabase + R2 存储复刻）
> 审计日期：2026-08-06
> 文档基线：`document/stage-01-plan/`（maoxianqiu-docs-v0.4）

## 1. 环境记录

| 项目 | 值 |
|---|---|
| 包管理器 | pnpm@11.18.0 |
| Node | v24.11.1（引擎要求 `^22.22.2 || ^24.15.0 || >=26.0.0`，**当前版本不满足 ^24.15.0**，有 WARN） |
| 构建工具 | Vite（maoxianqiu app `vue-tsc -b && vite build`） |
| Supabase 项目 | `maoxianqiu-app`（ref `bxhvtbhwuktrpxxygikj`） |
| Supabase 迁移 | 0001~0007 全部已应用至远程 |
| 部署 | Vercel（`api/` Hono Functions + 前端静态） |

### 1.1 本地验证结果

| 命令 | 结果 |
|---|---|
| `pnpm install` | 通过（Already up to date，node 引擎 WARN） |
| `pnpm lint`（tsc + eslint + stylelint） | 通过（exit 0，全部 workspace app typecheck 通过） |
| `pnpm --filter @fantastic-admin/maoxianqiu build` | 通过（built in 40.9s） |

## 2. 前端路由清单

路由总入口：`apps/maoxianqiu/src/router/routes.ts`（动态路由在登录后按权限注册），`systemRoutes`（常量），`constantRoutes`（登录/404）。

### 2.1 常量路由
| 路径 | 名称 | 页面 | 类型 |
|---|---|---|---|
| `/login` | login | `views/login.vue` | 真实（Supabase 登录） |
| `/:all(.*)*` | notFound | `views/[...all].vue` | 基础设施 |
| `/` | home | `views/index.vue` | **演示（Fantastic Admin 营销页，需重做）** |
| `/reload` | reload | `views/reload.vue` | 基础设施 |

### 2.2 动态路由（登录后注册）
| 分组 | 子模块 | 类型 |
|---|---|---|
| 演示 | multilevel_menu / breadcrumb / keep_alive / tabbar / component / icon / feature / plugin / auth / fake / jsx / external_link / standard_module | **example 演示（需移出生产菜单）** |
| UI | ui.example | **example 演示** |
| 生态 | ecology.example | **example 演示** |
| 系统管理 | system（user / role / store） | **真实功能** |

### 2.3 系统管理子路由（`router/modules/system.ts`）
| 路径 | 页面组件 | 备注 |
|---|---|---|
| `/system/user` | `views/system/user/index.vue` | 真实；成员/用户管理 |
| `/system/role` | `views/system/role/index.vue` | 真实；角色管理 |
| `/system/store` | `views/system/store/index.vue` | 真实；店铺管理 |

> 注意：`system.ts` 路由父级 `component: Layout` 且无实际 child view，仅顶层组件按 `meta` 匹配加载；文档 12 §6 指出此模式需核验（见 GAP_ANALYSIS）。

## 3. 页面清单

### 3.1 真实业务/基础设施页面
- `views/login.vue` — Supabase 登录/注册/找回
- `views/system/user/*` — 用户/成员管理（含 UserForm、RoleChangeForm、PasswordForm）
- `views/system/role/*` — 角色管理（RoleForm）
- `views/system/store/*` — 店铺管理（StoreForm）
- `views/index.vue` — 首页（当前为 Fantastic Admin 营销演示）

### 3.2 example 演示页面（保留源码作参考，不入生产菜单）
- `views/auth_example/`、`breadcrumb_example/`、`component_example/`（56 个组件示例）、`fake_example/`、`feature_example/`、`jsx_example/`、`keep_alive_example/`、`multilevel_menu_example/`、`plugin_example/`、`standard_module_example/`、`tabbar_example/`、`ui_example/`

## 4. API 清单

### 4.1 前端 API 模块（`apps/maoxianqiu/src/api/modules/`）
| 模块 | 实现 | 类型 |
|---|---|---|
| `app.ts` | Supabase 直连（profile / permission） | 真实 |
| `role.ts` | Supabase 直连 CRUD | 真实 |
| `store.ts` | Supabase 直连 CRUD | 真实 |
| `user.ts` | Supabase 直连 + Hono（create/reset-password） | 真实 |
| `standardModule.ts` | Supabase 直连 standard_module 表 | **example 演示** |

### 4.2 Fake 模块（`src/api/fake_modules/`）
| 模块 | 用途 |
|---|---|
| `app.fake.ts` | 后端下发路由（fake route list） |
| `standardModule.fake.ts` | standard_module 假数据 |
| `upload.fake.ts` | 假上传 |

### 4.3 Hono 服务端 API（`api/`）
| 方法 | 路径 | 说明 | 类型 |
|---|---|---|---|
| GET | `/api/health` | 健康检查 | 真实 |
| POST | `/api/upload` | R2 中转上传（Vercel 中转，10MB，公共 URL） | 真实（需升级） |
| POST | `/api/files/delete` | R2 删除（归属校验） | 真实（需升级） |
| POST | `/api/user/create` | Auth Admin 建号 + 建成员 | 真实 |
| POST | `/api/user/reset-password` | 重置密码 | 真实 |

### 4.4 认证头现状
- 前端 Axios 发送 `Token: <access_token>`；Hono auth 中间件兼容 `Token` 与 `Authorization: Bearer`。
- 响应格式为旧式 `{ status: 1|0, error, data }`，业务错误仍返回 HTTP 200（需按 v0.4 迁移）。

## 5. Supabase 数据库对象清单（迁移 0001~0007）

### 5.1 表
| 表 | 来源 | 说明 |
|---|---|---|
| `profiles` | 0001/0003 | 用户资料（account/avatar/permissions/real_name/phone/status），注册触发器创建 |
| `standard_module` | 0001 | 演示表（示例模块） |
| `roles` | 0003 | 角色（code/name/permissions[]/is_system） |
| `stores` | 0003 | 店铺（name/code/address/phone/status）——**尚无 tenant_id** |
| `store_members` | 0003 | 用户↔店铺↔角色（多对多）——**需迁移为 membership + employee assignment** |
| `r2_files` | 0006 | R2 文件记录（key/url/content_type/size/user_id/...）——**需迁移为 files + attachments** |

### 5.2 函数（security definer, search_path=public）
| 函数 | 说明 |
|---|---|
| `handle_new_user()` | 注册触发器 |
| `auth_role_codes()` | 调用者角色码集合 |
| `is_system_admin()` | 是否超管 |
| `managed_store_ids()` | 店长管理的店铺集合 |
| `can_manage_store(target)` | 超管 ∨ 目标店店长 |
| `can_manage_user(target)` | 超管 ∨ 目标用户在管理店有成员 |

### 5.3 触发器
- `on_auth_user_created` → `handle_new_user()`（注册自动建 profiles）

### 5.4 RLS 策略汇总
| 表 | 策略 | 说明 |
|---|---|---|
| profiles | select/update own 或 can_manage_user | 本人或管理者 |
| roles | select authenticated；insert/update/delete 仅超管（delete 且非系统角色） | 变更走后端 |
| stores | select authenticated；insert/update/delete 仅超管 | 变更走后端 |
| store_members | select 本人或 can_manage_store；insert/update/delete can_manage_store 且不可越权到 system_admin（0007 F1） | |
| standard_module | authenticated 且 auth_role_codes() 非空（0007 F2） | 演示 |
| r2_files | select 本人 | |

### 5.5 索引
- profiles(account)、standard_module(title)、store_members(user_id/store_id)、r2_files(user_id/user_email/source/created_at desc)

### 5.6 远程库现有数据（2026-08-06 只读查询）
- profiles: 1、roles: 4（system_admin/store_manager/staff/cashier）、stores: 1、store_members: 1、standard_module: 3、r2_files: 0

## 6. 真实 / 演示 / Fake 分类结论

- **真实功能**：登录注册、系统管理（用户/角色/店铺）、Supabase 直连 CRUD、Hono 建号/重置密码/上传/删除文件。
- **example 演示**：全部 `*.example.ts` 路由、全部 `*_example` views、`standard_module` 表及模块。
- **fake API**：`fake_modules/app.fake.ts`、`standardModule.fake.ts`、`upload.fake.ts`（仅开发期 `vite-plugin-fake-server`）。
- **需重做的演示残留**：`views/index.vue`（Fantastic Admin 营销首页）、`settings.ts` 版权、Logo/favicon、`VITE_APP_TITLE`。

## 7. R2 现状（MXQ-0004 输入）

- 上传：Vercel Function 中转整个文件，上限 10MB，`R2_PUBLIC_URL` 公开 URL。
- key：`generateR2Key` = `{path}/{prefix}-{Date.now}-{rand}.{ext}`，**不含 tenant/store 前缀**。
- 记录：`r2_files`（按 user 归属）；删除：`/api/files/delete` 校验归属后删 R2 + 删记录。
- 审计风险：无 MIME/大小服务端严格校验、key 无租户/门店隔离、依赖公共 URL、无预签名直传、`R2_BUCKET_NAME` 未配置时抛错。
