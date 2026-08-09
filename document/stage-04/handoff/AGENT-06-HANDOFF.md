# AGENT-06-HANDOFF — Documents & Insurance（保险理赔 + PDF/归档 + 电子签名生命周期）

## STATUS

```text
code_complete
（未执行 tsc / vite build / pnpm db:reset：按任务约定跳过耗时编译与 DB 执行；
 真实运行时验证由 Agent-01 Runtime/UAT 负责；集成由 Agent-09 完成）
```

## SOURCE_RESEARCH

当前 main（非 Source13）已确认事实：

```text
1. 数据库写边界：前端 Supabase 直连仅允许只读（RLS 兜底），所有写操作必须走 Hono + service_role RPC
   → 本 Agent 全部写操作（建包/编辑/生成/状态流转/签名）均走 PostgreSQL RPC
2. requireScopedPermission(c, { code, tenantId, storeId, dataScope }) 是唯一授权入口，
   支持 dataScope 模式（门店级角色收敛到 allowedStoreIds）→ 所有新路由均已使用
3. 幂等机制：HTTP Idempotency-Key + RPC 内 (tenant_id, idempotency_key) 部分唯一索引 + 业务表内幂等返回
   → create_insurance_claim_pack / create_insurance_claim_export / create_signature_request 已实现
4. 乐观并发：create_insurance_claim_export 要求 p_pack_version = pack.version + 1（CAS 防止重复生成覆盖）
5. PDF 不可变归档：document_archives 无 updated_at 触发器；修订 → 新 archive + 旧 archive → superseded
6. 数据快照：只存必要字段 + data_hash（sha256），不存无边界医疗全文；items 只记录引用不复制业务真相
7. 双重权限门：PDF 生成除 documents.pdf.generate 外还需业务二次权限门
   （encounter.view / lab.view / imaging.view / invoice.view / vaccine.view / inpatient.view 等）
8. 已存在的可复用能力：api/lib/r2.ts（generatePrivateObjectKey / createPresignedDownloadUrl / headObject）、
   api/routes/files-v2.ts（create_upload_intent + complete_upload 模式）、writeAudit()、
   resolveRequestedTenant() / resolveRequestedStore()、apiClinical 关联查询、supabase 直连列表模式
9. 共享冻结确认：api/index.ts、apps/maoxianqiu/src/router/routes.ts 未修改（本 Agent 不碰）
10. 权限码来源：clinical（encounter.view 等）/ billing（invoice.view）/ diagnostics（lab.view, vaccine.view）/
    inpatient（inpatient.view）/ imaging（imaging.view）均已存在于既有模块
11. service-rpc-manifest.ts 为多 Agent 共享文件（非冻结）：已追加本 Agent 7 个 RPC，
    同时观察到 Agent-03/05/07/08 也追加了各自 RPC（wallet / crm growth / purchase / portal）——并发协作预期
12. 项目为 ESM：Node 内置模块必须 import 而非 require（保险服务已用 import { createHash } from 'node:crypto'）
```

## START_HEAD

```text
1bb3a079c3be00daa21a1e3477dbfeae13b6fc00 chore(stage04-02): harden production release and api runtime guard
```

## COMMIT_SHA

```text
（提交后回填，见提交记录）
```

## OWNED_FILES

```text
supabase/migrations/20260810000235_insurance_documents_archive.sql
api/lib/service-rpc-manifest.ts（共享文件：追加本 Agent 7 个 RPC 条目，同时含其他 Agent 条目）
api/providers/pdf/types.ts / mock.ts / external.ts / index.ts
api/providers/signature/index.ts
api/services/insurance/types.ts / aggregate.ts / snapshot.ts / render.ts / index.ts
api/services/document-artifacts/index.ts
api/routes/insurance.ts
api/routes/document-artifacts.ts
apps/maoxianqiu/src/types/insurance.ts
apps/maoxianqiu/src/api/modules/insurance.ts
apps/maoxianqiu/src/api/modules/document-artifacts.ts
apps/maoxianqiu/src/views/operations/insurance/index.vue
apps/maoxianqiu/src/views/operations/archives/index.vue
apps/maoxianqiu/src/router/modules/insurance.ts
document/stage-04/handoff/AGENT-06-HANDOFF.md（本文件）
```

