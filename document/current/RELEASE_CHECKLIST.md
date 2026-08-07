# 发布检查清单（RELEASE_CHECKLIST）

> 依据 `document/stage-02/毛线球-最新开发指导文档-v0.5.md` 第二部分（第 15~19 节）与第五部分（第 23~25 节）完成定义整理。
> 每次发布前逐项核对；全部通过后才允许部署生产。

## 0. 文档一致性

- [ ] `document/current/IMPLEMENTATION_STATUS.md` 与当前代码对齐（含 S3.0 审计收口记录）
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
- [ ] 多角色测试账号（system_admin / store_manager / doctor / nurse）
- [ ] GitHub Actions secrets（禁止写入文档或 Git）

## 2. 数据库验证

- [ ] migration 空库从 0 升级到最新（含 P0-08 migration 25）
- [ ] migration 旧库升级（fix-forward 说明完整，不修改已应用历史 migration）
- [ ] RLS 全量通过（supabase/tests）
- [ ] RPC 直接调用安全（service role 仅授权路由可用，禁止客户端自由指定 tenant 直查）
- [ ] 并发 / 幂等 / 回滚通过（reserve/confirm、admit/transfer/discharge、goods-receipt 等）

## 3. 代码完成定义检查（v0.5 第 23 节）

- [ ] P0 代码任务全部完成（P0-01 ~ P0-10）
- [ ] S3.0 审计收口全部完成（AUD-001 ~ AUD-011，见 IMPLEMENTATION_STATUS「S3.0 审计收口」）
- [ ] `pnpm lint` / typecheck / build 通过（前端 vue-tsc、api tsc、e2e tsc、ESLint、vite build 全绿，S3.0 AUD-010 确认）
- [ ] 无已知跨租户授权缺陷（service role 路由均 scoped authorization，含报表 allowedStoreIds 数据范围）
- [ ] 无旧公共文件接口（旧 /api/upload、/api/files 已下线）
- [ ] 无正式页面手填 UUID（业务交互均走 Picker，含打印 lab_report/vaccine_certificate 选择器）
- [ ] 打印使用真实业务 DTO（非演示数据）
- [ ] 报表口径明确（Hono report-data，浏览器无跨表聚合）
- [ ] 生产消息策略明确（方案 A：消息退出 MVP，无 Mock sent）
- [ ] 核心闭环 E2E 缺 seed 时失败而非跳过（AUD-008）

## 4. 集成验证（v0.5 第 24 节）

- [ ] Preview 可访问（Vercel staging + 前端构建产物）
- [ ] Hono API 部署可达（staging API base 与前端同域或 CORS 配置正确）
- [ ] 闭环 A/B/C 在 staging 真实执行通过（`pnpm test:e2e`，须 staging 数据库，禁止对生产库执行写型 E2E）
- [ ] 页面与数据状态一致（各模块列表/详情与数据库一致）

## 5. 产品完成检查（v0.5 第 25 节）

- [ ] 闭环 A（就诊闭环：客户→预约→就诊→处方→发药→收费→签署）真正执行
- [ ] 闭环 B（库存闭环：入库→盘点→调拨→流水）真正执行
- [ ] 闭环 C（住院闭环：入院→护理→换房→计费→出院）真正执行
- [ ] 打印可用（真实数据输出）
- [ ] 客户/宠物/药品等核心数据可正常读写

## 6. 安全与合规

- [ ] secret 未写入代码库 / 文档
- [ ] service role key 仅服务端持有，未暴露给浏览器
- [ ] RLS 对 anon 关闭，authenticated 按租户/门店隔离
- [ ] 幂等键强制（关键写操作缺失返回 400，防绕过）

## 7. 发布后

- [ ] 更新 `document/current/IMPLEMENTATION_STATUS.md`（发布版本、commit）
- [ ] 记录生产 migration apply log 与 schema diff 存档
- [ ] 巡检 KNOWN_GAPS 中 P1 项是否已修复
