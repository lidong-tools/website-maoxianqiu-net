-- ============================================================
-- 20260809000048_discharge_settlement.sql
-- S3.1 并发任务 C 医疗闭环增强:出院结算闭环
--
-- 角色:开发员工 C(独占 migration 44~49)
--
-- 本文件内容:
--   1. admissions 扩展结算列:settlement_status / settlement_no /
--      deposit_amount / receivable_amount / paid_amount / waived_amount /
--      payment_method / prepared_* / settled_* / waived_* / finalized_*
--   2. 权限码:settlement.view / settlement.write / settlement.execute
--   3. 原子 RPC(全部 service-role-only,Hono 以 service role 调用):
--      prepare_settlement / settle_admission / waive_admission_charge / finalize_settlement
--   4. 审计:各 RPC 事务内写 audit_logs
--
-- 状态机:
--   unsettled → prepared → settled → finalized
--   unsettled → prepared → waived  → finalized(减免/挂账)
--   finalize 联动出院(admission.status=discharged + 释放笼位 + total_charge 同步)
--
-- 设计要点:
--   - 结算字段直接挂在 admissions 上,不新建结算表,费用明细仍从 inpatient_charges 聚合
--   - 正式收款入账走既有收银/发票流程,本 RPC 仅登记结算状态与金额,避免重复记账
--   - 幂等:prepare 幂等(同 admission 重复准备返回原结算单);settle/waive 重复调用按状态机拦截
--   - finalize 与既有 discharge_patient 并存:走结算闭环的出院经 finalize,直接出院仍可用 discharge_patient
--   - 权限码与角色分配统一在 migration 49 完成
-- 幂等,可重复应用
-- ============================================================

-- ============================================================
-- 1. admissions 结算扩展列
-- ============================================================
alter table public.admissions
  add column if not exists settlement_status text not null default 'unsettled',
  add column if not exists settlement_no text,             -- 结算单号(租户内唯一)
  add column if not exists deposit_amount numeric(12,2) not null default 0,   -- 预收押金
  add column if not exists receivable_amount numeric(12,2) not null default 0,-- 应收总额(费用汇总)
  add column if not exists paid_amount numeric(12,2) not null default 0,      -- 实收
  add column if not exists waived_amount numeric(12,2) not null default 0,    -- 减免
  add column if not exists payment_method text,            -- cash/card/wechat/alipay/stored_value/other
  add column if not exists prepared_at timestamptz,
  add column if not exists prepared_by uuid,
  add column if not exists settled_at timestamptz,
  add column if not exists settled_by uuid,
  add column if not exists waived_at timestamptz,
  add column if not exists waived_by uuid,
  add column if not exists waived_reason text,
  add column if not exists finalized_at timestamptz,
  add column if not exists finalized_by uuid;

-- 结算状态约束(幂等重建)
alter table public.admissions drop constraint if exists admissions_settlement_status_check;
alter table public.admissions add constraint admissions_settlement_status_check
  check (settlement_status in ('unsettled', 'prepared', 'settled', 'waived', 'finalized'));

-- 租户内结算单号唯一
create unique index if not exists idx_admissions_tenant_settlement_no
  on public.admissions (tenant_id, settlement_no)
  where settlement_no is not null;
create index if not exists idx_admissions_settlement_status
  on public.admissions (tenant_id, store_id, settlement_status);

-- ============================================================
-- 2. 权限码(settlement.view / write / execute)
-- ============================================================
insert into public.permissions (code, name, module) values
  ('settlement.view', '查看出院结算', 'inpatient'),
  ('settlement.write', '结算收款', 'inpatient'),
  ('settlement.execute', '减免/完成结算', 'inpatient')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- ============================================================
