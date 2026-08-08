> Agent-04 HANDOFF — CRM + 客户回访任务
> 环境说明:所有 Agent 共用同一工作目录与 `main` 分支,本 HANDOFF 按此记录。

# Agent-04 Handoff

## 1. 基础信息

- Base Commit: `d32e862a update`(HEAD)
- 分支:共享 `main` 工作树(未建独立分支,与其他 Agent 同一目录)
- 模块:Customer Import 死入口修复 + Customer 360 真实数据 + 客户回访任务(`followup_tasks`)
- 状态:开发完成;`tsc -p api/tsconfig.json` 与 `vue-tsc -b` 对本 Agent 相关文件全部通过,整仓 typecheck 当前通过
- Migration 预留:`20260810000062` – `20260810000064`,实际使用 `62` / `63`

## 2. 修改文件

| 文件 | 改动 |
|---|---|
| `api/routes/customers.ts` | 新增回访全部路由(create/list/detail/patch/start/complete/cancel)+ `GET /:id/360` 客户 360 聚合;`followupTable` any-helper(见 §8);`enrichFollowups` 服务端回填客户/宠物/负责人名称 |
| `apps/maoxianqiu/src/types/customer.ts` | 新增 Followup 类型(Record/ListParams/Create/Update/Complete/Customer360)+ 状态机转换矩阵 + 全部展示标签映射 |
| `apps/maoxianqiu/src/api/modules/customer.ts` | 新增 listFollowups/getFollowup/createFollowup/updateFollowup/startFollowup/completeFollowup/cancelFollowup/getCustomer360 |
| `apps/maoxianqiu/src/router/modules/crm.ts` | 新增 `/crm/followups`(auth: followup.view) |
| `apps/maoxianqiu/src/views/crm/followups/index.vue` | 新增回访列表页:逾期/今天/未来/已完成/全部 Tab + 关键词/门店筛选 + 分页 + 新建/详情抽屉 |
| `apps/maoxianqiu/src/components/followups/FollowupCreateDrawer/index.vue` | 新增手动创建回访抽屉(客户/宠物/类型/计划时间/负责人/渠道) |
| `apps/maoxianqiu/src/components/followups/FollowupDetailDrawer/index.vue` | 新增回访详情抽屉:信息 + 开始/登记结果/取消 + 客户/宠物/就诊深链 |
| `apps/maoxianqiu/src/views/crm/customer/index.vue` | 导入死入口改为真实深链 `/operations/imports?type=customers&action=create` |
| `apps/maoxianqiu/src/views/crm/customer/detail.vue` | 删除"就诊历史开发中"占位;新增最近就诊/最近消费(360 真实数据)+ 回访任务 Tab(待办/历史/新建) |

## 3. Migration(Agent-04 预留 62–64)

| Migration | 内容 |
|---|---|
| `20260810000062_followup_tasks.sql` | `followup_tasks` 表(tenant_id + store_id + 全部业务字段 + 状态约束:完成必须有结果、取消必须有原因)+ 5 个索引 + RLS(读 `is_tenant_member`/`can_access_store`,写 `followup.manage`) |
| `20260810000063_followup_permissions.sql` | 权限 `followup.view/manage/complete` + 角色授权(system_admin/store_manager 全量,doctor/nurse view+complete,cashier view)+ `roles.permissions` 数组同步 |

## 4. 新增权限

```text
followup.view    查看回访
followup.manage  管理回访(创建/修改/开始/取消)
followup.complete 完成回访(登记结果)
```

角色映射:system_admin、store_manager 全量;doctor、nurse view+complete;cashier view。未新增角色。`role_permissions` 关联表与 `roles.permissions` 数组均已同步。

## 5. 新增 API(全部走 Hono Command,service role)

```text
GET  /customers/followups                 # 列表(bucket/status/keyword/customerId/assigneeId/storeId/分页,服务端回填名称)
POST /customers/followups                 # 创建(仅手动;校验客户租户/门店与 active 状态,审计 followup.create)
GET  /customers/followups/:id             # 详情(审计 read)
PATCH /customers/followups/:id            # 更新(仅 pending:改期/改负责人/改渠道/改类型)
POST /customers/followups/:id/start       # pending → in_progress(开始)
POST /customers/followups/:id/complete    # in_progress → completed(结果必填,可带下次回访;followup.complete)
POST /customers/followups/:id/cancel      # pending/in_progress → cancelled(原因必填)
GET  /customers/:id/360                   # 客户 360:客户+宠物+最近就诊+最近消费+回访(客户+状态计数)
```

