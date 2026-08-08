> 项目：毛线球宠物医院 SaaS
> 阶段：Stage-03 / S3.2 并发功能开发 → Mainline Integration
> 文档：S32-E → Mainline Integrator 交接
> 生成：2026-08-08（agent-E）

# S32 → Mainline Integration Handoff

## 1. 现状

- S3.2 四个模块（Import V2 / Analytics / Documents V2 / Messaging）已由 S32-E 完成集成（路由 + 菜单 + 权限 manifest + 安全核查）。
- **S3.1 已合并**（`27590d84` 最终收口）；S3.1 与 S3.2 已在同一条 main 历史上。
- 合并后整树验证：**API typecheck + 前端 typecheck + `vite build` 全部通过**（S32-E 2026-08-08 复核）。
- 状态：`code_complete` + `integration_complete` + `runtime_verification_pending`（缺 Runtime/E2E 冒烟）。

## 2. 合并顺序（已基本完成）

```text
先 S3.1 Integrated ✓（27590d84）
再 S3.2 Integrated ✓（f94b67e6 等）
→ Mainline Integration（进行中：剩跨域 Hook 接入 + Runtime 冒烟）
```

**理由**：S3.1 修的是系统地基（IAM/Permission/Context/Billing/Clinical/Inventory 安全边界），S3.2 依赖这些地基。先合 S3.1 可确保权限/上下文语义稳定后再叠加 S3.2。

## 3. 冲突处理原则

1. 若 S3.1 与 S3.2 冲突：**优先保留 S3.1 安全/权限/事务逻辑**，S3.2 适配。
2. 禁止：为了保留新功能 → 回退 S3.1 Security Fix。
3. S3.2 未修改任何 S3.1 禁改文件，理论上冲突面很小；S3.2 独占文件与 S3.1 文件无交集（已核对）。

## 4. S32-E 本批改动文件清单

```text
api/index.ts                                        # 注册 /imports /analytics /documents /messaging
apps/maoxianqiu/src/router/routes.ts                # 挂载「经营分析」一级菜单组
apps/maoxianqiu/src/router/modules/analytics.ts     # 新建：5 个报表页路由
apps/maoxianqiu/src/router/modules/operations.ts    # +/operations/documents；message→messaging 替换
apps/maoxianqiu/src/views/system/permissions.ts     # 补 imports(4)/documents(3)/analytics(3) 权限码
document/s32-final/S32-INTEGRATION-REPORT.md
document/s32-final/S32-REMAINING-GAPS.md
document/s32-final/S32-MAINLINE-HANDOFF.md
```

## 5. Mainline Integrator 待办

### 5.1 接入跨域 Hook（S3.1 已合并，但未提供下游能力 → 需补齐）
- [ ] **Opening Stock**：⚠️ **阻塞**——Inventory 侧无 `apply_opening_stock` RPC（S3.1 未提供）。需先补 RPC，再消费 `opening_stock_import_requests(pending)` → 建批次/更新余额 → `applied/skipped/failed`。
- [ ] **Employee Invite**：能力已存在（`POST /employees/invite` + `invite_employee` RPC），缺消费者——消费 `employee_invite_imports(pending)` → 按 role_code/store_codes 调邀请 → `sent/duplicate/failed`。归属需确认（IAM 域 vs S32-E 集成胶水）。
- [ ] **Messaging 业务 Trigger**：appointment_reminder / vaccine_reminder / revisit_reminder / lab_report → 调 `POST /api/messaging/send`。需在 S3.1 临床/诊断域接线（未做）。

### 5.2 Messaging 增强（可选）
- [ ] Webhook `POST /api/messaging/provider/:provider/webhook`（签名校验 + 防重放 + 幂等）→ `delivered` 回执。
- [ ] 权限细粒度拆分 `messaging.view/send/template.manage/retry`（migration seed + 路由 code + 前端 manifest 三处同步）。
- [ ] 旧 `POST /operations/deliveries/:id/send` 链路切换/下线决策。

### 5.3 Documents 补 DTO
- [ ] Logo/医院信息（Settings Hook）、影像图片附件、处方合规字段、`discharge_summaries` 独立表（如需要）。
- [ ] 旧打印中心（`print_templates`）与新文档中心收敛决策。

### 5.4 部署配置
- [ ] `MESSAGING_PROVIDER=email` + `MESSAGING_API_KEY` + `MESSAGING_SENDER`；前端 `VITE_MESSAGE_PROVIDER=real`。

### 5.5 最终安全复核（Mainline 合并后）
- [ ] RPC ACL（无新增 RPC，已确认；合并后复查）
- [ ] RLS（4 组新表/扩展）
- [ ] Tenant/Store Context 收敛
- [ ] Import 写边界（不直改库存余额/不建用户）
- [ ] Document 医疗权限门
- [ ] Messaging Secret 不暴露
- [ ] Analytics Scope（view.store/view.tenant）

### 5.6 状态文档更新（仅 Mainline Integrator）
- [ ] `IMPLEMENTATION_STATUS.md`
- [ ] `KNOWN_GAPS.md`
- [ ] Build（`vite build`）补跑 + Runtime/E2E 冒烟（见 REMAINING-GAPS §6）

## 6. 提醒

- S3.1 在途改动含历史 migration `inpatient.sql` 修改，Mainline 需确认其回放策略（见 S32-REMAINING-GAPS §5）。
- S3.2 当前无 Runtime/E2E，**不得标记 production_ready**。
