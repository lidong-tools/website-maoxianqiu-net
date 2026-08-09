# 已知缺口（KNOWN_GAPS）

> 本文件记录当前已知的技术债、未验证项与后续待办，随交付持续更新（Stage-04 Agent-09 Final Integrator 重写为当前事实）。
> 缺口分级：P0（阻断发布）、P1（发布后尽快修复）、P2（优化）。

## Stage-04 未验证项（runtime_pending，须 staging 环境验证）

| 项目 | 说明 | 关联 |
| --- | --- | --- |
| Stage-04 migration 200~285 升级演练 | 空库从 0 到 285 及旧库升级（含 285 appointments_source_check 幂等重建、Agent-03~08 RPC revoke/grant）未在真实 DB 执行 | Stage-04 全部 Agent |
| Stage-04 RLS / RPC 矩阵 | `supabase/tests/stage04_rls_matrix.sql`（Agent-01）未在 staging 执行；新表 RLS（stored_value / medication rules / coupons / packages / campaigns / insurance packs / portal identities）未实测 | Agent-01/03/04/05/06/08 |
| 钱包 ↔ 计费原子性 | stored_value 扣减与 process_payment/process_refund 同事务（migration 203）未实测：失败回滚、幂等重试、发票金额一致性 | Agent-03 |
| 用药安全服务端 hook | issue_prescription / dispense_prescription 阻塞 hook + override 审批链（reason + audit）未在真实 DB 验证 | Agent-04 |
| 采购退货库存写 | purchase_return → inventory_movements（幂等 + 批次 + warehouse scope）未实测；导入消费者（employee/opening-stock）领域 apply 未运行验证 | Agent-07 |
| 门户预约与 OTP | create_portal_appointment 幂等 + source='customer_portal'（migration 285 修复后）；OTP 速率限制 / 验证码生命周期未实测 | Agent-08 / Agent-09 |
| Messaging Webhook | 验签 → 解析 → apply_provider_event 幂等 → CAS 状态推进链路未以真实 Provider 回调验证 | Agent-08 |
| 前端新模块 UI | 营销增长 / 客户门户 / 钱包 / 用药安全 / 保险 / 采购请求与退货 / 导入消费者 页面联调未执行（人工测试） | Stage-04 前端 |
| check:rpc-manifest 当前口径 | manifest 现有 **170 个** service-role-only 函数（含 Stage-04 新增 39 个）；本批次未重跑脚本（用户约束：不执行语法检查/编译），需 Agent-01 或 CI 在 staging 阶段执行确认 PASS | Agent-09 / Agent-01 |

## P1 — 发布后尽快修复

### P1-04 打印能力项未补齐
依据 v0.5 第 1088-1094 行，以下打印项仍为待办：
- Puppeteer/Chromium 生成 PDF；
- PDF 存档到 R2；
- 电子签名；
- 打印模板版本号；
- 打印模板编辑器。

### P1-05 example 源码隔离
- example 路由未注册，方向正确；但演示代码仍与应用同仓。
- 建议：将演示代码移动到独立 app，或 production build 排除，避免业务 Agent 搜索时误用演示页面。

### P1-06 Pilot 前待决项（Full12 审计确认，均非阻断）
- **Messaging stale「结果未知」语义**：`sending` 超时后由扫描器置 `failed/retry`（依据 `sending_claimed_at ?? updated_at` 判定），但「超过阈值仍无法判定结果」时是否应进入人工确认队列，需产品决策（当前未实现人工确认 UI）。
- **Import Consumer 未实现**：employee/opening-stock 的 `awaiting_domain_apply` 终态对应 Consumer（IAM 邀请 / 库存期初）尚未完成，入口已隐藏（`IMPORT_TYPES_ENABLED`）；若 Pilot 需要该能力，须先完成 Consumer 再放开入口。
- **Analytics 时区（DST）**：revenue/inventory 报表按 `created_at` 日期分组（Asia/Shanghai 基准），DST 切换期与会计月度边界未做显式处理，Pilot 前可选优化。

### P1-07 Secret 凭据轮换风险提示（Full12 审计 §3/§4）
- 历史上曾入库的测试账号密码 / PGPASSWORD / DB URL 若曾用于共享环境，即使已从仓库清除（grep 0 匹配），仍建议在 staging 上线前轮换相关凭据（Supabase 项目密码、测试账号密码、服务账号），避免历史泄露面。参见 RELEASE_CHECKLIST。

## P2 — 优化项

- **E2E 本地降级**：Playwright Chromium 官方源在本机网络不可达，需使用 npmmirror 镜像安装（见 `e2e/README.md`）。
- **e2e 无独立 package.json**：e2e 直接复用根目录 `@playwright/test`，运行须从仓库根目录或 `pnpm --dir e2e exec`（README 已说明）。

## 历史未验证项（S3.x，仍须 staging）

