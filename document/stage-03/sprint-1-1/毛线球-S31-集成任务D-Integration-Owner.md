# 毛线球 Stage-03 / S3.1 集成任务 D
## Integration Owner（合并、回归、文档、最终交付）

> 角色：第 4 位员工 / Integration Owner  
> 开始条件：A/B/C 三个开发分支均达到 branch `code_complete`。  
> 你不是第四个业务开发者，只负责合并和收口。

## 1. 输入
必须收到 A/B/C 的 branch、HEAD SHA、commit list、migration list、changed files、permissions、RPC、audit、tests、known issues、CONFLICT_PRONE_FILES。

## 2. Migration
A=`35~38`，B=`39~43`，C=`44~49`。

确认：无重复编号、无旧 migration 被偷偷改、依赖顺序正确。

merge-only migration 如确有必要从 `50` 开始，但尽量避免。

## 3. Manifest
合并后扫描所有 `service.rpc()`：`route unique RPC ⊆ SERVICE_ROLE_ONLY_RPC`，`missing=0`。

前端生产源码 direct `.rpc()` 必须为 `0`。

新增 Command RPC 必须有 revoke public/anon/authenticated + grant service_role。

## 4. Permission Reconciliation
统一检查 tenant_owner、store_manager、doctor、nurse、cashier 的 scope、role_permissions、roles.permissions、seed、UI route、Hono、RLS 是否一致。

禁止：store role 被放大 tenant-wide；医生拿财务确认；cashier 拿医疗签署；nurse 拿租户配置。

## 5. Shared Files
重点人工 reconciliation：`service-rpc-manifest.ts`、router、menu、components.d.ts、permission seed、shared model/picker。

禁止整文件 ours/theirs 覆盖。

## 6. Router / Menu
确认 Tenant Initialization、Daily Closing、Reconciliation、Nursing、Lab Samples、Critical Value、Inpatient Progress、Discharge 都可正常访问，无重复 route/path/menu permission。

## 7. Migration 静态检查
检查 function default 参数、FK、unique、RLS、grant/revoke、search_path、index、check 状态、重复 table/permission/function/signature。

## 8. 跨模块回归
至少验证：

- Tenant Init → Store/Warehouse/Payment Context
- Billing → Daily Closing → Reconciliation
- Clinical Order → Nurse Task
- Lab Sample → Result → Medical Record
- Admission → Charges → Payment → Discharge → Archive Deadline

## 9. SQL Tests
汇总并检查：

`rpc_security.sql`
`compliance_s3_1.sql`
`regulatory_s3_1.sql`
`permission_integration_s3_1.sql`
`tenant_initialization_s3_1.sql`
`daily_closing_s3_1.sql`
`reconciliation_s3_1.sql`
`medical_loop_s3_1.sql`

必须：合法 UUID、auth.user/employee ID 语义正确、依赖明确、无 silent skip。

## 10. E2E
保留原 A/B/C 闭环，并建议新增：

- Loop D：tenant init → usable store
- Loop E：billing → closing → reconciliation
- Loop F：admission → settlement → discharge

无 staging 时只能标 `code_complete / integration_pending`。

## 11. Build Gate
实际运行并保留原始输出：

`pnpm check:rpc-manifest`
`pnpm lint`
`pnpm typecheck`
`pnpm build`

如 monorepo 无统一 typecheck，则跑 frontend vue-tsc / api tsc / e2e tsc。

## 12. Current Docs
只有你负责更新：

`IMPLEMENTATION_STATUS.md`
`KNOWN_GAPS.md`
`RELEASE_CHECKLIST.md`

统计必须来自最终合并源码实际命令，不复制历史数字。

## 13. 最终状态
静态合并通过后：

Tenant Initialization = code_complete
Daily Closing = code_complete
Reconciliation = code_complete
Medical Loop = code_complete
S3.1 current batch = code_complete
runtime = integration_pending

无 staging 不得写 verified/pilot_ready/production_ready。

## 14. Final Checklist
- A/B/C 全部 merge
- 无 unresolved conflict
- migration 无碰撞
- 无旧 migration 意外覆盖
- manifest missing=0
- frontend direct RPC=0
- permission scope 一致
- RLS/Hono 语义一致
- router/menu 完整
- shared components 无回退
- lint/typecheck/build PASS
- tests 静态可执行
- current docs 更新
- runtime 状态诚实

## 15. 最终交付给审计方
提交：

1. 合并后完整源码 ZIP
2. 最终 HEAD SHA
3. git rev-parse HEAD
4. git log -1 --oneline
5. git status --short
6. A/B/C commit lists
7. conflict resolution list
8. migration 35~49 list
9. merge-only migration（如有）
10. permission reconciliation report
11. RPC manifest reconciliation report
12. router/menu reconciliation report
13. SQL test list
14. E2E test list
15. check:rpc-manifest/lint/typecheck/build 原始输出
16. 最新 IMPLEMENTATION_STATUS / KNOWN_GAPS / RELEASE_CHECKLIST

如有 staging，再附 migration logs、SQL test logs、E2E report、/api/health、Preview URL。

完成后停止，不开始 Customer 360 / Membership / Marketing / C-end / AI。
