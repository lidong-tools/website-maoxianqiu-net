> Agent-03 HANDOFF — Clinical / Diagnostics + 影像工作流
> 环境说明:所有 Agent 共用同一工作目录与 `main` 分支,本 HANDOFF 按此记录。

# Agent-03 Handoff

## 1. 基础信息

- Base Commit: `d32e862a update`(HEAD)
- 分支:共享 `main` 工作树(未建独立分支,与其他 Agent 同一目录)
- 模块:医生工作台收口 / Lab 工作台统一 / 影像工作流(PRD §12.3)
- 状态:开发完成;FE/api typecheck 对本 Agent 文件全部通过

## 2. 修改文件

| 文件 | 改动 |
|---|---|
| `api/routes/diagnostics.ts` | 新增 `GET /lab-workbench`(P0-27)+ 影像工作流全部路由(MXQ-10021~10032) |
| `apps/maoxianqiu/src/api/modules/diagnostics.ts` | 新增 `getLabWorkbench` + 影像 API 方法 |
| `apps/maoxianqiu/src/types/diagnostics.ts` | 新增 LabWorkbenchRecord/WorkflowStage 类型 + 影像类型(ImagingOrder/Report/Attachment) |
| `apps/maoxianqiu/src/views/clinical/workbench/index.vue` | P0-04 候诊队列只留 checked_in/in_progress;P0-05 历史按当前 pet / 检验按当前 encounter;P0-25 Dirty Guard;P0-26 409 Conflict UX;快捷「申请影像」入口 |
| `apps/maoxianqiu/src/views/diagnostics/lab/index.vue` | P0-27 消费 lab-workbench DTO;P0-28 录入 Dirty Guard(切单/路由/刷新/门店) |
| `apps/maoxianqiu/src/views/diagnostics/imaging/index.vue` | 新增影像工作台页面(新建/排程/执行/报告/审核/发布/附件) |
| `apps/maoxianqiu/src/router/modules/diagnostics.ts` | 新增 `/diagnostics/imaging` 路由(权限 imaging.view) |

## 3. Migration(Agent-03 预留 59–61)

| Migration | 内容 |
|---|---|
| `20260810000059_imaging_orders.sql` | imaging_orders / imaging_reports 表 + 索引 + RLS(读:租户成员+门店可见;写:imaging.* 权限) |
| `20260810000060_imaging_permissions.sql` | attachments 约束扩展 entity_type(imaging_order/imaging_report);新增 imaging.view/order/perform/report/review/publish 权限 + 角色授权 |
| `20260810000061_imaging_report_publish_rpc.sql` | `publish_imaging_report` RPC:报告 reviewed→published + 申请单推进 + 审计原子事务 |

## 4. 新增权限

```text
imaging.view / imaging.order / imaging.perform
imaging.report / imaging.review / imaging.publish
```
角色映射:system_admin/store_manager/tenant_owner 全量;doctor=view/order/report/review/publish;nurse=view/perform;cashier=view

## 5. 新增 API(MXQ-10021~10032,全部走 Hono Command / RPC)

```text
GET  /diagnostics/lab-workbench                 # P0-27 检验业务 DTO(workflowStage/primaryAction/canX)
GET  /diagnostics/imaging/orders                # 影像列表(stage 过滤)
POST /diagnostics/imaging/orders                # 创建申请
POST /diagnostics/imaging/orders/:id/schedule   # 排程
POST /diagnostics/imaging/orders/:id/start      # 开始执行
POST /diagnostics/imaging/orders/:id/perform    # 完成执行
POST /diagnostics/imaging/orders/:id/cancel     # 取消
GET  /diagnostics/imaging/orders/:id            # 详情(order+reports+attachments)
GET  /diagnostics/imaging/orders/:id/reports    # 报告列表
POST /diagnostics/imaging/orders/:id/reports    # 创建/修订报告
PATCH /diagnostics/imaging/reports/:id          # 保存草稿(已发布禁止直改)
POST /diagnostics/imaging/reports/:id/submit    # 提交待审
POST /diagnostics/imaging/reports/:id/review    # 审核(双签:审核人≠作者)
POST /diagnostics/imaging/reports/:id/publish   # 发布(publish_imaging_report RPC)
GET  /diagnostics/imaging/orders/:id/attachments
```

## 6. 新增 Route

```text
/diagnostics/imaging  影像工作台(auth: imaging.view)
```

## 7. 跨域 Hook

- 医生工作台「申请影像」跳转 `/diagnostics/imaging?encounterId=&petId=&customerId=`(Agent-03 域内,已实现,页面自动预填)
- 附件复用现有 files/attachments/R2(`createUploadIntent` 传 entityType='imaging_order',purpose='image'),未新建 imaging_files

## 8. 未完成项 / 已知边界

1. **Full Build 未能在本 Agent 侧通过**:共享工作树中其他 Agent(02/05/06/01)的在制品存在 TS typecheck 错误
   (`inpatient-boarding.ts`、`inpatient.ts`、`operations/memberships/index.vue`、`search.ts`、`customers.ts`、`system/tenants/*` 等),
   导致整仓 `vue-tsc -b` / `tsc -p api` 非零退出。**本 Agent 文件无 typecheck 错误**;请 Integrator 合并后统一处理。
2. 影像附件支持上传(图片),大文件走预签名直传;PDF/外院报告可后续补充 category 白名单。
3. `lab-workbench` 分页为「先取 500 再 JS 过滤」的 MVP 实现;数据量大时建议改为 DB 侧聚合。
4. 影像报告版本化:已发布报告不可直接改,修订走新版本行;`createImagingReport` 自动 v=max+1。
5. P0-26 冲突弹窗由页面 catch 识别 `e.response.status === 409` 触发;全局拦截器仍会先弹一个 toast(共享 api/index.ts 未改动)。

## 9. 风险

- 未跑真实 DB migration(`db:push`);建议 Integrator 在合并后对 59–61 做 dry-run。
- 影像类型 `catalog_item_id` 复用 catalog_items,未做价格/计费联动(收费折扣接入归 Agent-02)。
- 报告审核双签在 Hono 层校验;若后续要求更强的 DB 兜底,可补 RPC。

## 10. 验证证据

```text
- vue-tsc -b(apps/maoxianqiu):本 Agent 文件无错误(workbench / lab / imaging / api modules / types / router)
- tsc --noEmit -p api/tsconfig.json:diagnostics.ts 无错误
- vite build:结果见 /tmp/vite-build.log(待确认)
- 未运行 E2E(本批约定 E2E 独立,不改 e2e/**)
```