-- 3. prepare_settlement RPC(生成结算单,单事务 + 审计)
--    - 校验住院中且未结算;汇总 inpatient_charges 生成应收
--    - 幂等:已 prepared 的 admission 重复准备返回原结算信息
-- ============================================================
create or replace function public.prepare_settlement(
  p_admission_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admission public.admissions;
  v_settlement_no text;
  v_receivable numeric(12,2) := 0;
  v_charge_count integer := 0;
begin
  select * into v_admission from public.admissions where id = p_admission_id for update;
  if not found then
    raise exception 'ADMISSION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_admission.status <> 'admitted' then
    raise exception 'ADMISSION_NOT_ADMITTED' using errcode = 'P0003',
      message = '仅住院中的记录可生成结算单';
  end if;
  -- 幂等:已准备直接返回
  if v_admission.settlement_status = 'prepared' then
    return jsonb_build_object(
      'admissionId', p_admission_id,
      'settlementNo', v_admission.settlement_no,
      'receivableAmount', v_admission.receivable_amount,
      'depositAmount', v_admission.deposit_amount,
      'settlementStatus', 'prepared'
    );
  end if;
  if v_admission.settlement_status <> 'unsettled' then
    raise exception 'SETTLEMENT_ALREADY_STARTED' using errcode = 'P0003',
      message = '该住院记录已进入结算流程,不可重复生成结算单';
  end if;

  -- 汇总住院费用(笼位费 + 诊疗服务费)
  select coalesce(sum(amount), 0), count(*) into v_receivable, v_charge_count
  from public.inpatient_charges
  where admission_id = p_admission_id;

  -- 生成租户内唯一结算单号
  v_settlement_no := 'ST-' || to_char(now() at time zone 'Asia/Shanghai', 'YYYYMMDD') || '-' || upper(substr(md5(random()::text), 1, 6));

  update public.admissions
  set settlement_status = 'prepared',
      settlement_no = v_settlement_no,
      receivable_amount = v_receivable,
      prepared_at = now(),
      prepared_by = p_operator_id,
      updated_at = now()
  where id = p_admission_id;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_admission.tenant_id, v_admission.store_id, p_operator_id, 'settlement.prepare', 'admission', p_admission_id,
          jsonb_build_object('settlementNo', v_settlement_no, 'receivableAmount', v_receivable, 'chargeCount', v_charge_count));

  return jsonb_build_object(
    'admissionId', p_admission_id,
    'settlementNo', v_settlement_no,
    'receivableAmount', v_receivable,
    'depositAmount', v_admission.deposit_amount,
    'chargeCount', v_charge_count,
    'settlementStatus', 'prepared'
  );
end;
$$;

-- ============================================================
-- 4. settle_admission RPC(收款结算,单事务 + 审计)
--    - 校验 prepared;登记实收与支付方式(正式入账走收银/发票流程)
--    - 状态:prepared → settled
-- ============================================================
create or replace function public.settle_admission(
  p_admission_id uuid,
  p_paid_amount numeric,
  p_payment_method text default 'cash',
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admission public.admissions;
  v_payable numeric(12,2);
begin
  if p_payment_method not in ('cash', 'card', 'wechat', 'alipay', 'stored_value', 'other') then
    raise exception 'INVALID_PAYMENT_METHOD' using errcode = 'P0003';
  end if;
  if p_paid_amount is null or p_paid_amount < 0 then
    raise exception 'INVALID_PAID_AMOUNT' using errcode = 'P0003';
  end if;

  select * into v_admission from public.admissions where id = p_admission_id for update;
  if not found then
    raise exception 'ADMISSION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_admission.settlement_status <> 'prepared' then
    raise exception 'SETTLEMENT_NOT_PREPARED' using errcode = 'P0003',
      message = '请先生成结算单再收款';
  end if;

  -- 应付 = 应收 - 押金 - 减免(押金抵扣在前)
  v_payable := greatest(v_admission.receivable_amount - v_admission.deposit_amount - v_admission.waived_amount, 0);
  -- 实收不可超过应付(允许少收,差额视为欠费/后续减免)
  if p_paid_amount > v_payable then
    raise exception 'PAID_EXCEEDS_PAYABLE' using errcode = 'P0003',
      message = '实收金额超过应付金额 ' || v_payable;
  end if;

  update public.admissions
  set settlement_status = 'settled',
      paid_amount = p_paid_amount,
      payment_method = p_payment_method,
      settled_at = now(),
      settled_by = p_operator_id,
      updated_at = now()
  where id = p_admission_id;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_admission.tenant_id, v_admission.store_id, p_operator_id, 'settlement.settle', 'admission', p_admission_id,
          jsonb_build_object('settlementNo', v_admission.settlement_no, 'paidAmount', p_paid_amount,
                             'paymentMethod', p_payment_method, 'payable', v_payable));

  return jsonb_build_object(
    'admissionId', p_admission_id,
    'settlementNo', v_admission.settlement_no,
    'paidAmount', p_paid_amount,
    'paymentMethod', p_payment_method,
    'payable', v_payable,
    'settlementStatus', 'settled'
  );
end;
$$;

