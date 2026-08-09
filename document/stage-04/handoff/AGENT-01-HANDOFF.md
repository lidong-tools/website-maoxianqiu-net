# AGENT-01 HANDOFF — Runtime / UAT / DB Gate(Stage-04 Wave 0)

> 编写:Agent-01  
> 时间:2026-08-09  
> 说明:Wave 0 交付"运行时安全工具 + 验证资产 + UAT 计划";实库执行与 E2E/Manual UAT 在 Wave 3(业务 Agent Wave 1 完成后)。

## STATUS

```text
code_complete
(Wave 0 foundation 交付完成;runtime_gate_pass 需 Wave 3 实库验证后才可声明)
```

## SOURCE_RESEARCH

- 当前 main `scripts/e2e-setup.sh` 已具备 `set -euo pipefail` + 环境变量强校验 + `E2E_USERNAME/E2E_PASSWORD` 统一命名,并已移除 `PGPASSWORD="$E2E_ACCOUNT_PASSWORD"` 错误语义(Source13 的三个隐患在 main 上已修);
- 残留缺口:`supabase db reset --linked --yes` 无 destructive 安全门;无 `RUNTIME_DB_MODE` 显式模式;
- `api/lib/service-rpc-manifest.ts` 导出 `SERVICE_ROLE_ONLY_RPC`(含已出现的 Stage-04 保险/签名 RPC 名,证明 Wave 1 Agent 会继续追加 → 动态读取设计正确);
- 权限模型(`20260810000093_permission_helper_restore.sql`):`has_permission(scope 感知)` / `can_access_store` / `is_tenant_member` / `is_tenant_business_active`(active 或 trial 未过期),platform_admin 短路;
- 系统角色(seed.sql):system_admin / tenant_owner(tenant scope) / store_manager / staff / cashier / doctor / nurse(store scope);staff 仅持 `store:view`;无内置 inventory 角色;
- 现有测试模式(`supabase/tests/*`):事务内 `begin/rollback` + `tests.assert_true` + `set local role authenticated` + `set_config('request.jwt.claims')` 夹具;roles.code 全局唯一;
- E2E:workers=1、hash 路由、`e2e/helpers/{auth,api,browser}.ts` 可复用;无 CI workflow。

## START_HEAD

```text
a728de0b update
```

## COMMIT_SHA

f3254ff9 test(stage04-01): establish runtime db e2e and manual uat gate

## OWNED_FILES

```text
scripts/e2e-setup.sh
scripts/runtime-common.sh
scripts/runtime-blank-db.sh
scripts/runtime-rpc-acl-check.ts
supabase/tests/stage04_rls_matrix.sql
document/testing/**
```

## MODIFIED_EXISTING_FILES

```text
scripts/e2e-setup.sh
  - 接入 runtime-common.sh(destructive reset 安全门 + production 识别)
  - 统一命名 E2E_USERNAME/E2E_PASSWORD,兼容旧名 E2E_ACCOUNT_EMAIL/E2E_ACCOUNT_PASSWORD(仅 fallback)
```

## NEW_FILES

```text
scripts/runtime-common.sh            共享门禁(env 强校验 / production 识别 / destructive reset 安全门 / 门禁报告)
scripts/runtime-blank-db.sh          Blank DB Migration Gate(空库→migrations→seed→schema 断言→报告)
scripts/runtime-rpc-acl-check.ts     RPC ACL Runtime Gate(psql + pg_proc + has_function_privilege,动态读 manifest)
supabase/tests/stage04_rls_matrix.sql  RLS 角色矩阵 M1~M11(5 租户/6 门店/13 用户,含 suspended/trial 状态)
document/testing/STAGE04-RUNTIME-GATE.md
document/testing/STAGE04-RLS-RPC-REPORT.md
document/testing/STAGE04-E2E-REPORT.md
document/testing/STAGE04-MANUAL-UAT-PLAN.md
document/testing/STAGE04-MANUAL-UAT-RESULT.md
document/testing/STAGE04-PILOT-BLOCKERS.md
document/stage-04/handoff/AGENT-01-HANDOFF.md
```

## MIGRATIONS

```text
无(未新增/修改任何 migration)
```

## NEW_TABLES / NEW_COLUMNS / NEW_INDEXES

```text
无
```

## NEW_RPCS

```text
无(不新增业务 RPC;runtime-rpc-acl-check.ts 动态覆盖 Agent-03~08 后续加入 manifest 的所有高危 RPC)
```

## RPC_ACL

```text
本 Agent 未新增 RPC,故无 ACL 变更。
G3 Runtime ACL 验证工具:scripts/runtime-rpc-acl-check.ts(执行方式见 document/testing/STAGE04-RLS-RPC-REPORT.md)
```

## PERMISSIONS

