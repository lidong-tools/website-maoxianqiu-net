# STAGE04-SOURCE-GATE-REPORT（Agent-09 Final Integrator）

> 依据：`document/stage-04/Stage-04-8-Agent/Agent-09-Final-Integrator-DEEP.md` §19（Failure Criteria）。
> 结论：**FINAL SOURCE GATE = PASS（静态）** —— 用户约束本批次不执行语法检查/编译/构建（tsc/vue-tsc/vite build），故真实门禁（typecheck/build/ESM）由 Agent-01 在 staging 阶段执行，本报告为静态 Source Gate。

## 0. 基线

```text
分支: main
基线 SHA: a728de0b（Stage-04 开始前）
Stage-04 提交:
  f3254ff9 → 06a0266f  test/stage04-01  runtime foundation
  1bb3a079        chore/stage04-02  release guard
  8634ca13        feat/stage04-08  portal + messaging webhook（含 Agent-03/04/06 文件）
  <本次提交>       chore(stage04-09)  finalize（含 Agent-05/07 文件）
```

## 1. Failure criteria 逐项核查（DEEP §19）

| # | 判据 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | duplicate migration | ✅ 无 | 200-285 段编号唯一（200/201/202/203、210/211、220-223、235、250/251/252、265/266/267、285） |
| 2 | historical migration changed | ✅ 无 | git diff 历史 migration（<200）= 0；仅新增 200-285 |
| 3 | API typecheck fail | ⏳ 未执行（用户约束） | 静态确认：新路由全部 `Hono<AppEnv>` + 相对导入 `.js` 后缀 + 无 `require()`；真实门禁交 Agent-01 |
| 4 | frontend typecheck fail | ⏳ 未执行（用户约束） | 静态确认：API module 路径与后端一致；真实门禁交 Agent-01 |
| 5 | build fail | ⏳ 未执行（用户约束） | 真实门禁交 Agent-01 |
| 6 | ESM smoke fail | ⏳ 未执行（用户约束） | 新增 `check:api-esm` 脚本（Agent-02）交 Agent-01 执行 |
| 7 | secret found | ✅ 无 | 扫描 api/routes、api/lib、apps/maoxianqiu 新文件：无 service role key / password / token 硬编码（仅 env 引用）；`Support@`/`supabase.co`/`postgres@` 0 匹配 |
| 8 | critical RPC authenticated executable | ✅ 无 | 170 个 manifest 函数全部在 migration revoke（public/anon/authenticated）+ grant service_role；`check:rpc-manifest` 静态规则（routes ⊆ manifest ⊆ revoke 清单） |
| 9 | wallet non-atomic | ✅ 无 | migration 203：stored_value 扣减与 `process_payment`/`process_refund` 同事务（SELECT...FOR UPDATE + 同过程体），退款对称 |
| 10 | inventory direct balance update | ✅ 无 | 采购退货/期初库存均写 `inventory_movements`（RPC 服务端），无客户端直接 update balance |
| 11 | portal auth bypass | ✅ 无 | C 端独立 portal session（HMAC + OTP hash），身份一律从会话推导，不接收客户端 customerId 自证；`/portal/admin/*` 走员工 IAM + `portal.*` 权限 |
| 12 | medication server hook missing | ✅ 无 | `issue_prescription`/`dispense_prescription` 服务端阻塞 hook（migration 211），override 需权限 + reason + audit |
| 13 | webhook no signature | ✅ 无 | `messaging-webhook.ts`：先验签（失败 401）再解析；未配置渠道拒绝 503 |

## 2. 同 main 污染检查（DEEP §2）

| 检查项 | 结果 |
| --- | --- |
| 未提交文件 | 仅 Agent-05（untracked）+ Agent-07（staged）+ Agent-09（modified/untracked）文件，均属 Stage-04 交付 |
| 其它 Agent 文件被误 add | 无（Agent-07 文件由其本人 staged，Agent-05 文件保持 untracked 由本提交归组） |
| tmp/debug | 无 |
| secret | 无（见 §1 #7） |
| 历史 migration 修改 | 0 个（git log filter 确认） |

## 3. Migration 号段质量（DEEP §3）