-- ============================================================
-- 5. waive_admission_charge RPC(减免/挂账,单事务 + 审计)
--    - 校验 prepared/settled;减免金额须在应收范围内
--    - 状态:prepared → waived(全额减免);settled → waived(补减免余款)
-- ============================================================
create or replace function public.waive_admission_charge(
  p_admission_id uuid,
  p_amount numeric,
  p_reason text default null,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admission public.admissions;
  v_max_waive numeric(12,2);
begin
  if p_amount is null or p_amount < 0 then
    raise exception 'INVALID_WAIVE_AMOUNT' using errcode = 'P0003';
  end if;

  select * into v_admission from public.admissions where id = p_admission_id for update;
  if not found then
    raise exception 'ADMISSION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_admission.settlement_status not in ('prepared', 'settled') then
    raise exception 'SETTLEMENT_NOT_WAIVABLE' using errcode = 'P0003',
      message = '仅已生成结算单的记录可减免';
  end if;

  -- 可减免上限 = 应收 - 押金 - 已实收 - 已减免
  v_max_waive := greatest(
    v_admission.receivable_amount - v_admission.deposit_amount - v_admission.paid_amount - v_admission.waived_amount,
    0
  );
  if p_amount > v_max_waive then
    raise exception 'WAIVE_EXCEEDS_PAYABLE' using errcode = 'P0003',
      message = '减免金额超过可减免上限 ' || v_max_waive;
  end if;

  update public.admissions
  set waived_amount = waived_amount + p_amount,
      waived_reason = coalesce(p_reason, waived_reason),
      waived_at = now(),
      waived_by = p_operator_id,
      settlement_status = 'waived',
      updated_at = now()
  where id = p_admission_id;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_admission.tenant_id, v_admission.store_id, p_operator_id, 'settlement.waive', 'admission', p_admission_id,
          jsonb_build_object('settlementNo', v_admission.settlement_no, 'waiveAmount', p_amount,
                             'reason', p_reason, 'totalWaived', v_admission.waived_amount + p_amount));

  return jsonb_build_object(
    'admissionId', p_admission_id,
    'settlementNo', v_admission.settlement_no,
    'waiveAmount', p_amount,
    'totalWaived', v_admission.waived_amount + p_amount,
    'settlementStatus', 'waived'
  );
end;
$$;

-- ============================================================
-- 6. finalize_settlement RPC(完成结算并出院,单事务 + 审计)
--    - 校验 settled/waived;联动出院:total_charge 同步 + 释放笼位
--    - 状态:settled/waived → finalized;admission.status → discharged
-- ============================================================
create or replace function public.finalize_settlement(
  p_admission_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admission public.admissions;
  v_cage public.cages;
  v_final_charge numeric(12,2);
begin
  select * into v_admission from public.admissions where id = p_admission_id for update;
  if not found then
    raise exception 'ADMISSION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_admission.settlement_status not in ('settled', 'waived') then
    raise exception 'SETTLEMENT_NOT_COMPLETED' using errcode = 'P0003',
      message = '仅已收款或已减免的结算可完成出院';
  end if;

  -- 结算后总费用 = 应收 - 减免(押金退回由收银流程处理)
  v_final_charge := greatest(v_admission.receivable_amount - v_admission.waived_amount, 0);

  -- 锁定笼位并释放
  select * into v_cage from public.cages where id = v_admission.cage_id for update;
  if v_cage is not null then
    update public.cages
    set status = 'available',
        current_admission_id = null,
        updated_at = now()
    where id = v_cage.id;
  end if;

  update public.admissions
  set settlement_status = 'finalized',
      finalized_at = now(),
      finalized_by = p_operator_id,
      status = 'discharged',
      discharged_at = now(),
      total_charge = v_final_charge,
      updated_at = now()
  where id = p_admission_id;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_admission.tenant_id, v_admission.store_id, p_operator_id, 'settlement.finalize', 'admission', p_admission_id,
          jsonb_build_object('settlementNo', v_admission.settlement_no, 'totalCharge', v_final_charge,
                             'receivable', v_admission.receivable_amount, 'waived', v_admission.waived_amount));

  return jsonb_build_object(
    'admissionId', p_admission_id,
    'settlementNo', v_admission.settlement_no,
    'status', 'discharged',
    'totalCharge', v_final_charge,
    'settlementStatus', 'finalized',
    'dischargedAt', now()
  );
end;
$$;

-- ============================================================
-- 7. 结束(权限收紧统一放 migration 49 的 revoke DO 块)
-- ============================================================
