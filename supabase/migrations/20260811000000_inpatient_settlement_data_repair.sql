-- ============================================================
-- 20260811000000_inpatient_settlement_data_repair.sql
-- 住院闭环修复:历史"直接出院但未结算"脏数据结案
--
-- 背景:
--   旧版入院登记页提供「出院」直出按钮,直接调 discharge_patient RPC
--   (仅置 status=discharged,不更新 settlement_status),导致产生
--   status='discharged' AND settlement_status='unsettled' 的死数据,
--   该类记录无法再走 prepare_settlement 结算流程(其要求 status='admitted')。
--
-- 处理:
--   将历史脏数据 settlement_status 置为 finalized(视同历史直出已结案),
--   保留 status=discharged 与费用汇总,避免死数据常驻结算待办。
--   若不存在脏数据,本脚本为幂等空操作,可安全重复应用。
--
-- 审计:修复动作写入 audit_logs,便于追溯。
-- ============================================================

-- 1. 扫描并修复历史"直出未结算"脏数据(幂等:已 finalized 的不再处理)
update public.admissions a
set settlement_status = 'finalized',
    finalized_at = coalesce(a.finalized_at, a.discharged_at, a.updated_at),
    updated_at = now()
where a.status = 'discharged'
  and a.settlement_status = 'unsettled';

-- 2. 审计说明:记录本次修复的行数(以 notification 形式写入 audit_logs)
insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
select a.tenant_id,
       a.store_id,
       null,
       'inpatient.settlement.dataRepair',
       'admission',
       a.id,
       jsonb_build_object(
         'repair', 'discharged_without_settlement',
         'note', '历史直出未结算记录结案置为 finalized'
       )
from public.admissions a
where a.status = 'discharged'
  and a.settlement_status = 'finalized'
  and a.finalized_at = coalesce(a.discharged_at, a.updated_at);