```text
无新增权限码。
测试资产 stage04_rls_matrix.sql 依赖 seed 系统角色(tenant_owner/store_manager/doctor/nurse/cashier/staff)
+ 测试内自定义门店级角色 inventory_role_matrix(scope='store',is_system=false)。
```

## API_ROUTES / FRONTEND_ROUTES / MENU_REGISTRATION_REQUEST

```text
无(本 Agent 不新增页面/API;不触碰共享入口)
```

## ENV_VARS

```text
脚本运行所需(非新增系统级变量):
  DATABASE_URL                    : PostgreSQL 连接串(psql 断言)
  RUNTIME_DB_MODE                 : local | staging-reset | upgrade-rehearsal(默认 local)
  ALLOW_DESTRUCTIVE_DB_RESET      : 显式 YES 才允许 db reset
  SUPABASE_PROD_PROJECT_REFS      : 可选,逗号分隔生产 project ref
  E2E_USERNAME / E2E_PASSWORD     : e2e 统一命名(兼容 E2E_ACCOUNT_EMAIL/PASSWORD fallback)
```

## CROSS_DOMAIN_CONTRACTS

```text
无(本 Agent 不提供业务契约;仅依赖 Agent-03~08 完成后的 Runtime/RLS/API 面)
依赖:Agent-03~08 的 Migration/API/RPC 完成后,本 Gate 才能跑 G5 新域用例与 E2E。
```

## TESTS_RUN

```text
bash -n(Git Bash)验证:
  scripts/runtime-common.sh      exit=0(语法 PASS)
  scripts/runtime-blank-db.sh    exit=0(语法 PASS)
  scripts/e2e-setup.sh           exit=0(语法 PASS)

tsx smoke(无 DB 副作用):
  pnpm exec tsx scripts/runtime-rpc-acl-check.ts --emit-sql  exit=0
  → manifest 全量函数已正确生成 VALUES 列表并输出期望矩阵说明(含 Stage-04 新 RPC 名)

未执行(遵循用户指令,不做耗时全量检查):tsc / vue-tsc / eslint / vite build / 实库 SQL(需 DB)
```

## TEST_RESULTS

```text
bash 语法:3/3 PASS
rpc-acl 脚本 emit-sql smoke:1/1 PASS
实库 gate(Blank DB / RLS Matrix / RPC ACL / E2E / UAT):待 Wave 3(需要可运行 Supabase 库 + 业务 Agent 完成)
```

## KNOWN_GAPS

```text
1. runtime-blank-db.sh 的 schema 断言依赖 psql;psql 缺失时标记 SKIPPED(以 db reset 结果为准)
2. Existing DB Upgrade Gate(G2)需要 Stage-03 最终 schema 快照/测试库,当前无此快照,已记 DEFERRED
3. Stage-04 新域 E2E spec(stage04-*.spec.ts)依赖 Agent-03~08 的 API 就绪,按编排 Wave 3 编写
4. 本地 PowerShell 无 bash,脚本须在 Git Bash / CI 执行(Windows 已用 Git Bash 验证语法)
```

## DEFERRED

```text
1. G2 Existing DB Upgrade 执行(待 Stage-03 快照/测试库)
2. G5 新域 Domain Runtime Case 实库执行(依赖 Agent-03~08)
3. G6 stage04-*.spec.ts 六个新 E2E(编排 Wave 3)
4. G7 Manual UAT 执行(编排 Wave 3)
5. document/current/* 三份共享文档更新(冻结给 Agent-09,本 Agent 不写)
```

## INTEGRATION_REQUESTS

```text
1. [Agent-09] 本 Agent 在 Wave 3 需可运行 Supabase 库(staging-reset 需 ALLOW_DESTRUCTIVE_DB_RESET=YES 显式授权)
2. [Agent-09] G2 Existing Upgrade 需要 Stage-03 最终 schema 快照或专用测试库
3. [Agent-03~08] 新高危 RPC 必须加入 api/lib/service-rpc-manifest.ts + migration revoke/grant
   (runtime-rpc-acl-check.ts 会自动覆盖,否则 G3 FAIL 归因到对应 Agent)
4. [Agent-01 Wave 3] 将新建 stage04-*.spec.ts 六个 E2E 文件(e2e/ 目录属本 Agent ownership)
```

## ROLLBACK_NOTES

```text
全部为新增文件 + 单文件定向修改:
- scripts/e2e-setup.sh:仅增加安全门与变量 fallback,原逻辑(账号重建/前置数据 SQL)未动;
  回滚 = git checkout scripts/e2e-setup.sh
- 其余为纯新增文件,删除即回滚(无业务 Migration/无共享入口改动)
- 无破坏性操作,不触碰 121 及以前 Migration
```

## 提交

```text
test(stage04-01): establish runtime db e2e and manual uat gate
```
