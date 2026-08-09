# Stage-04 E2E 报告与扩展计划(Agent-01)

> 维护者:Agent-01  
> 状态:⏳ 现有闭环保留;Stage-04 新域 spec 计划就绪,代码在 Wave 3(业务 Agent Wave 1 完成后)编写

## 1. 现有 E2E 资产(保留,不改语义)

| 文件 | 覆盖 |
|---|---|
| `e2e/tests/login.spec.ts` | 登录页渲染 + 真实 Supabase 登录 |
| `e2e/tests/smoke.spec.ts` | 主导航 + CRM/Catalog/Billing 页面可达 |
| `e2e/tests/core-flow.spec.ts` | 工作台 + 创建客户闭环 |
| `e2e/tests/closed-loop-a.spec.ts` | 医疗/收银闭环 |
| `e2e/tests/closed-loop-b-inventory.spec.ts` | 库存闭环 |
| `e2e/tests/closed-loop-c-inpatient.spec.ts` | 住院闭环 |

配置事实:`workers=1`、`fullyParallel=false`、hash 路由、本地 Vite 9000、`E2E_USERNAME/E2E_PASSWORD` 必填(默认失败而非跳过)。

## 2. 运行安全

- 环境重建必须走 `scripts/e2e-setup.sh`(已加 destructive 安全门,见 STAGE04-RUNTIME-GATE.md §2)。
- 禁止对 production 库执行写型 E2E。
- 如要并行,每 worker 必须独立账号 + 独立 fixture;否则维持 workers=1。

## 3. Stage-04 新域 E2E 扩展计划(Wave 3 编写)

| 新 spec 文件 | 覆盖场景 | 依赖 Agent(API 就绪) |
|---|---|---|
| `stage04-wallet.spec.ts` | 充值 → 扣款 → 余额断言;重复幂等键不重复扣;退款只返一次 | Agent-03 |
| `stage04-medication-safety.spec.ts` | Blocking 处方被阻止;Override 需权限+原因;Warning 可继续 | Agent-04 |
| `stage04-crm-marketing.spec.ts` | 优惠券 quota 不超发;套餐核销不重复;Segment 结果稳定 | Agent-05 |
| `stage04-insurance-documents.spec.ts` | 保险材料生成;PDF/Archive 可下载;跨租户不可见 | Agent-06 |
| `stage04-supply-chain.spec.ts` | 采购退货两次 post 不重复减库存;Opening Stock 重试幂等 | Agent-07 |
| `stage04-portal-messaging.spec.ts` | C 端未授权家庭成员不可见宠物;未发布报告不可见;Webhook 重放幂等 | Agent-08 |

编写硬规则(DEEP §13):

```text
禁止:为了测试绿直接改业务判断
禁止:测试里绕过 UI 完成 UAT
禁止:缺 fixture 就 skip(除非 E2E_OPTIONAL=true 显式声明)
禁止:API 500 当作业务失败 PASS
禁止:没有 DB assertion 只看 Toast
禁止:只验证 system_admin
```

每个新 spec 必须包含 DB 级断言(经 `e2e/helpers/api.ts` 的 `supabaseSelect` / Hono API 响应断言),
不得仅 UI 冒烟。

## 4. 执行记录(待回填)

| 批次 | 命令 | 结果 | 失败项 | 证据 |
|---|---|---|---|---|
| Wave 3 | `pnpm test:e2e` | ⏳ | | |

## 5. 结论

```text
现有闭环 E2E      : 保留(未改动)
Stage-04 新域 E2E : 计划就绪,代码待 Wave 3
```
