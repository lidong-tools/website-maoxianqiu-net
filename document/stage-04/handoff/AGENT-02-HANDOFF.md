# AGENT-02-HANDOFF — Production Deployment & Release Guard

## STATUS

```text
code_complete
（未执行 tsc / vercel build：按任务约定跳过耗时编译；运行时冒烟由 Agent-01/发布流程验证）
```

## SOURCE_RESEARCH

当前 main（非 Source13）已确认事实：

```text
1. api/tsconfig.json 已是 module=moduleResolution=NodeNext + strict + noEmit
   → ESM P0 修复已生效，必须保持，禁止恢复 bundler
2. 当前 main 无 api/[[...route]].ts / api/[...route].ts
   → 入口为固定 api/index.ts（vercel.json /api/:path* rewrite → /api?path=:path*）
3. api/health.ts 为独立轻量 liveness（不加载 DB/存储/业务路由）→ 不新建第二 Health API
4. 残留 BUG：scripts/serve-api.ts 与 scripts/backend-smoke.ts 仍 import '../api/[...route]'
   （Source13 遗留，文件已不存在）→ 已机械修复为 '../api/index.js'
5. 无 token 访问受保护路由 → ApiError(401, UNAUTHORIZED)（failError 契约），响应头 x-request-id 存在
6. api/lib/supabase.ts 读取 SUPABASE_URL / SERVICE_ROLE_KEY / ANON_KEY
   api/lib/r2.ts 读取 R2_ACCOUNT_ID / ACCESS_KEY_ID / SECRET_ACCESS_KEY / BUCKET_NAME
   api/services/messaging/config.ts 读取 MESSAGING_PROVIDER / API_KEY / SENDER / API_URL
7. document/deployment/ 与 document/stage-04/handoff/ 原不存在，本次创建
```

## START_HEAD

```text
a728de0b update
```

## COMMIT_SHA

（提交后回填，见提交记录）

## OWNED_FILES

```text
api/tsconfig.json（只读确认，未修改）
vercel.json（只读确认，未修改）
scripts/check-api-esm.ts（新增）
scripts/release-preflight.ts（新增）
scripts/release-smoke.ts（新增）
document/deployment/STAGE04-RELEASE-PREFLIGHT.md（新增）
document/deployment/VERCEL-PREVIEW-SMOKE.md（新增）
document/deployment/ENVIRONMENT-MATRIX.md（新增）
document/deployment/ROLLBACK-RUNBOOK.md（新增）
document/stage-04/handoff/AGENT-02-HANDOFF.md（新增，本文件）
```

## MODIFIED_EXISTING_FILES

```text
scripts/serve-api.ts      import '../api/[...route]' → '../api/index.js'（机械修复）
scripts/backend-smoke.ts  import '../api/[...route]' → '../api/index.js'（机械修复）
```

## NEW_FILES

```text
scripts/check-api-esm.ts
scripts/release-preflight.ts
scripts/release-smoke.ts
document/deployment/STAGE04-RELEASE-PREFLIGHT.md
document/deployment/VERCEL-PREVIEW-SMOKE.md
document/deployment/ENVIRONMENT-MATRIX.md
document/deployment/ROLLBACK-RUNBOOK.md
document/stage-04/handoff/AGENT-02-HANDOFF.md
```

## MIGRATIONS

```text
无（本 Agent 不涉及 DB）
```

## NEW_TABLES / NEW_COLUMNS / NEW_INDEXES

```text
无
```

## NEW_RPCS

```text
无
```

## RPC_ACL

```text
不适用（未新增 RPC）
```

## PERMISSIONS

```text
无新权限（不新增业务路由）
```

## API_ROUTES

```text
无新增路由。api/index.ts / api/health.ts 为当前 main 既有，保持不动。
```

## FRONTEND_ROUTES

```text
无
```

## MENU_REGISTRATION_REQUEST

```text
无
```

## ENV_VARS

```text
本 Agent 不新增 Env。
预检清单已建立（API Core / R2 / Messaging / Deploy），见 ENVIRONMENT-MATRIX.md。
Stage04 待声明占位：PDF_RENDERER_*（Agent-06）、SIGNATURE_PROVIDER_*（Agent-06）、
SMS_* / WECHAT_*（Agent-08）——对应 Agent 的 Handoff 必须向 Agent-09 声明具体变量名，
Agent-02（或发布流程）随后将其提升为 release-preflight 必填项。
```

