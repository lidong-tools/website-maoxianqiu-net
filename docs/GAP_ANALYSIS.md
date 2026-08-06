# 差距分析（GAP_ANALYSIS）

> 版本：v0.4
> 基线 commit：`eb44aa97`
> 目标：`document/stage-01-plan/`（v0.4 文档）定义的 Target State

## 1. 汇总

| 领域 | 现状 | 目标 | 差距等级 |
|---|---|---|---|
| 品牌/壳层 | Fantastic Admin 默认品牌、营销首页 | 毛线球品牌、工作台首页 | 高 |
| 路由 | example 路由在生产菜单 | 移除 example 路由，领域菜单骨架 | 高 |
| UI 基础组件 | 无 `components/business` | StoreSelector/PermissionButton/EntityStatusTag/壳组件/状态组件/格式化 | 高 |
| API 契约 | `{status:1,error,data}`、HTTP 200 包错误 | `{ok,data,error{code,message,fieldErrors},requestId}` + 明确 HTTP 状态 | 高 |
| 认证头 | `Token:` + 兼容 Bearer | 统一 `Authorization: Bearer` | 中 |
| API 基础设施 | 仅有 auth/loadCaller 中间件 | request-id/error-handler/zod/tenant-context/permission/audit/idempotency | 高 |
| 多租户 | 无 tenants 表，stores 无 tenant_id | tenants + stores.tenant_id + memberships/employees/roles | 高 |
| 数据模型 | 仅 6 张基础表 | v0.4 全量领域表（Phase 3+ 禁止提前开发） | 高 |
| RLS | 角色码 + can_manage_store | tenant/store/permission helper + 跨租户测试 | 高 |
| 文件 | Vercel 中转 + 公共 URL + 无 tenant 隔离 | 私有预签名直传 + files/attachments | 高（MXQ-4001+ 阶段） |
| 分页契约 | 各模块自行返回 `list/total` | 统一 `PageResult{items,page,pageSize,total}` | 中 |

## 2. 详细差距

### 2.1 UI 壳层（Phase 1：MXQ-1001/1002）
- `settings.ts` 版权仍为 Fantastic-admin（需品牌/版权/标题）。
- `views/index.vue` 为框架营销页（需重做为毛线球工作台骨架）。
- Logo `assets/images/logo.svg` 与 favicon 为框架默认（需替换）。
- `router/routes.ts` 注册了 演示/UI/生态 三组 example 路由（需移出生产菜单，源码保留）。

### 2.2 UI 基础组件（Phase 1：MXQ-1003~1009）
- 缺少 `src/components/business/` 目录（StoreSelector/PermissionButton/EntityStatusTag/EntityPageHeader/EmptyState/ErrorState/ConflictState/MoneyText/DateTimeText）。
- `packages/components/src/basic/` 已具备 FaPageHeader/FaPageMain/FaTable/FaForm/FaModal/FaDrawer/FaSearchBar/FaPagination/FaTabs/FaDescriptions/FaTag/FaFileUpload/FaImageUpload/FaFixedBar/FaToast/FaCard/FaProgress/FaDropdown 等基础组件，**业务组件应在其之上组合，不得重复造基础组件**。
- 现有系统页在列表/详情处自行写三元状态（如 `status==='active'?'启用':'停用'`），需改为 EntityStatusTag 统一映射。

### 2.3 API Foundation（Phase 1：MXQ-2001~2009）
- 无统一 Result/Error：现状 `status:1` 可同时带 error，业务错误仍 HTTP 200。
- 无 requestId。
- 认证头同时兼容 Token/Bearer，文档要求统一 Bearer。
- 无 Zod 校验中间件。
- 无 tenant/store 上下文（`AppEnv.Variables` 只有 user/token/roles/memberships，类型多处 `any`）。
- permission 为 `hasRole/canManageStore`，需升级为 `requirePermission(code, storeId)`。
- 无 audit helper、无 idempotency helper、无统一 error handler。
- 前端 Axios 拦截器只识别旧格式，需兼容旧+新格式并关联 requestId。

### 2.4 Tenant 与 RLS（Phase 1：MXQ-3001~3007）
- 无 `tenants` 表。
- `stores` 无 `tenant_id`、无归档状态。
- `store_members` 单表承担 membership+assignment 职责，需迁移为：
  - `tenant_memberships`（用户↔租户）
  - `employees`（员工档案）
  - `employee_store_assignments`（门店分配）
  - `employee_role_assignments`（角色分配）
- `roles` 无 tenant_id / scope / is_system 区分系统级与租户级。
- RLS helper 基于角色码，缺少 `current_employee_id` / `is_tenant_member` / `can_access_store` / `has_permission` 与跨租户隔离。
- 无两租户两门店测试数据与 RLS 测试套件。

### 2.5 已知风险清单
1. Node 版本不满足引擎声明（v24.11.1 < ^24.15.0），仅 WARN 不阻塞。
2. `router/modules/system.ts` 路由父级无实际 child view，仅靠顶层 meta 匹配，需在重构中核验为真实 view 加载。
3. 现有系统管理页仍直连 Supabase CRUD（文档要求创建/归档走 Hono Command API）。
4. 店铺当前支持物理 delete（`store.ts delete`），正式系统应归档（`POST /api/stores/:id/archive`）。
5. 用户创建补偿：`/api/user/create` 先建 Auth 用户再插 store_members，第二步失败会留下孤立 Auth 用户（MXQ-3003/3009 处理）。
6. 无本地上游 Docker，RLS 测试无法在本地执行（需远程库或 CI 环境，见 IMPLEMENTATION_STATUS）。
7. 迁移到远程库属于共享状态变更，未经验证前不批量推送。

## 3. 分期边界（禁止提前开发）

- 本阶段只执行 MXQ-0001~0004、1001~1009、2001~2009、3001~3007。
- MXQ-5000+ 业务 CRUD（客户/宠物/预约/病历/收费/库存等）禁止在本阶段开发。
- example 参考源码禁止删除。