路由注册顺序注意:`/followups` 全部注册在 `GET /:id` 之前,避免被动态段吞并(文件内有注释说明)。

## 6. 新增 Route

```text
/crm/followups   回访任务(auth: followup.view)
```

## 7. 跨域 Hook(需 Agent-07 / 对应 Domain Owner 集成)

1. **Encounter Follow-up Date → 自动生成回访**:`encounters.follow_up_date` 被填/确认时,生成 `source_type=encounter`、`source_id=encounter.id` 的 `post_visit` 回访任务。Agent-04 未改 `api/routes/clinical.ts`;建议由 Agent-03 或 Agent-07 在 clinical 的 encounter 确认流程调用 `create followup`。
2. **Discharge Finalized → 生成出院回访**:出院最终化时生成 `source_type=discharge` 的 `post_discharge` 回访。Agent-04 未改 `api/routes/inpatient.ts`;建议由 Agent-06 或 Agent-07 集成。
   - 两者共用契约:`POST /customers/followups`,body 带 `customerId`、`petId`、`sourceType`、`sourceId`、`taskType`、`scheduledAt`、`assigneeEmployeeId`(可空)。API 已能接受 `source_type/source_id`。
3. **Import Deep Link Contract**:客户页导入按钮 → `/operations/imports?type=customers&action=create`。Import Center 未改(避免跨域);该页当前默认 `type=customer`。若希望 query 自动切换 Tab,可由 Agent-02 在 Import Center 读取 query(本 Agent 未改 `views/operations/imports/**`)。
4. **Customer360 DTO**:`GET /customers/:id/360` 返回 `{ customer, pets, recentEncounters(≤10), recentInvoices(≤10), followups(≤10), followupCounts }`。未来 Agent-02 会员摘要可并入该 DTO(消费其 DTO 约定)。
5. **未来 Customer Communications**:Followup Completed Event 可被未来"客户沟通记录"消费。MVP 结果直接存 `followup_tasks`,未新增 Timeline 表。

## 8. 未完成项 / 已知边界

1. `followup_tasks` 尚未进入生成的 supabase types(Database 快照);`api/routes/customers.ts` 用 `followupTable` any-helper 关闭该表查询器类型推导。**Integrator 跑 `db:push` + `db:gen-types` 后可移除 helper**。
2. 客户详情"回访任务"Tab 数据来自 360 聚合(最多 10 条),待办/历史在该切片内过滤;完整列表在 `/crm/followups` 页。
3. MVP 未做负责人 self-scope:有 `followup.view` 即当前 Store 全部(按 spec 约定,未临时创造不完整 self permission)。
4. 未跑真实 DB migration(`db:push`);建议 Integrator 对 62/63 做 dry-run。依赖既有 `is_tenant_member`/`can_access_store`/`has_permission`(000010)与 permissions/roles(000009)。
5. 未运行 E2E(本批约定 E2E 独立,不改 `e2e/**`)。

## 9. 风险

- 回访为门店级业务数据,`store_id` 可空(租户级手动回访也允许);RLS 与 `requireScopedPermission` 均已按 store 收敛。
- 状态机由 DB check 约束 + Hono 双重保障:完成必须有结果、取消必须有原因;非法流转返回 409。
- `GET /customers/followups` 注册顺序依赖 `/:id` 之前,后续若有人重排路由需注意。

## 10. 验证证据

```text
- tsc --noEmit -p api/tsconfig.json:routes/customers.ts 无错误(整仓 api 通过)
- vue-tsc -b(apps/maoxianqiu):views/crm/followups、components/followups、views/crm/customer、api/modules/customer.ts、types/customer.ts、router/modules/crm.ts 无错误(整仓前端通过)
- 前端生产 build:`vite build`(apps/maoxianqiu)成功(✓ built in 1m31s,exit 0)
- 未运行 E2E
```
