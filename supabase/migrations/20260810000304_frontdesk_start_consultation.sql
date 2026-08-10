-- ============================================================
-- 20260810000304_frontdesk_start_consultation.sql
-- 候诊队列「开始就诊」快捷路径(P0 缺陷修复)
--
-- 背景:
--   候诊队列页的「开始就诊」此前只把预约推进到 in_progress,既不创建就诊、
--   也不同步 clinical_queue_entries,导致跳转医生工作台后看不到任何就诊信息。
--   修复方案是让前台把候诊队列直接流转到 in_consultation(服务端在该流转中
--   自动创建就诊并同步预约状态),需要:
--     1) 扩展 transition_clinical_queue 状态机:允许 checked_in/triage/waiting
--        → in_consultation(未叫号/未分诊也可由前台直接开始诊疗);
--     2) 给前台岗位(receptionist)补 queue.call 权限(流转到 in_consultation
--        的权限码为 queue.call,旧模型 roles.permissions 与新模型
--        role_permissions 两侧均补齐,collectRolePermissions 取并集)。
--
-- 全部幂等,可重复应用。
-- ============================================================

-- ===== 1) 扩展队列状态机:前台「开始就诊」可直接进入诊疗中 =====
create or replace function public.transition_clinical_queue(
  p_queue_entry_id uuid,
  p_target_status text,
  p_reason text,
  p_room_name text,
  p_actor_employee_id uuid,
  p_actor_role text,
  p_source_workbench text,
  p_request_id text,
  p_idempotency_key text
)
returns public.clinical_queue_entries
language plpgsql security definer set search_path = public
as $$
declare
  v_queue public.clinical_queue_entries;
  v_before public.clinical_queue_entries;
  v_encounter_id uuid;
  v_allowed boolean := false;
begin
  select * into v_queue from public.clinical_queue_entries where id = p_queue_entry_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'QUEUE_ENTRY_NOT_FOUND'; end if;
  v_before := v_queue;

  v_allowed := case
    when v_queue.status = 'waiting' and p_target_status = 'called' then true
    when v_queue.status = 'called' and p_target_status in ('called', 'missed', 'in_consultation') then true
    when v_queue.status = 'missed' and p_target_status in ('waiting', 'called', 'cancelled') then true
    when v_queue.status = 'in_consultation' and p_target_status in ('closed', 'cancelled') then true
    -- 前台「开始就诊」快捷路径:未叫号(含未分诊)可直接进入诊疗中,由服务端自动创建就诊
    when v_queue.status in ('checked_in', 'triage', 'waiting') and p_target_status = 'in_consultation' then true
    when v_queue.status in ('checked_in', 'triage', 'waiting') and p_target_status = 'cancelled' then true
    else false end;
  if not v_allowed then raise exception using errcode = '23514', message = 'INVALID_QUEUE_TRANSITION'; end if;

  if p_target_status = 'in_consultation' and v_queue.encounter_id is null then
    insert into public.encounters (
      tenant_id, store_id, appointment_id, customer_id, pet_id, doctor_id,
      status, clinical_status, archive_status, started_at
    ) values (
      v_queue.tenant_id, v_queue.store_id, v_queue.appointment_id, v_queue.customer_id,
      v_queue.pet_id, v_queue.assigned_doctor_id, 'in_progress', 'active', 'draft', now()
    ) returning id into v_encounter_id;
  else
    v_encounter_id := v_queue.encounter_id;
  end if;

  update public.clinical_queue_entries set
    status = p_target_status,
    encounter_id = coalesce(encounter_id, v_encounter_id),
    room_name = coalesce(p_room_name, room_name),
    call_sequence = call_sequence + case when p_target_status = 'called' then 1 else 0 end,
    call_count = call_count + case when p_target_status = 'called' then 1 else 0 end,
    called_at = case when p_target_status = 'called' then now() else called_at end,
    waiting_at = case when p_target_status = 'waiting' then now() else waiting_at end,
    consultation_started_at = case when p_target_status = 'in_consultation' then now() else consultation_started_at end,
    closed_at = case when p_target_status in ('closed', 'cancelled') then now() else closed_at end,
    last_operator_employee_id = p_actor_employee_id,
    version = version + 1,
    updated_at = now()
  where id = p_queue_entry_id returning * into v_queue;

  update public.appointments set
    status = case
      when p_target_status = 'in_consultation' then 'in_progress'
      when p_target_status = 'closed' then 'completed'
      when p_target_status = 'cancelled' then 'cancelled'
      else status end,
    updated_at = now()
  where id = v_queue.appointment_id;

  perform public.append_patient_journey_event(
    v_queue.tenant_id, v_queue.store_id, p_actor_employee_id, p_actor_role,
    'queue.' || p_target_status, 'clinical_queue', v_queue.id::text, v_queue.customer_id,
    v_queue.pet_id, v_queue.appointment_id, v_queue.id, v_queue.encounter_id,
    v_before.status, v_queue.status, p_reason, null, to_jsonb(v_before), to_jsonb(v_queue),
    p_source_workbench, p_request_id, p_request_id, p_idempotency_key
  );
  return v_queue;
end;
$$;

-- ===== 2) 前台岗位补 queue.call(旧模型 + 新模型双侧幂等补齐) =====
update public.roles set permissions = array(select distinct unnest(permissions || array[
  'queue.call'
])) where code = 'receptionist';

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join lateral unnest(array['queue.call']) as u(perm_code)
join public.permissions p on p.code = u.perm_code
where r.code = 'receptionist'
on conflict (role_id, permission_id) do nothing;
