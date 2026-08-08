-- ============================================================
-- 20260810000120_discharge_patient_replay_after_lock.sql
-- S3.1 继续审计 v4 §7:discharge_patient 并发同幂等键 replay 收口
-- ------------------------------------------------------------
-- 背景:117 中幂等检查在 SELECT admission FOR UPDATE 之前完成(快路径)。
-- 若两个完全并发请求使用同一 idempotency_key:
--   A/B 初始都查不到 record
--   A 先锁 admission,B 等待
--   A 完成 discharge + 写 idempotency record + commit
--   B 获得锁,发现 status=discharged → 抛 ADMISSION_NOT_ADMITTED
-- 数据不会重复出院,但第二个请求未获得"第一次的幂等 replay 结果",
-- 严格幂等响应语义不完整。
--
-- 修复:在拿到 admission 行锁之后,按 v_admission.tenant_id + key
-- 再查一次幂等记录,若已有直接 replay;快路径保留(无并发时零额外成本)。
--
-- 本 migration 是 Forward Migration,只 CREATE OR REPLACE 函数,
-- 不修改任何历史 migration;自包含幂等,重复应用安全。
-- ============================================================

set search_path = public;

create or replace function public.discharge_patient(
  p_admission_id uuid,
  p_discharge_reason text default null,
  p_discharge_notes text default null,
  p_operator_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admission public.admissions;
  v_cage public.cages;
  v_existing jsonb;
  v_total_charge numeric(12,2) := 0;
begin
  -- 幂等检查(快路径):进入锁之前先查一次,已存在直接 replay
  -- (tenant scope:显式限定 admission 归属租户,避免不同租户同 Key 串读)
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where idempotency_key = p_idempotency_key
      and tenant_id = (select tenant_id from public.admissions where id = p_admission_id)
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  -- 锁定住院记录
  select * into v_admission from public.admissions
  where id = p_admission_id
  for update;
  if not found then
    raise exception 'ADMISSION_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 并发同键重查(审计 v4 §7):拿到行锁后再查一次。
  -- 另一并发请求可能在快路径之后、本请求获得锁之前完成出院并写入幂等记录;
  -- 此时直接 replay,避免第二个请求落入 ADMISSION_NOT_ADMITTED。
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where idempotency_key = p_idempotency_key
      and tenant_id = v_admission.tenant_id
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  if v_admission.status <> 'admitted' then
    raise exception 'ADMISSION_NOT_ADMITTED' using errcode = 'P0003';
  end if;

  -- 汇总费用
  select coalesce(sum(amount), 0) into v_total_charge
  from public.inpatient_charges
  where admission_id = p_admission_id;

  -- 锁定笼位(与住院记录一致)
  select * into v_cage from public.cages
  where id = v_admission.cage_id
  for update;

  -- 更新住院记录为已出院
  update public.admissions
  set status = 'discharged',
      discharged_at = now(),
      discharge_reason = p_discharge_reason,
      discharge_notes = p_discharge_notes,
      total_charge = v_total_charge,
      updated_at = now()
  where id = p_admission_id
  returning * into v_admission;

  -- 释放笼位(直接按住院记录最新 cage_id 释放,不依赖 v_cage 快照变量)
  update public.cages
  set status = 'available',
      current_admission_id = null,
      updated_at = now()
  where id = v_admission.cage_id;

  -- 记录幂等结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (v_admission.tenant_id, p_idempotency_key, 'discharge_patient', 'admission', p_admission_id, jsonb_build_object(
      'admissionId', p_admission_id,
      'status', 'discharged',
      'totalCharge', v_total_charge,
      'dischargedAt', v_admission.discharged_at
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'admissionId', p_admission_id,
    'status', 'discharged',
    'totalCharge', v_total_charge,
    'dischargedAt', v_admission.discharged_at
  );
end;
$$;

-- 与 migration 92 的最终 ACL 保持一致(service-role-only)
revoke all on function public.discharge_patient(uuid, text, text, uuid, text) from public;
revoke all on function public.discharge_patient(uuid, text, text, uuid, text) from anon;
revoke all on function public.discharge_patient(uuid, text, text, uuid, text) from authenticated;
grant execute on function public.discharge_patient(uuid, text, text, uuid, text) to service_role;
