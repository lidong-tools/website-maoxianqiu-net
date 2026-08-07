# 已知缺口（KNOWN_GAPS）

> 本文件记录当前已知的技术债、未验证项与后续待办，随交付持续更新。缺口按严重程度分级：P0（阻断发布）、P1（发布后尽快修复）、P2（优化）。

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

## P2 — 优化项

- **E2E 本地降级**：Playwright Chromium 官方源在本机网络不可达，需使用 npmmirror 镜像安装（见 `e2e/README.md`）。
- **e2e 无独立 package.json**：e2e 直接复用根目录 `@playwright/test`，运行须从仓库根目录或 `pnpm --dir e2e exec`（README 已说明）。

## 未验证项（须 staging 环境验证）

| 项目 | 说明 | 关联 |
| --- | --- | --- |
| migration 空库/旧库升级 | 仅本地开发库验证，未做空库从 0 到 27 及旧库升级演练（含 migration 26 scope 归一/触发器/存量修复、migration 27 platform_user_roles + RPC 全量 revoke） | S30-R01/R02/F01/F02 |
| RLS / RPC 全量验证 | supabase/tests 未在 staging 执行（含新增 rls_inventory_reserve.sql、rls_scoped_permission.sql、rpc_security.sql Part1~3、9 个 RLS 夹具 platform_user_roles 改造） | DEV-000 / S30-R01~R03 / S30-F03 |
| 并发 / 幂等 / 回滚 | reserve/confirm、admit/transfer/discharge 等并发场景未实测 | P0-08 / inpatient |
| 闭环 A/B/C 真实执行 | 代码与 tsc 通过，未在真实环境跑通（closed-loop-a 已改 UI 建宠物 + UI 签署） | P0-09 / S30-R05 |
| 多角色授权矩阵 | 仅 platform_admin 实测，store_manager / doctor / nurse 未逐角色验证；scoped permission（store→tenant 禁止）未在 staging 执行 | P0-01/P0-02 / S30-R01 |
| R2 文件签名下载 | 新文件模型仅在开发环境验证 | P0-03 |
| 报表口径核对 | report-data 聚合结果与账目核对未做 | P0-06 |
| 监管 RPC 与门店权限自校验（migration 31~34） | migration 31~34 未进入任何共享环境：save_institution_license / save_epidemic_event / save_waste_record 函数签名（DEFAULT 后无无默认参数）、generate_regulatory_report 兽医数（门店+时间有效性边界）、can_access_store store↔tenant 自校验，待 staging 空库/旧库升级 + SQL tests 验证 | S31-MERGE-FINAL |

## 已关闭缺口

| 缺口 | 状态 | 关闭说明 |
| --- | --- | --- |
| 浏览器跨表聚合报表 | ✅ 已关闭 | P0-06 统一到 Hono report-data |
| 库存 confirm 不扣批次 / 无过期释放 | ✅ 已关闭 | P0-08 migration 25 |
| 处方发药只转状态不扣库存 | ✅ 已关闭 | P0-08 clinical.ts |
| 发票/处方取消不释放预留 | ✅ 已关闭 | P0-08 billing.ts |
| 根 package.json 缺 test:e2e 脚本 | ✅ 已关闭 | P0-10 |
| AGENTS.md 技术栈过时 | ✅ 已关闭 | P0-10 重写为毛线球规则 |
| 前端 vue-tsc 遗留类型错误 | ✅ 已关闭 | S3.0 AUD-010：`vue-tsc -b` 全绿 |
| scoped permission 作用域串用 | ✅ 已关闭 | S3.0 AUD-002：区分 tenant-wide / store-scoped 分配，`allowedStoreIds` 收敛 |
| report-data 报表数据越权 | ✅ 已关闭 | S3.0 AUD-003：5 类报表按门店集合查询层强制过滤 |
| 过期预留确认缺陷（自身过期不拒 + stale loop 自释放） | ✅ 已关闭 | S3.0 AUD-007：RESERVATION_EXPIRED + 排除当前 id，附回归测试 |
| 正式表单手填 UUID / 误导性「XX ID」标签 | ✅ 已关闭 | S3.0 AUD-005：业务 Picker 全覆盖 |
| 打印实体 ID 手填（lab_report/vaccine_certificate） | ✅ 已关闭 | S3.0 AUD-006：DiagnosticOrderPicker 收口 |
| 核心 E2E 缺 seed 静默 skip | ✅ 已关闭 | S3.0 AUD-008：缺 seed = FAIL |
| 闭环 A 先发药后收费（测试擅自决定） | ✅ 已关闭 | S3.0 AUD-009：按默认建议 prescription → invoice → payment → dispense |
| store role → tenant 权限提升 | ✅ 已关闭 | S30-R01：has_permission() v3 scope 感知 + rls_scoped_permission.sql S3 负向测试 |
| 非法 role assignment（scope=store+store_id NULL 等） | ✅ 已关闭 | S30-R02：validate_era_scope() 触发器（STORE_ROLE_REQUIRES_STORE / TENANT_ROLE_FORBIDS_STORE / ROLE_TENANT_MISMATCH）+ 存量修复 |
| 浏览器直连高危 Command RPC | ✅ 已关闭 | S30-R03 首轮 revoke 约 35 个；S30-F02 补齐全部 11 个遗漏 + 审计 3 个，migration 27 对 55 个函数名（service-role-only manifest 全量）revoke public/anon/authenticated + grant service_role；前端改走 Hono；`check:rpc-manifest` CI 静态规则保证 routes 中 `service.rpc()` 调用（59 处，unique 52 个）⊆ service-role-only manifest（55 个，含内部辅助 RPC 3 个），全校验 PASS |
| 平台管理员可从租户角色推导（tenant/store employee role 产生 platform admin） | ✅ 已关闭 | S30-F01：新增 `platform_user_roles` 独立授权表；`is_system_admin()` 只读平台授权来源；ERA 禁止 scope='system'（SYSTEM_ROLE_FORBIDDEN_ERA）；tenant invite/change-role 拒绝 system role；租户角色管理 UI 过滤 scope='system'；legacy store_members 不自动升级 |
| tenant admin 可升级为 platform admin（权限提升） | ✅ 已关闭 | S30-F01 + rpc_security.sql Part 3：P1 负向（authenticated 写 platform_user_roles 被 RLS 拒绝，自己/他人都拒）；P2 system role 禁止 ERA；P3/P5 无平台授权 is_system_admin()=false |
| 病历签署可选任意员工（EmployeePicker） | ✅ 已关闭 | S30-R04：签署强制当前登录 user.id；EmployeePicker value-key 区分 employees.id / auth.users.id；字段语义 COMMENT 固化 |
| E2E 宠物用 API 绕过 UI | ✅ 已关闭 | S30-R05：closed-loop-a 步骤 2 改 UI「新增宠物」建档 |
| inventory receipt 预留手填商品、nursing/print 手填实体 | ✅ 已关闭 | S30-R06：BusinessCatalogItemPicker + value-key="user_id" + print 非可选取类型禁用 |