| 项目 | 说明 | 关联 |
| --- | --- | --- |
| migration 空库/旧库升级（≤27） | 仅本地开发库验证，未做空库从 0 到 27 及旧库升级演练（含 migration 26 scope 归一/触发器/存量修复、migration 27 platform_user_roles + RPC 全量 revoke） | S30-R01/R02/F01/F02 |
| RLS / RPC 全量验证（≤27） | supabase/tests 未在 staging 执行（含 rls_inventory_reserve.sql、rls_scoped_permission.sql、rpc_security.sql Part1~3、9 个 RLS 夹具） | DEV-000 / S30-R01~R03 / S30-F03 |
| 并发 / 幂等 / 回滚 | reserve/confirm、admit/transfer/discharge 等并发场景未实测 | P0-08 / inpatient |
| 闭环 A/B/C 真实执行 | 代码与 tsc 通过，未在真实环境跑通 | P0-09 / S30-R05 |
| 多角色授权矩阵 | 仅 platform_admin 实测，store_manager / doctor / nurse 未逐角色验证 | P0-01/P0-02 / S30-R01 |
| R2 文件签名下载 | 新文件模型仅在开发环境验证 | P0-03 |
| 报表口径核对 | report-data 聚合结果与账目核对未做 | P0-06 |
| 监管 RPC 与门店权限自校验（migration 31~34） | 未进入任何共享环境 | S31-MERGE-FINAL |
| S3.1 新闭环 E2E | E2E 仅有闭环 A/B/C，无 Loop D/E/F | S31-INTEGRATION-D |
| S3.1 并行新模块迁移（54~73 + 90/91） | 未在真实 DB 演练 | S3.1-PARALLEL |
| 寄养离店 → 发票运行时 | `boarding_checkout` 内嵌 `create_invoice` 同事务未实测 | S3.1-PARALLEL |
| 自动回访生成 | 病历随访日期 / 出院 → autoCreateFollowup 未运行时验证 | S3.1-PARALLEL |
| DB 类型生成 | `db:gen-types` 依赖在线 Supabase，未在本地执行 | S3.1 P1 |
| Messaging 新链路 | migration 121（updated_at/sending_claimed_at + touch trigger）未在真实 DB 演练 | S3.2-FINAL |

## 已关闭缺口（摘要）

| 缺口 | 状态 | 关闭说明 |
| --- | --- | --- |
| 浏览器跨表聚合报表 | ✅ 已关闭 | P0-06 统一到 Hono report-data |
| 库存 confirm 不扣批次 / 无过期释放 | ✅ 已关闭 | P0-08 migration 25 |
| 处方发药只转状态不扣库存 | ✅ 已关闭 | P0-08 clinical.ts |
| 发票/处方取消不释放预留 | ✅ 已关闭 | P0-08 billing.ts |
| scoped permission 作用域串用 | ✅ 已关闭 | S3.0 AUD-002 |
| report-data 报表数据越权 | ✅ 已关闭 | S3.0 AUD-003：allowedStoreIds 查询层过滤 |
| 过期预留确认缺陷 | ✅ 已关闭 | S3.0 AUD-007：RESERVATION_EXPIRED + 排除当前 id |
| 正式表单手填 UUID / 误导性标签 | ✅ 已关闭 | S3.0 AUD-005/006：业务 Picker 全覆盖 |
| store role → tenant 权限提升 | ✅ 已关闭 | S30-R01：has_permission() scope 感知 |
| 非法 role assignment | ✅ 已关闭 | S30-R02：validate_era_scope() 触发器 |
| 浏览器直连高危 Command RPC | ✅ 已关闭 | S30-F02：migration 27 全量 revoke + manifest + CI |
| 平台管理员可从租户角色推导 | ✅ 已关闭 | S30-F01：platform_user_roles 独立授权表 |
| 病历签署可选任意员工 | ✅ 已关闭 | S30-R04：签署强制当前登录 user.id |
| 核心 E2E 缺 seed 静默 skip | ✅ 已关闭 | S3.0 AUD-008：缺 seed = FAIL |
| Secret Hygiene（tmp 文件含明文凭据） | ✅ 已关闭 | Full12 §3/§4：删除 9 个被跟踪 tmp 文件 + 全环境变量化 |
| message_deliveries 缺 updated_at / sending_claimed_at | ✅ 已关闭 | Full12 §5：migration 121 |
| Initial Send 未 CAS claim | ✅ 已关闭 | Full12 §6：claimInitialSend() |
| recordAttempt 晚到覆盖 | ✅ 已关闭 | Full12 §8：attempts/status 条件更新，0 行静默丢弃 |
| Refund many-to-one 被当数组 | ✅ 已关闭 | Full12 §11 |
| Catalog 收入对账缺口 | ✅ 已关闭 | Full12 §12（方案 A：按分类权重分摊） |
| Doctor 未归因边界 | ✅ 已关闭 | Full12 §13 |
| Import 暴露未完成 Consumer 入口 | ✅ 已关闭 | Full12 §7：IMPORT_TYPES_ENABLED 隐藏 |
| src 目录 .js 产物导致 build MISSING_EXPORT | ✅ 已关闭 | S31-INTEGRATION-D / Full12 门禁：清理编译产物 |
