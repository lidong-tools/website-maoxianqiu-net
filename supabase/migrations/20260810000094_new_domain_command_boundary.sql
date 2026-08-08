-- ============================================================
-- 20260810000094_new_domain_command_boundary.sql
-- Agent-07 二轮收口(P0-12/P0-20):新域 Direct-Write Lockdown
--
-- 背景:影像 / 回访 / 寄养 三组新表在 Feature Migration 中开放了
--   authenticated 直接 INSERT/UPDATE/DELETE,形成潜在绕过:
--     Browser → Supabase Table DML(绕过 Hono Command / 状态机 / 审计 / 幂等)
--   例如:
--     - imaging:直接 UPDATE status/report 绕过状态机与双签
--     - followup:直接 UPDATE status='completed' 绕过 followup.complete + 结果必填 + 审计
--     - boarding:直接改 cage_id/status/total_charge 绕过笼位锁 + Billing + 审计
--
-- 本迁移统一收紧:写(POST-INSERT)一律收回 authenticated,必须经 Hono service role
--   Command / RPC 执行;SELECT 保留 RLS(租户/门店可见)。service role 绕过 RLS,不受影响。
-- 与 P0-01(RPC ACL)/P0-02(Helper)配合,构成完整命令边界。
-- 幂等,可重复应用。
-- ============================================================

-- ===== 影像:imaging_orders / imaging_reports =====
drop policy if exists "imaging_orders_insert" on public.imaging_orders;
drop policy if exists "imaging_orders_update" on public.imaging_orders;

drop policy if exists "imaging_reports_insert" on public.imaging_reports;
drop policy if exists "imaging_reports_update" on public.imaging_reports;

-- ===== 回访:followup_tasks =====
drop policy if exists "followup_tasks_insert" on public.followup_tasks;
drop policy if exists "followup_tasks_update" on public.followup_tasks;
drop policy if exists "followup_tasks_delete" on public.followup_tasks;

-- ===== 寄养:boarding_stays / daily_records / service_charges =====
drop policy if exists "boarding_stays_insert" on public.boarding_stays;
drop policy if exists "boarding_stays_update" on public.boarding_stays;
drop policy if exists "boarding_stays_delete" on public.boarding_stays;

drop policy if exists "boarding_daily_records_insert" on public.boarding_daily_records;
drop policy if exists "boarding_daily_records_update" on public.boarding_daily_records;
drop policy if exists "boarding_daily_records_delete" on public.boarding_daily_records;

drop policy if exists "boarding_service_charges_insert" on public.boarding_service_charges;
drop policy if exists "boarding_service_charges_delete" on public.boarding_service_charges;