## MODIFIED_EXISTING_FILES

```text
api/lib/service-rpc-manifest.ts
  - 追加 7 个高危 RPC 到 manifest（RPC ACL 静态清单）
  - 注意：该文件同时被 Agent-03/05/07/08 追加条目，本次提交包含共享最终内容
  （文件级并发不可避免，各 Agent 提交的是同一工作区最终版本）
```

## NEW_FILES

```text
api/providers/pdf/types.ts          PdfProvider 抽象（PdfRenderOptions/PdfRenderResult）
api/providers/pdf/mock.ts           mock 渲染（纯 JS 最小合法 PDF，零依赖，仅开发/CI）
api/providers/pdf/external.ts       external 渲染（HTTPS POST 透传 + SSRF 防护：拒绝 localhost/内网、可选白名单、禁止网络资源入口）
api/providers/pdf/index.ts          getPdfProvider() 按 PDF_PROVIDER 选择（默认 mock）
api/providers/signature/index.ts    SignatureProvider 抽象（internal/manual；合规边界：internal 仅表达内部流程，不宣称合法电子签名）
api/services/insurance/types.ts     白名单/枚举（INSURANCE_SOURCE_TYPES / PACK_STATUSES / INCLUDED_STATUSES）
api/services/insurance/aggregate.ts resolvePackScope + aggregatePackItems（按白名单聚合，imaging 用 imaging_reports!inner）
api/services/insurance/snapshot.ts  buildInsuranceSnapshot（必要字段 + data_hash）+ buildDocumentContent
api/services/insurance/render.ts    renderInsuranceClaimHtml（自包含 HTML + 转义）
api/services/insurance/index.ts     服务编排：createPack / updatePackItems / getPack / generatePack（幂等+乐观并发）/ listExports / transitionPack / uploadToR2
api/services/document-artifacts/index.ts
  通用 PDF 归档服务：DOCUMENT_SOURCES 注册表（8 类文档 → 源表/权限门/列白名单）、
  generatePdfArchive / listArchives / getArchive / createSignatureRequest
api/routes/insurance.ts
api/routes/document-artifacts.ts
apps/maoxianqiu/src/types/insurance.ts
apps/maoxianqiu/src/api/modules/insurance.ts
apps/maoxianqiu/src/api/modules/document-artifacts.ts
apps/maoxianqiu/src/views/operations/insurance/index.vue
apps/maoxianqiu/src/views/operations/archives/index.vue
apps/maoxianqiu/src/router/modules/insurance.ts
```

## MIGRATIONS

```text
supabase/migrations/20260810000235_insurance_documents_archive.sql
（Agent-06 号段 235–249 内第 1 个，唯一版本号；未修改 121 及以前任何 Migration）
```

## NEW_TABLES

```text
1. insurance_claim_packs                理赔包主表（status: draft/confirmed/archived/cancelled；version 乐观并发）
2. insurance_claim_pack_items           理赔包材料清单（只记录 source_type/source_id 引用，不复制业务真相）
3. insurance_claim_exports              理赔包导出记录（含 data_snapshot + data_hash + r2 key，幂等 + version CAS）
4. document_archives                    通用文档归档（不可变：无 updated_at 触发器；supersedes 链）
5. signature_requests                   签名请求（provider internal/manual；合规边界）
6. signature_events                     签名事件流（requested/sent/signed/rejected/expired）
7. signature_artifacts                  签名产物引用（link 到 signature_events + 归档）
```

## NEW_COLUMNS

```text
无（全部为新增表；未改动既有业务表）
```

## NEW_INDEXES

