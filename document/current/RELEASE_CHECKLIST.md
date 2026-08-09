# 发布检查清单（RELEASE_CHECKLIST）

> 依据 `document/stage-02/毛线球-最新开发指导文档-v0.5.md` 第二部分（第 15~19 节）与第五部分（第 23~25 节）完成定义整理。
> Stage-04 Agent-09 Final Integrator 重写为当前事实；每次发布前逐项核对；全部通过后才允许部署生产。

## 0. 文档一致性

- [ ] `document/current/IMPLEMENTATION_STATUS.md` 与当前代码对齐（含 Stage-04 Agent-01~09 交付记录）
- [ ] `document/current/KNOWN_GAPS.md` 缺口已确认无阻断项
- [ ] 本次发布对应的 commit 已记录（health commit 对齐）

## 1. Staging 前置条件（运维提供）

- [ ] Supabase staging project ref
- [ ] STAGING_DATABASE_URL
- [ ] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
- [ ] SUPABASE_SERVICE_ROLE_KEY
- [ ] 独立 R2 staging bucket + R2 staging credentials
- [ ] Vercel staging project
- [ ] E2E 管理员账号（具备全业务权限码）
- [ ] 多角色测试账号（platform_admin / store_manager / doctor / nurse）
- [ ] 消息 Provider 凭据（Email/SMS，若启用 Portal OTP / Messaging）
- [ ] GitHub Actions secrets（禁止写入文档或 Git）

## 2. 数据库验证

- [ ] migration 空库从 0 升级到最新（含 Stage-04 号段 200~285；285 为 Agent-09 修复 `appointments_source_check` 增加 `customer_portal`）
- [ ] migration 旧库升级（fix-forward 说明完整，不修改已应用历史 migration；验证 Stage-04 新 RPC 的 revoke public/anon/authenticated + grant service_role 逐段幂等）
- [ ] Stage-04 RLS 矩阵真实执行（`supabase/tests/stage04_rls_matrix.sql`，覆盖 stored_value / medication / crm-growth / marketing / insurance / documents / portal / purchase 新表）
- [ ] RLS 历史全量通过（supabase/tests，含 rls_scoped_permission.sql S1~S11、rls_inventory_reserve.sql、rpc_security.sql Part1~3、regulatory/compliance/permission_integration/tenant_initialization/daily_closing/reconciliation/medical_loop）
- [ ] RPC 直接调用安全（service role 仅授权路由可用；`pnpm check:rpc-manifest` 当前口径 **170 个** manifest 函数、missing 0；authenticated 直调 Command RPC 必须 permission denied）
- [ ] 平台管理员独立模型验证（tenant/store employee role 绝不产生 platform admin；`is_system_admin()` 只读 platform_user_roles）
- [ ] 并发 / 幂等 / 回滚通过（reserve/confirm、admit/transfer/discharge、goods-receipt、stored_value 充值/支付原子、门户预约幂等）

## 3. 代码完成定义检查（v0.5 第 23 节）

- [ ] P0 代码任务全部完成（P0-01 ~ P0-10）
- [ ] S3.0 审计收口（AUD-001~011）、定向复审（S30-R01~R07）、复审（S30-F01~F04）全部完成
- [ ] S31-MERGE-FINAL（FINAL-01~04）、S31-A/B/C/D、S3.1-PARALLEL、S3.2-FINAL（Full12）全部完成
- [ ] Stage-04 全部 Agent 交付（Agent-01 runtime/UAT 基础、Agent-02 release guard、Agent-03 钱包、Agent-04 用药安全、Agent-05 CRM/营销、Agent-06 保险/文档、Agent-07 采购/导入、Agent-08 门户/消息、Agent-09 集成）已合入 main
- [ ] `pnpm check:rpc-manifest` PASS（Agent-01 staging 阶段重跑确认；当前静态口径 170 个函数）
- [ ] `pnpm lint` / typecheck / build 通过（前端 vue-tsc、api tsc、e2e tsc、ESLint、vite build 全绿；Stage-04 新模块静态确认，真实门禁由 Agent-01 在 staging 阶段执行）
- [ ] 无已知跨租户授权缺陷（service role 路由均 scoped authorization；Stage-04 新路由全部 `requireScopedPermission`）
- [ ] 无旧公共文件接口（旧 /api/upload、/api/files 已下线）
- [ ] 无正式页面手填 UUID（业务交互均走 Picker）
- [ ] 病历签署人强制为当前登录用户（无 EmployeePicker 可选任意员工）
- [ ] 高危 Command RPC 仅 service_role 可执行（manifest + migration revoke 一致）
- [ ] 平台管理员独立模型（tenant/store employee role 绝不能产生 platform admin）
- [ ] 打印使用真实业务 DTO（非演示数据）；报表口径明确（Hono report-data）
- [ ] 消息策略明确（方案 A：消息退出 MVP）；Portal OTP 未配置 Provider 时拒绝发送
- [ ] 核心闭环 E2E 缺 seed 时失败而非跳过（AUD-008）；闭环 A 使用 UI 建宠物 + UI 签署（S30-R05）
- [ ] Webhook 收件路由验签强制（messaging-webhook：未验签事件一律拒绝）

## 4. 集成验证（v0.5 第 24 节）

- [ ] Preview 可访问（Vercel staging + 前端构建产物）
- [ ] Hono API 部署可达（staging API base 与前端同域或 CORS 配置正确）
- [ ] Stage-04 新路由冒烟（/wallet、/medication-safety、/crm-growth、/marketing、/insurance、/document-artifacts、/purchase-requests、/purchase-returns、/import-consumers、/portal、/messaging/webhook）
- [ ] 闭环 A/B/C 在 staging 真实执行通过（`pnpm test:e2e`，禁止对生产库执行写型 E2E）
- [ ] 页面与数据状态一致（各模块列表/详情与数据库一致，含 Stage-04 新模块）

## 5. 产品完成检查（v0.5 第 25 节）

- [ ] 闭环 A（客户→预约→就诊→处方→发药→收费→签署）真正执行
- [ ] 闭环 B（入库→盘点→调拨→流水）真正执行
- [ ] 闭环 C（入院→护理→换房→计费→出院）真正执行
- [ ] 钱包充值/支付/退款链路真实执行（含 stored_value ↔ billing 原子回滚）
- [ ] 用药安全规则命中与 override 流程真实执行
- [ ] 营销：分层/流失预警/优惠券/套餐/活动/转介绍 真实执行
- [ ] 保险理赔包 + 文档 PDF/归档/签名 真实执行
- [ ] 采购请求/退货/导入（customer/pet/catalog-item）真实执行
- [ ] 客户门户（OTP 登录、宠物、预约、报告、会员权益、通知订阅）真实执行
- [ ] 打印可用（真实数据输出）；客户/宠物/药品等核心数据可正常读写

## 6. 安全与合规

- [ ] secret 未写入代码库 / 文档
- [ ] service role key 仅服务端持有，未暴露给浏览器
- [ ] RLS 对 anon 关闭，authenticated 按租户/门店隔离
- [ ] 幂等键强制（关键写操作缺失返回 400，防绕过；含门户预约 `Idempotency-Key`）
- [ ] Portal C 端会话与员工 IAM 完全分离（无客户端自证 customerId / employee role）

## 7. 发布后

- [ ] 更新 `document/current/IMPLEMENTATION_STATUS.md`（发布版本、commit）
- [ ] 记录生产 migration apply log 与 schema diff 存档
- [ ] 巡检 KNOWN_GAPS 中 P1 项是否已修复
