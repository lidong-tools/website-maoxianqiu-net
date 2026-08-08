-- ============================================================
-- 20260810000115_s3_1_source_gate_fixes.sql
-- S3.1 审计 Source Gate 修复(S3.1-Final-Full-Code-Audit-Report v1)
--
-- 本 migration 是纯 Forward Migration,只 CREATE OR REPLACE / 重建 Policy,
-- 不修改任何已发布的历史 migration(修复 Migration Immutable 纪律)。
--
-- 内容:
--   1. P0-01:discharge_patient 出院释放笼位逻辑修正
--      历史 migration 21 中的函数被直接改过(if v_cage is not null →
--      直接按 v_admission.cage_id 释放),导致 Blank DB ≠ Existing DB Upgrade。
--      此处把修正后的函数作为 Forward Migration 正式向旧数据库升级,
--      migration 21 已恢复为原历史内容。
--   2. P0-02:signed progress note 不可变(RLS + Trigger 双层防护)
--      progress_notes_update / progress_notes_delete RLS 要求 status='draft';
--      另加 BEFORE UPDATE/DELETE Trigger,签署后禁止任何直连修改/删除,
--      受控 Amendment / Service Role 流程通过 set_config 显式放行。
-- 自包含幂等,重复应用安全。
-- ============================================================

set search_path = public;

-- ============================================================
-- 1. P0-01:discharge_patient Forward Fix
--    出院时按住院记录 cage_id 释放笼位,不依赖 v_cage 快照变量
--    (v_cage 是在 UPDATE admission 之前查询的快照,笼位释放应以
--     最新 admission.cage_id 为准,避免快照陈旧导致的释放错位)。
-- ============================================================
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
  -- 幂等检查
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where idempotency_key = p_idempotency_key
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

-- ============================================================
-- 2. P0-02:Signed Progress Note Immutability(RLS 层)
--    UPDATE / DELETE 均要求 status='draft',签署后浏览器直连不可改/删
-- ============================================================
drop policy if exists "progress_notes_update" on public.inpatient_progress_notes;
create policy "progress_notes_update" on public.inpatient_progress_notes
  for update to authenticated
  using (
    status = 'draft'
    and (
      public.is_system_admin()
      or (
        public.is_tenant_member(tenant_id)
        and (store_id is null or public.can_access_store(tenant_id, store_id))
        and public.has_permission(tenant_id, store_id, 'progress.write')
      )
    )
  )
  with check (
    status = 'draft'
    and (
      public.is_system_admin()
      or (
        public.is_tenant_member(tenant_id)
        and (store_id is null or public.can_access_store(tenant_id, store_id))
        and public.has_permission(tenant_id, store_id, 'progress.write')
      )
    )
  );

drop policy if exists "progress_notes_delete" on public.inpatient_progress_notes;
create policy "progress_notes_delete" on public.inpatient_progress_notes
  for delete to authenticated
  using (
    status = 'draft'
    and (
      public.is_system_admin()
      or (
        public.is_tenant_member(tenant_id)
        and (store_id is null or public.can_access_store(tenant_id, store_id))
        and public.has_permission(tenant_id, store_id, 'progress.write')
      )
    )
  );

-- ============================================================
-- 3. P0-02:Signed Progress Note Immutability(Trigger 层)
--    签署后禁止直连 UPDATE/DELETE;受控 Amendment / Service Role
--    特殊流程通过 set_config('app.allow_signed_note_update','true',true)
--    或 set_config('app.allow_signed_note_delete','true',true) 显式放行
--    (与 migration 28 归档不可变触发器同款模式)
-- ============================================================
create or replace function public.prevent_signed_progress_note_update()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'signed'
     and coalesce(current_setting('app.allow_signed_note_update', true), '') <> 'true' then
    raise exception 'SIGNED_PROGRESS_NOTE_IMMUTABLE'
      using errcode = 'P0003';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_progress_notes_signed_immutable on public.inpatient_progress_notes;
create trigger trg_progress_notes_signed_immutable
  before update on public.inpatient_progress_notes
  for each row execute function public.prevent_signed_progress_note_update();

create or replace function public.prevent_signed_progress_note_delete()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'signed'
     and coalesce(current_setting('app.allow_signed_note_delete', true), '') <> 'true' then
    raise exception 'SIGNED_PROGRESS_NOTE_IMMUTABLE'
      using errcode = 'P0003';
  end if;
  return old;
end;
$$;

drop trigger if exists trg_progress_notes_signed_delete_immutable on public.inpatient_progress_notes;
create trigger trg_progress_notes_signed_delete_immutable
  before delete on public.inpatient_progress_notes
  for each row execute function public.prevent_signed_progress_note_delete();

-- ============================================================
-- 4. 结束
--    自包含幂等:create or replace / drop policy + create policy,
--    重复应用安全,不触碰任何历史 migration 文件。
-- ============================================================