```text
1. insurance_claim_pack_items(claim_pack_id)
2. insurance_claim_packs(tenant_id, status, created_at desc)
3. insurance_claim_exports(claim_pack_id, created_at desc)
4. insurance_claim_exports 幂等唯一索引 (tenant_id, idempotency_key) where idempotency_key is not null
5. insurance_claim_pack_items(tenant_id, source_type, source_id)
6. document_archives(tenant_id, document_type, entity_id, created_at desc)
7. document_archives(tenant_id, idempotency_key) where idempotency_key is not null
8. signature_requests(tenant_id, archive_id, created_at desc)
9. signature_requests(tenant_id, idempotency_key) where idempotency_key is not null
10. signature_events(signature_request_id, created_at)
11. signature_artifacts(signature_request_id)
```

## NEW_RPCS

```text
1. create_insurance_claim_pack(tenant_id uuid, store_id uuid, title text, idempotency_key text,
   p_source_type text, p_source_id uuid, p_notes text)
   → 创建理赔包 + 明细聚合（RPC 内由明细 INSERT 幂等返回）
2. update_insurance_claim_pack_items(tenant_id uuid, pack_id uuid, p_items jsonb, p_idempotency_key text)
   → 仅 draft 可编辑，整单替换明细
3. transition_insurance_claim_pack(tenant_id uuid, pack_id uuid, p_to_status text, p_reason text)
   → 状态机 draft→confirmed→archived / draft→cancelled（含校验与审计字段）
4. create_insurance_claim_export(tenant_id uuid, pack_id uuid, p_version integer, p_data_snapshot jsonb,
   p_data_hash text, p_file_id uuid, p_object_key text, p_idempotency_key text, p_file_size bigint, p_mime text)
   → 幂等 + CAS（p_version = pack.version + 1 才推进）+ data_snapshot 不可变
5. create_signature_request(tenant_id uuid, archive_id uuid, p_recipient_name text, p_recipient_email text,
   p_recipient_phone text, p_message text, p_provider text, p_idempotency_key text)
   → 幂等创建签名请求 + 初始事件
6. transition_signature_request(tenant_id uuid, signature_request_id uuid, p_to_status text, p_note text)
   → requested→sent→signed / rejected / expired
7. record_signature_event(tenant_id uuid, signature_request_id uuid, p_event_type text, p_note text, p_meta jsonb)
   → 追加签名事件流（不可变）
```

## RPC_ACL

```text
Migration 内对上述 7 个 RPC 全部执行：
  revoke all on function ... from public;
  revoke all on function ... from anon;
  revoke all on function ... from authenticated;
  grant execute on function ... to service_role;
并同步登记到 api/lib/service-rpc-manifest.ts（静态清单，Agent-09 check:rpc-manifest 校验；
Agent-01 Runtime Gate 用 pg_proc + has_function_privilege() 做真实 ACL 验证）。
```

## PERMISSIONS

```text
新增 5 个权限码（RLS helper + 幂等补充 system_admin / store_manager）：
  insurance.view                 保险理赔包列表/详情（ROUTE + RLS）
  insurance.generate             理赔包生成导出（与 documents.pdf.generate 组成双重权限门）
  documents.pdf.generate         通用 PDF 生成（与业务二次权限门组合）
  documents.archive.view         归档中心列表/下载/签名记录
  documents.signature.manage     发起/流转签名请求
```

## API_ROUTES

```text
api/routes/insurance.ts（前缀 /insurance，authMiddleware + loadCaller + loadContext）：
  POST /claim-packs                      创建理赔包（insurance.view + resolvePackScope 真实归属校验）
  POST /claim-packs/:id/items            编辑 draft 明细（insurance.view）
  POST /claim-packs/:id/generate         生成导出（insurance.generate + documents.pdf.generate 双重授权；Idempotency-Key）
  GET  /claim-packs/:id                  包详情 + 明细（insurance.view）
  GET  /claim-packs/:id/exports          导出历史（documents.archive.view）
  POST /claim-packs/:id/transition       状态流转（insurance.view）
  全部路由含 writeAudit

api/routes/document-artifacts.ts（前缀 /document-artifacts）：
  POST /:documentType/:entityId/pdf      通用 PDF 归档（documents.pdf.generate + 按文档类型的业务二次权限门）
  GET  /archives                         归档列表（documents.archive.view + dataScope）
  GET  /archives/:id/download            预签名下载（documents.archive.view）
  GET  /archives/:id/signatures          签名请求列表（documents.archive.view）
  POST /archives/:id/sign                发起签名（documents.signature.manage；Idempotency-Key）
  全部路由含 writeAudit
```