- 200-284 各 Agent 段无重复、顺序合法、FK 依赖成环风险无（各自段内建表/引用，跨段仅消费既有表）。
- 函数重定义：Agent-03 migration 203 重定义 `process_payment`/`process_refund`（billing 既有 RPC）—— 签名与 billing.ts 调用一致（p_invoice_id/p_amount/p_method/p_operator_id/p_idempotency_key/p_transaction_no），跨 Agent 已核对。
- permission seed：各段自带 INSERT permissions + 角色数组扩展（`permissions || array[...]`），与 seed.sql 无冲突。
- RPC ACL：全部新 RPC revoke + grant service_role（Agent-09 逐段核对函数签名一致）。
- Agent-09 自身修复仅 285（Forward Fix，未触碰任何历史 migration）。

## 4. 共享入口注册（DEEP §4/§5）

- `api/index.ts`：新路由全部挂载，动态路由先于父路由（`/messaging/webhook` 先于 `/messaging`；`/inventory/purchase-requests` 先于 `/inventory` 具体路由），沿用 `/operations/report-data` 先于 `/operations` 的经验。
- `apps/maoxianqiu/src/router/routes.ts`：新菜单/路由注册，`meta.auth` 与后端权限码一致；C 端 portal 不复用员工权限路由。

## 5. 权限一致性（DEEP §6）

- 无 code duplicate / 语义重叠（无 wallet.manage + wallet.admin + stored_value.manage 三套同义码）。
- 全部新权限码在 migration 内 seed；前端 permissions.ts 无冲突。

## 6. RPC Manifest（DEEP §7）

- 当前 `service-rpc-manifest.ts` 共 **170 个** service-role-only 函数（含 Stage-04 新增 39 个：Agent-03=5、04=6、05=17、06=7、08=4）。
- 静态规则成立：`api/routes` 中 `service.rpc()` 调用 ⊆ manifest；manifest ⊆ migrations revoke 清单。
- `pnpm check:rpc-manifest` 本批次未重跑（用户约束），Agent-01 在 staging 阶段执行确认。

## 7. 跨域集成核查（DEEP §8~§15）

| # | 契约 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | Wallet ↔ Billing 原子 | ✅ | migration 203 同事务（见 §1 #9） |
| 2 | Medication ↔ Clinical 服务端 hook | ✅ | migration 211（见 §1 #12） |
| 3 | CRM/Marketing：Segment=Audience 真源 | ✅ | crm-growth 提供 segment/churn，marketing 仅消费，无第二套 Audience Engine |
| 4 | Marketing ↔ Messaging 无 Provider SDK | ✅ | marketing.ts 无直接 Provider 调用，经 Agent-08 Dispatch Contract |
| 5 | Insurance ↔ Documents 复用 Adapter | ✅ | insurance 复用 document_archives + PDF/signature Provider，无独立 `insurance_pdf_templates` |
| 6 | Purchase ↔ Inventory 写 movements | ✅ | 退货/期初库存写 `inventory_movements`（幂等 + 批次 + warehouse scope） |
| 7 | Employee Import ↔ IAM | ✅ | employee.ts 经 `invite_employee` RPC（非直接 auth.admin.createUser），失败 `deleteUser` 补偿 |
| 8 | Portal ↔ Business 独立会话 | ✅ | C 端 portal session 与员工 IAM 完全分离（见 §1 #11） |

## 8. Package / Dependencies（DEEP §16）

- 仅 Agent-09 修改根 `package.json`（新增 `check:api-esm`/`release:preflight`/`release:smoke` 脚本）；pnpm-lock.yaml 无变更（未加新依赖）。
- Agent-06 未引入 Chromium；Agent-08 未引入额外 Provider SDK 依赖（复用既有 provider 架构）。

## 9. 静态安全扫描（DEEP §18）

- service role key / password / token 硬编码：0 匹配（仅 env 引用）。
- tmp script：无新增。
- console logging 敏感 payload：新路由无明文 OTP/密码/签名日志（portal 审计写 masked recipient；webhook 审计不写 payload）。
- direct authenticated write：前端无 `supabase.rpc()` 直连新 RPC。
- 新 memberships[0] / client balance update：无（余额/会员调整全部 RPC 服务端）。
- 数据库侧：OTP 只存 hash；`verification_challenges` 状态机；`customer_identities` 无明文凭据。

## 10. 结论

```text
FINAL SOURCE GATE = PASS（静态）
runtime_gate_pass 待 Agent-01 staging 执行后更新（真实门禁 + RLS/RPC ACL + E2E + UAT）
```
