# Stage-04 Runtime Gate 总览(Agent-01)

> 维护者:Agent-01(Runtime/UAT/DB Gate)  
> 基线:main @ `a728de0b`(Stage-04 Wave 0)  
> 当前状态:**PILOT_READY = NO**(业务 Agent Wave 1 尚未完成,本 Gate 处于 foundation 阶段)

## 1. Gate 定义与工具映射

| Gate | 工具/资产 | 状态 |
|---|---|---|
| G1 Blank DB Migration | `scripts/runtime-blank-db.sh` | ⏳ 工具就绪,待 Wave 3 实库执行 |
| G2 Existing DB Upgrade | `scripts/runtime-blank-db.sh`(upgrade-rehearsal 模式)+ Stage-03 快照 | ⏳ 待 Stage-03 快照/测试库提供 |
| G3 RPC ACL Runtime | `scripts/runtime-rpc-acl-check.ts`(psql + pg_proc + has_function_privilege) | ⏳ 工具就绪,待 Wave 3 实库执行 |
| G4 RLS Matrix | `supabase/tests/stage04_rls_matrix.sql` | ⏳ 资产就绪,待实库执行 |
| G5 新域 Domain Runtime | `document/testing/STAGE04-RUNTIME-GATE.md` §4(用例矩阵) | ⏳ 依赖 Agent-03~08 完成 |
| G6 E2E | `document/testing/STAGE04-E2E-REPORT.md`(扩展计划) | ⏳ Wave 3 编写 stage04-*.spec.ts |
| G7 Manual UAT | `document/testing/STAGE04-MANUAL-UAT-PLAN.md` | ⏳ 计划就绪,待执行 |

状态图例:✅ PASS / ❌ FAIL / ⏳ 待执行 / 🧩 依赖业务 Agent

## 2. Wave 0 已交付的运行时安全工具

### 2.1 destructive reset 安全门

任何涉及 `supabase db reset` 的工具(`scripts/e2e-setup.sh` / `scripts/runtime-blank-db.sh`)
必须同时满足:

```bash
RUNTIME_DB_MODE=local|staging-reset        # upgrade-rehearsal 禁止 reset
ALLOW_DESTRUCTIVE_DB_RESET=YES             # 显式开关,绝不默认开启
# production 识别(命中任一即拒绝):
#   - SUPABASE_PROD_PROJECT_REFS 包含当前 project ref
#   - project ref / SUPABASE_URL / DATABASE_URL 含 production/-prod-/prod 标识
# 非 CI 环境还需交互确认 [y/N]
```

共享实现:`scripts/runtime-common.sh`(`require_destructive_reset` / `detect_production`)。

### 2.2 E2E 环境重建加固(scripts/e2e-setup.sh)

- `set -euo pipefail` + 环境变量强校验(任何副作用之前)✅(已有)
- `supabase db reset --linked --yes` 前必经 destructive 安全门 ✅(本次新增)
- 统一命名 `E2E_USERNAME`/`E2E_PASSWORD`,兼容旧名 `E2E_ACCOUNT_EMAIL`/`E2E_ACCOUNT_PASSWORD`(仅 fallback)✅(本次新增)
- 禁止 `PGPASSWORD="$E2E_PASSWORD"`(数据库密码与 Auth 用户密码严格分离)✅(已有)

## 3. G3 RPC ACL Runtime Gate 判定口径

对 `api/lib/service-rpc-manifest.ts` 全部 `SERVICE_ROLE_ONLY_RPC` 逐一验证:

```text
public        不可执行
anon          不可执行
authenticated 不可执行
service_role  可执行
```

- 函数在 DB 中不存在(manifest 与 DB 漂移)→ FAIL(MISSING)
- 任一角色位不符合 → FAIL
- 全部符合 → PASS

工具: `pnpm exec tsx scripts/runtime-rpc-acl-check.ts`(需要 `DATABASE_URL` + psql)
无 psql 环境: `pnpm exec tsx scripts/runtime-rpc-acl-check.ts --emit-sql` 输出 SQL 供 SQL Editor 执行。

## 4. G5 新域 Domain Runtime 用例矩阵(执行口径)

Wave 3 实库验证时按下表执行,任一 FAIL 记 P0/P1(见 §7 严重级别):

| 域 | Owner Agent | 必须验证的场景 |
|---|---|---|
| Wallet | Agent-03 | 充值 100;并发扣款 80+80 仅一个成功;余额不能为负;重复 idempotency 不重复扣;退款只返一次 |
| Medication Safety | Agent-04 | Blocking 规则真阻止;Warning 可继续;Override 需 permission+reason;旧 rule version 可追溯 |
| CRM/Marketing | Agent-05 | 同一客户 Segment 解释稳定;Coupon quota 并发不超发;Package redemption 不重复 |
| Documents/Insurance | Agent-06 | PDF hash 稳定;Archive object 可下载;跨 Tenant archive 不可读 |
| Supply Chain | Agent-07 | Purchase Return 两次 post 不重复减库存;Opening Stock consumer 重试不重复入库 |
| Portal/Messaging | Agent-08 | 未授权家庭成员看不到宠物;未发布报告不可见;Webhook 重放不重复改状态 |

## 5. 报告文件

```text
document/testing/STAGE04-RUNTIME-GATE.md        本文件
document/testing/STAGE04-RLS-RPC-REPORT.md      G3/G4 详细结果
document/testing/STAGE04-E2E-REPORT.md          G6 现状与扩展计划
document/testing/STAGE04-MANUAL-UAT-PLAN.md     G7 计划
document/testing/STAGE04-MANUAL-UAT-RESULT.md   执行结果(待 Wave 3 产出)
document/testing/STAGE04-PILOT-BLOCKERS.md      P0/P1 阻断清单(待产出)
document/testing/reports/runtime-blank-db.md    脚本自动追加的运行记录
```

## 6. 完成条件(runtime_gate_pass)

- [ ] G1 Blank DB PASS(exit 0,migration unique,latest applied,无 SQL compile error)
- [ ] G2 Existing Upgrade PASS(历史数据未丢,关键表 row count 合理,新列 default/backfill 正确,旧 API 仍能读)
- [ ] G3 RPC ACL PASS(public/anon/authenticated 全 false,service_role 全 true)
- [ ] G4 RLS Matrix PASS(全部 M1~M11)
- [ ] G5 新域关键 Case PASS
- [ ] G6 E2E PASS 或明确无 P0/P1 Blocked
- [ ] G7 人工 UAT 有真实结果

全部成立才能写 `runtime_gate_pass`;否则保持 `integration_pending`。