## FRONTEND_ROUTES

```text
apps/maoxianqiu/src/router/modules/insurance.ts（新领域文件，未修改共享 routes.ts）：
  /operations/insurance    保险理赔（meta.auth: insurance.view）
  /operations/archives     归档中心（meta.auth: documents.archive.view）
```

## MENU_REGISTRATION_REQUEST

```text
给 Agent-09（Final Integrator）：
  1. 在 apps/maoxianqiu/src/router/routes.ts 注册：
     import InsuranceModule from './modules/insurance'
     并挂入 operations 菜单分组
  2. 可选：在菜单文案中加入两个入口：
     - 运营中心 → 保险理赔（/operations/insurance）
     - 运营中心 → 文档归档（/operations/archives）
  3. 权限码展示建议：insurance.view / insurance.generate / documents.pdf.generate /
     documents.archive.view / documents.signature.manage 加入权限管理种子
```

## ENV_VARS

```text
PDF_PROVIDER=mock（默认；生产应切换 external）  —— 取值 mock | external
PDF_WORKER_URL=                                —— external 渲染 worker HTTPS 地址
PDF_WORKER_HOST_ALLOWLIST=                     —— 可选；external worker 域名白名单（SSRF 第二道防线）
SIGNATURE_PROVIDER=internal（默认）             —— 取值 internal | manual
```

## CROSS_DOMAIN_CONTRACTS

```text
1. Agent-08 Portal：document_archives 已含 customer_visible 位，Portal 可只读展示 customer-visible 归档
   （RPC 只读 + RLS；本 Agent 提供 document-artifacts GET 路由，Portal 若需公网只读接口可在 Handoff 对接）
2. Agent-02 Release：PDF/Signature Env 变量声明如上，可提升为 release-preflight 必填项（见 Agent-02 的
   ENVIRONMENT-MATRIX PENDING 清单）
3. Agent-01 Runtime Gate：7 个新 RPC 的 ACL 验证（pg_proc + has_function_privilege）、
   RLS 矩阵（authenticated 对 7 表只读、service_role 全权）
4. service-rpc-manifest.ts 共享文件：本 Agent 条目 + Agent-03(wallet)/05(crm growth)/07(purchase)/
   08(portal) 条目并存，Agent-09 check:rpc-manifest 需按全部 Agent 的 RPC 清单核对
```

## TESTS_RUN

```text
按任务约定未执行 tsc / vite build / pnpm db:reset（耗时）。
已执行：
  - git diff --check（提交前，见 TEST_RESULTS）
  - 前端组件惯例静态自检：无 FaOption 插槽 / #footer 残留；FaModal 使用 :footer="false"
  - 文件完整性核对：后端 2 路由 + 2 服务 + 2 provider 目录、前端 2 页面 + 2 API 模块 + 1 路由模块 + 1 类型文件均存在
  - service-rpc-manifest.ts 核对：本 Agent 7 个 RPC 均在清单内（行 181–187）
```

## TEST_RESULTS

```text
git diff --check: PASS（无空白错误）
（tsc / build / db:reset 留待 Agent-01/09/发布流程执行）
```

## KNOWN_GAPS