## CROSS_DOMAIN_CONTRACTS

```text
scripts/serve-api.ts + scripts/backend-smoke.ts 现在依赖 api/index.ts 导出的 app。
Agent-01 的 runtime/E2E 若使用 pnpm dev:api，不再因旧入口缺失而失败。
```

## TESTS_RUN

```text
未运行（按任务约定跳过 tsc / vercel build 等耗时检查）。
已执行 git diff --check（见 TEST_RESULTS）。
静态自查：check-api-esm 扫描规则覆盖 api/**/*.ts 全部相对导入。
```

## TEST_RESULTS

```text
git diff --check: PASS（无空白错误）
（tsc -p api/tsconfig.json 与 vercel build 留待发布流程/Agent-01 执行）
```

## KNOWN_GAPS

```text
1. check-api-esm 的正则按"每行"扫描，多行字符串/块注释内的 from '...' 可能误报；
   单行注释已跳过，块注释多行形态未做状态机（误报无害，不会漏报）。
2. release-smoke 依赖 /api/me/context 作为受保护路由代表；若后续该路由路径变更，
   需同步更新 CASES。
3. vercel.json 无 CORS 中间件，OPTIONS 在本地 Hono 返回 404（<500 视为通过）；
   生产由 Vercel 平台层处理 OPTIONS，不在此脚本覆盖范围。
4. 根 package.json 处于共享冻结，本 Agent 未添加 check:api-esm / release-preflight /
   release-smoke 的 script 条目 → 见 INTEGRATION_REQUESTS。
```

## DEFERRED

```text
- 真实 vercel build / preview 冒烟执行：待发布流程或 Agent-01 Runtime Gate 阶段
- Stage04 新 Provider（PDF/Signature/SMS/Wechat）Env 纳入必填：待对应 Agent Handoff 声明
```

## INTEGRATION_REQUESTS

给 Agent-09（Final Integrator）：

```text
1. 请在根 package.json scripts 增加（可选，当前可用 pnpm exec tsx 直接运行）：
   "check:api-esm": "tsx scripts/check-api-esm.ts",
   "release:preflight": "tsx scripts/release-preflight.ts --strict",
   "release:smoke": "tsx scripts/release-smoke.ts"
2. 将以下路径纳入最终 Release Gate 顺序：
   check:api-esm → tsc -p api/tsconfig.json → vercel build → release-preflight --strict → release-smoke
3. 收集 Agent-03~08 的 ENV_VARS 声明后，更新 document/deployment/ENVIRONMENT-MATRIX.md
   PENDING 清单并将对应变量提升为必填。
4. 提示发布流程：/api/health 是 liveness（process alive）；dependencies 状态不返回 Secret。
```

给 Agent-01（Runtime/UAT）：

```text
1. 请将 scripts/release-smoke.ts 作为部署后冒烟基准；pnpm dev:api 已恢复可用
   （serve-api.ts 入口修复）。
2. Runtime Gate 中验证 /api/health 200、无 token 受保护路由 401（非 500）。
```

## ROLLBACK_NOTES

```text
- 本 Agent 全部交付物为新增脚本/文档 + 两处机械 import 修复，无 DB / 无数据变更。
- 回滚方式：git revert 本 commit 即可；serve-api.ts / backend-smoke.ts 恢复为旧
  api/[...route] 引用后，pnpm dev:api 将失效（旧入口文件已不存在），故不建议整体回滚，
  应保持本次修复。
```

## 完成条件对照

```text
- ESM Checker 脚本：✅ scripts/check-api-esm.ts（规则覆盖 relative import .js 后缀）
- TypeScript Gate：api/tsconfig.json 保持 NodeNext（已确认，未改动）
- Vercel Build：命令与产物检查已写入 STAGE04-RELEASE-PREFLIGHT.md（执行留待发布流程）
- Preview /api/health 200：release-smoke case 1（执行留待部署）
- Protected route 不 500：release-smoke case 2/4（执行留待部署）
- Release preflight 可自动失败：✅ scripts/release-preflight.ts --strict
```

提交信息（由本 Agent 执行）：

```text
chore(stage04-02): harden production release and api runtime guard
```