```text
1. PostgREST 嵌入关系命名未在真实 DB 验证：
   - api/services/insurance/aggregate.ts 使用 imaging_reports!inner(id, status) 关联 imaging_orders
   - api/services/insurance/snapshot.ts 使用 imaging_reports(imaging_orders(order_no, imaging_type))
   imaging_orders 与 imaging_reports 互有外键，PostgREST 可能存在歧义/嵌套命名差异，
   需 Agent-01 在真实库验证；若报错，调整关系名（如 imaging_orders!report_id）即可
2. Migration 未执行：20260810000235 未经 pnpm db:reset 验证（用户禁止执行）；
   表/索引/权限 SQL 语法与幂等逻辑由 Agent-01/09 在实际环境确认
3. INSURANCE_INCLUDED_STATUSES 中 invoice 含 confirmed：业务口径（理赔材料是否接受已确认账单）
   需与业务确认；当前实现按白名单过滤，调整只需改常量
4. Mock PDF 仅支持 ASCII：中文会替换为 '?'；生产必须切换 PDF_PROVIDER=external（已写注释）
5. signature 合规边界：internal provider 仅表达内部流程，UI 不得宣称"已完成合法可靠电子签名"；
   真实司法效力需引入第三方 e-signature（manual provider 预留）
```

## DEFERRED

```text
- 真实 PDF 渲染质量验证（external provider 接入）：待生产环境部署
- 第三方 e-signature provider（manual）：待合规评估
- 菜单集成 / 权限种子：Agent-09
- 运行时 ACL / RLS 矩阵验证：Agent-01
```

## INTEGRATION_REQUESTS

```text
给 Agent-09（Final Integrator）：
1. api/index.ts 挂载（冻结文件，仅 Agent-09 可改）：
   import { insuranceRoutes } from './routes/insurance.js'
   import { documentArtifactRoutes } from './routes/document-artifacts.js'
   app.route('/insurance', insuranceRoutes)
   app.route('/document-artifacts', documentArtifactRoutes)
2. apps/maoxianqiu/src/router/routes.ts 集成（冻结文件）：
   import InsuranceModule from './modules/insurance'
3. 菜单/权限种子（见 MENU_REGISTRATION_REQUEST）
4. 环境变量声明（见 ENV_VARS），建议并入 release-preflight 必填项
5. check:rpc-manifest 核对时纳入本 Agent 7 个 RPC 名称

给 Agent-01（Runtime/UAT）：
1. 验证 20260810000235 migration 可执行、RPC ACL 正确（pg_proc + has_function_privilege）
2. 验证 PostgREST 嵌入关系（见 KNOWN_GAPS 1）
3. 冒烟：/insurance/claim-packs 创建 → 编辑 → generate → exports；
   /document-artifacts/{encounter|lab_report|imaging_report}/{id}/pdf → archives → download → sign
```

## ROLLBACK_NOTES

```text
- 本 Agent 全部交付物为新增文件 + service-rpc-manifest.ts 追加条目，无对既有业务表的 DDL 修改。
- 回滚方式：git revert 本 commit；service-rpc-manifest.ts 回退会丢失其他 Agent 的条目
  （文件级并发），故不建议整体 revert 该文件，应由 Agent-09 在集成阶段统一整理。
- DB 层：如需下线功能，DROP 7 张新表 + 7 个 RPC（新表无 upstream 依赖）；
  既有数据表（encounters/lab_reports/imaging_reports/invoices 等）未做任何变更。
```

## 完成条件对照

```text
- Migration 235（号段正确）：✅ 20260810000235_insurance_documents_archive.sql
- 高危 RPC + manifest + revoke/grant：✅ 7 RPC 全部登记 + Migration DO 块 ACL
- 写操作全部走 Hono + RPC（无浏览器直写关键数据）：✅
- 全部 Hono 路由 requireScopedPermission：✅
- 幂等（PDF 生成 / 签名请求 / 建包 / 导出）：✅
- 乐观并发（export 版本 CAS）：✅
- 不可变归档（无 updated_at 触发器 + supersede 链）：✅
- 双重权限门（documents.pdf.generate + 业务二次权限门）：✅
- 前端只读直连 + 写走 API 模块：✅
- Handoff 完成：✅（本文件）
```

提交信息（由本 Agent 执行）：

```text
feat(stage04-06): implement insurance claim packs, pdf archive and signature lifecycle
```
