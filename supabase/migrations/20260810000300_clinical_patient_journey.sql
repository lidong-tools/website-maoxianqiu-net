-- ============================================================
-- 多岗位协同门诊患者旅程
-- 统一候诊、分诊、岗位任务、计费来源与不可变操作留痕。
-- 所有写操作只允许 service role 通过下方 RPC 完成。
-- ============================================================

alter table public.encounters
  add column if not exists clinical_status text not null default 'active';

update public.encounters
set clinical_status = case status
  when 'in_progress' then 'active'
  when 'completed' then 'closed'
  when 'signed' then 'closed'
  else 'active'
end
where clinical_status = 'active';

alter table public.encounters drop constraint if exists encounters_clinical_status_check;
alter table public.encounters add constraint encounters_clinical_status_check
  check (clinical_status in ('active', 'plan_ready', 'closed', 'cancelled', 'transferred'));

create table if not exists public.clinical_queue_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete restrict,
  appointment_id uuid not null,
  encounter_id uuid,
  customer_id uuid not null,
  pet_id uuid not null,
  assigned_doctor_id uuid references auth.users(id) on delete set null,
  queue_date date not null default current_date,
  queue_no text not null,
  room_name text,
  service_type text not null default 'outpatient',
  triage_required boolean not null default true,
  priority text not null default 'routine',
  status text not null default 'checked_in',
  call_sequence integer not null default 0,
  call_count integer not null default 0,
  checked_in_at timestamptz not null default now(),
  triaged_at timestamptz,
  waiting_at timestamptz,
  called_at timestamptz,
  consultation_started_at timestamptz,
  closed_at timestamptz,
  last_operator_employee_id uuid references public.employees(id) on delete set null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, store_id, appointment_id),
  unique (tenant_id, store_id, queue_date, queue_no),
  check (priority in ('routine', 'priority', 'urgent', 'emergency')),
  check (status in ('checked_in', 'triage', 'waiting', 'called', 'missed', 'in_consultation', 'closed', 'cancelled'))
);

create index if not exists idx_clinical_queue_store_day
  on public.clinical_queue_entries (tenant_id, store_id, queue_date, status, priority, checked_in_at);
create index if not exists idx_clinical_queue_encounter
  on public.clinical_queue_entries (encounter_id) where encounter_id is not null;

create table if not exists public.triage_assessments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete restrict,
  queue_entry_id uuid not null references public.clinical_queue_entries(id) on delete restrict,
  encounter_id uuid,
  weight_kg numeric(8,3),
  temperature_c numeric(5,2),
  heart_rate integer,
  respiratory_rate integer,
  pain_score integer,
  acuity text not null default 'routine',
  allergy_notes text,
  risk_flags text[] not null default '{}',
  chief_complaint text,
  notes text,
  assessed_by_employee_id uuid not null references public.employees(id) on delete restrict,
  assessed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (queue_entry_id),
  check (pain_score is null or pain_score between 0 and 10),
  check (acuity in ('routine', 'priority', 'urgent', 'emergency'))
);

create table if not exists public.patient_journey_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete restrict,
  customer_id uuid,
  pet_id uuid,
  appointment_id uuid,
  queue_entry_id uuid references public.clinical_queue_entries(id) on delete restrict,
  encounter_id uuid,
  entity_type text not null,
  entity_id text,
  event_type text not null,
  from_status text,
  to_status text,
  reason text,
  note text,
  before_data jsonb not null default '{}'::jsonb,
  after_data jsonb not null default '{}'::jsonb,
  actor_type text not null default 'employee',
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_employee_id uuid references public.employees(id) on delete restrict,
  actor_employee_no text,
  actor_name text not null,
  actor_role text not null,
  delegated_by_employee_id uuid references public.employees(id) on delete restrict,
  approval_source text,
  source_workbench text,
  request_id text,
  correlation_id text,
  idempotency_key text,
  client_context jsonb not null default '{}'::jsonb,
  previous_event_id uuid references public.patient_journey_events(id) on delete restrict,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (actor_type in ('employee', 'system'))
);

create index if not exists idx_journey_events_encounter_time
  on public.patient_journey_events (encounter_id, occurred_at desc);
create index if not exists idx_journey_events_patient_time
  on public.patient_journey_events (tenant_id, pet_id, occurred_at desc);
create index if not exists idx_journey_events_actor_time
  on public.patient_journey_events (tenant_id, actor_employee_id, occurred_at desc);
create unique index if not exists uq_journey_events_idempotency
  on public.patient_journey_events (tenant_id, event_type, idempotency_key)
  where idempotency_key is not null;

create table if not exists public.workflow_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete restrict,
  encounter_id uuid,
  customer_id uuid,
  pet_id uuid,
  task_type text not null,
  owner_role text not null,
  source_type text not null,
  source_id text not null,
  title text not null,
  description text,
  priority text not null default 'routine',
  status text not null default 'pending',
  assignee_employee_id uuid references public.employees(id) on delete set null,
  due_at timestamptz,
  claimed_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  outcome_note text,
  failure_reason text,
  created_by_employee_id uuid references public.employees(id) on delete set null,
  last_operator_employee_id uuid references public.employees(id) on delete set null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, source_type, source_id, task_type, owner_role),
  check (priority in ('routine', 'priority', 'urgent', 'emergency')),
  check (status in ('pending', 'claimed', 'in_progress', 'completed', 'failed', 'cancelled'))
);

create index if not exists idx_workflow_tasks_role_queue
  on public.workflow_tasks (tenant_id, store_id, owner_role, status, priority, due_at);
create index if not exists idx_workflow_tasks_encounter
  on public.workflow_tasks (encounter_id, status);

create table if not exists public.encounter_charge_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete restrict,
  encounter_id uuid not null,
  customer_id uuid,
  pet_id uuid,
  source_type text not null,
  source_id text not null,
  source_line_id text not null default '',
  catalog_item_id uuid,
  item_name text not null,
  quantity numeric(14,3) not null default 1,
  unit_price numeric(14,2) not null default 0,
  amount numeric(14,2) generated always as (round(quantity * unit_price, 2)) stored,
  status text not null default 'pending',
  invoice_id uuid,
  payment_required_before_execution boolean not null default true,
  created_by_employee_id uuid references public.employees(id) on delete set null,
  voided_by_employee_id uuid references public.employees(id) on delete set null,
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, source_type, source_id, source_line_id),
  check (quantity > 0),
  check (status in ('pending', 'invoiced', 'paid', 'voided', 'refunded'))
);

create index if not exists idx_encounter_charge_items_encounter
  on public.encounter_charge_items (encounter_id, status);

create table if not exists public.workbench_preferences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  store_id uuid references public.stores(id) on delete cascade,
  active_role text not null,
  updated_at timestamptz not null default now(),
  unique (tenant_id, employee_id, store_id)
);

-- 检验价目绑定用于医生开检查后，在同一事务生成待付款条目。
alter table public.lab_orders
  add column if not exists catalog_item_id uuid references public.catalog_items(id) on delete set null,
  add column if not exists idempotency_key text;
alter table public.imaging_orders add column if not exists idempotency_key text;
create unique index if not exists uq_lab_orders_idempotency on public.lab_orders(tenant_id, idempotency_key) where idempotency_key is not null;
create unique index if not exists uq_imaging_orders_idempotency on public.imaging_orders(tenant_id, idempotency_key) where idempotency_key is not null;

alter table public.audit_logs
  add column if not exists employee_id uuid references public.employees(id) on delete set null,
  add column if not exists actor_role text,
  add column if not exists actor_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists before_data jsonb not null default '{}'::jsonb,
  add column if not exists after_data jsonb not null default '{}'::jsonb,
  add column if not exists journey_event_id uuid references public.patient_journey_events(id) on delete set null;

-- 旅程事件不可修改或删除，包括 service role。
create or replace function public.prevent_journey_event_mutation()
returns trigger language plpgsql as $$
begin
  raise exception using errcode = '23514', message = 'JOURNEY_EVENT_IMMUTABLE';
end;
$$;

drop trigger if exists trg_patient_journey_events_immutable on public.patient_journey_events;
create trigger trg_patient_journey_events_immutable
before update or delete on public.patient_journey_events
for each row execute function public.prevent_journey_event_mutation();

-- 解析并冻结操作人员身份；调用者必须传入实际员工与当次岗位。
create or replace function public.append_patient_journey_event(
  p_tenant_id uuid,
  p_store_id uuid,
  p_actor_employee_id uuid,
  p_actor_role text,
  p_event_type text,
  p_entity_type text,
  p_entity_id text default null,
  p_customer_id uuid default null,
  p_pet_id uuid default null,
  p_appointment_id uuid default null,
  p_queue_entry_id uuid default null,
  p_encounter_id uuid default null,
  p_from_status text default null,
  p_to_status text default null,
  p_reason text default null,
  p_note text default null,
  p_before_data jsonb default '{}'::jsonb,
  p_after_data jsonb default '{}'::jsonb,
  p_source_workbench text default null,
  p_request_id text default null,
  p_correlation_id text default null,
  p_idempotency_key text default null,
  p_client_context jsonb default '{}'::jsonb,
  p_delegated_by_employee_id uuid default null,
  p_approval_source text default null
)
returns public.patient_journey_events
language plpgsql security definer set search_path = public
as $$
declare
  v_employee public.employees;
  v_previous uuid;
  v_event public.patient_journey_events;
  v_existing public.patient_journey_events;
begin
  if p_idempotency_key is not null then
    select * into v_existing
    from public.patient_journey_events
    where tenant_id = p_tenant_id and event_type = p_event_type and idempotency_key = p_idempotency_key;
    if found then return v_existing; end if;
  end if;

  select * into v_employee from public.employees
  where id = p_actor_employee_id and tenant_id = p_tenant_id and status = 'active';
  if not found then raise exception using errcode = '42501', message = 'ACTIVE_EMPLOYEE_REQUIRED'; end if;

  if not exists (
    select 1 from public.employee_role_assignments era
    join public.roles r on r.id = era.role_id
    where era.employee_id = p_actor_employee_id
      and era.tenant_id = p_tenant_id
      and (p_store_id is null or era.store_id is null or era.store_id = p_store_id)
      and r.code = p_actor_role
  ) then
    raise exception using errcode = '42501', message = 'ACTIVE_ROLE_CONTEXT_REQUIRED';
  end if;

  select id into v_previous from public.patient_journey_events
  where tenant_id = p_tenant_id and encounter_id is not distinct from p_encounter_id
    and pet_id is not distinct from p_pet_id
  order by occurred_at desc, created_at desc limit 1;

  insert into public.patient_journey_events (
    tenant_id, store_id, customer_id, pet_id, appointment_id, queue_entry_id, encounter_id,
    entity_type, entity_id, event_type, from_status, to_status, reason, note,
    before_data, after_data, actor_user_id, actor_employee_id, actor_employee_no,
    actor_name, actor_role, delegated_by_employee_id, approval_source, source_workbench,
    request_id, correlation_id, idempotency_key, client_context, previous_event_id
  ) values (
    p_tenant_id, p_store_id, p_customer_id, p_pet_id, p_appointment_id, p_queue_entry_id, p_encounter_id,
    p_entity_type, p_entity_id, p_event_type, p_from_status, p_to_status, p_reason, p_note,
    coalesce(p_before_data, '{}'::jsonb), coalesce(p_after_data, '{}'::jsonb), v_employee.user_id,
    v_employee.id, v_employee.employee_no, v_employee.name, p_actor_role, p_delegated_by_employee_id,
    p_approval_source, p_source_workbench, p_request_id, p_correlation_id, p_idempotency_key,
    coalesce(p_client_context, '{}'::jsonb), v_previous
  ) returning * into v_event;
  return v_event;
end;
$$;

create or replace function public.check_in_clinical_patient(
  p_appointment_id uuid,
  p_triage_required boolean,
  p_service_type text,
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
  v_appointment public.appointments;
  v_queue public.clinical_queue_entries;
  v_next integer;
begin
  select * into v_appointment from public.appointments where id = p_appointment_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'APPOINTMENT_NOT_FOUND'; end if;
  if v_appointment.status not in ('confirmed', 'checked_in') then
    raise exception using errcode = '23514', message = 'APPOINTMENT_NOT_READY_FOR_CHECK_IN';
  end if;

  select * into v_queue from public.clinical_queue_entries
  where tenant_id = v_appointment.tenant_id and store_id = v_appointment.store_id
    and appointment_id = v_appointment.id;
  if found then return v_queue; end if;

  perform pg_advisory_xact_lock(hashtext(v_appointment.store_id::text || current_date::text));
  select coalesce(max(substring(queue_no from '[0-9]+')::integer), 0) + 1 into v_next
  from public.clinical_queue_entries
  where store_id = v_appointment.store_id and queue_date = current_date;

  insert into public.clinical_queue_entries (
    tenant_id, store_id, appointment_id, customer_id, pet_id, assigned_doctor_id,
    queue_no, service_type, triage_required, status, last_operator_employee_id
  ) values (
    v_appointment.tenant_id, v_appointment.store_id, v_appointment.id,
    v_appointment.customer_id, v_appointment.pet_id, v_appointment.doctor_id,
    'A' || lpad(v_next::text, 3, '0'), coalesce(p_service_type, 'outpatient'),
    p_triage_required, case when p_triage_required then 'triage' else 'waiting' end,
    p_actor_employee_id
  ) returning * into v_queue;

  update public.appointments set status = 'checked_in', updated_at = now()
  where id = v_appointment.id and status = 'confirmed';

  perform public.append_patient_journey_event(
    v_queue.tenant_id, v_queue.store_id, p_actor_employee_id, p_actor_role,
    'queue.checked_in', 'clinical_queue', v_queue.id::text, v_queue.customer_id,
    v_queue.pet_id, v_queue.appointment_id, v_queue.id, null,
    v_appointment.status, v_queue.status, null, null, to_jsonb(v_appointment), to_jsonb(v_queue),
    p_source_workbench, p_request_id, p_request_id, p_idempotency_key
  );
  return v_queue;
end;
$$;

create or replace function public.record_clinical_triage(
  p_queue_entry_id uuid,
  p_payload jsonb,
  p_actor_employee_id uuid,
  p_actor_role text,
  p_source_workbench text,
  p_request_id text,
  p_idempotency_key text
)
returns public.triage_assessments
language plpgsql security definer set search_path = public
as $$
declare
  v_queue public.clinical_queue_entries;
  v_triage public.triage_assessments;
  v_acuity text := coalesce(p_payload->>'acuity', 'routine');
begin
  select * into v_queue from public.clinical_queue_entries where id = p_queue_entry_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'QUEUE_ENTRY_NOT_FOUND'; end if;
  if v_queue.status not in ('checked_in', 'triage', 'waiting') then
    raise exception using errcode = '23514', message = 'QUEUE_NOT_TRIAGEABLE';
  end if;

  insert into public.triage_assessments (
    tenant_id, store_id, queue_entry_id, encounter_id, weight_kg, temperature_c,
    heart_rate, respiratory_rate, pain_score, acuity, allergy_notes, risk_flags,
    chief_complaint, notes, assessed_by_employee_id
  ) values (
    v_queue.tenant_id, v_queue.store_id, v_queue.id, v_queue.encounter_id,
    nullif(p_payload->>'weightKg', '')::numeric, nullif(p_payload->>'temperatureC', '')::numeric,
    nullif(p_payload->>'heartRate', '')::integer, nullif(p_payload->>'respiratoryRate', '')::integer,
    nullif(p_payload->>'painScore', '')::integer, v_acuity, p_payload->>'allergyNotes',
    coalesce(array(select jsonb_array_elements_text(coalesce(p_payload->'riskFlags', '[]'::jsonb))), '{}'),
    p_payload->>'chiefComplaint', p_payload->>'notes', p_actor_employee_id
  )
  on conflict (queue_entry_id) do update set
    weight_kg = excluded.weight_kg, temperature_c = excluded.temperature_c,
    heart_rate = excluded.heart_rate, respiratory_rate = excluded.respiratory_rate,
    pain_score = excluded.pain_score, acuity = excluded.acuity,
    allergy_notes = excluded.allergy_notes, risk_flags = excluded.risk_flags,
    chief_complaint = excluded.chief_complaint, notes = excluded.notes,
    assessed_by_employee_id = excluded.assessed_by_employee_id,
    assessed_at = now(), updated_at = now()
  returning * into v_triage;

  update public.clinical_queue_entries set
    status = 'waiting', priority = v_acuity, triaged_at = now(), waiting_at = coalesce(waiting_at, now()),
    last_operator_employee_id = p_actor_employee_id, version = version + 1, updated_at = now()
  where id = v_queue.id returning * into v_queue;

  perform public.append_patient_journey_event(
    v_queue.tenant_id, v_queue.store_id, p_actor_employee_id, p_actor_role,
    'triage.completed', 'triage_assessment', v_triage.id::text, v_queue.customer_id,
    v_queue.pet_id, v_queue.appointment_id, v_queue.id, v_queue.encounter_id,
    'triage', 'waiting', null, p_payload->>'notes', '{}'::jsonb, to_jsonb(v_triage),
    p_source_workbench, p_request_id, p_request_id, p_idempotency_key
  );
  return v_triage;
end;
$$;

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

create or replace function public.transition_workflow_task(
  p_task_id uuid,
  p_action text,
  p_target_employee_id uuid,
  p_reason text,
  p_actor_employee_id uuid,
  p_actor_role text,
  p_source_workbench text,
  p_request_id text,
  p_idempotency_key text
)
returns public.workflow_tasks
language plpgsql security definer set search_path = public
as $$
declare
  v_task public.workflow_tasks;
  v_before public.workflow_tasks;
  v_target_status text;
  v_allowed boolean := false;
begin
  select * into v_task from public.workflow_tasks where id = p_task_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'WORKFLOW_TASK_NOT_FOUND'; end if;
  v_before := v_task;
  v_target_status := case p_action
    when 'claim' then 'claimed' when 'transfer' then 'pending' when 'start' then 'in_progress'
    when 'complete' then 'completed' when 'fail' then 'failed' when 'cancel' then 'cancelled'
    else null end;
  if v_target_status is null then raise exception using errcode = '22023', message = 'INVALID_TASK_ACTION'; end if;
  v_allowed := case
    when p_action = 'claim' and v_task.status in ('pending', 'failed') then true
    when p_action = 'transfer' and v_task.status in ('pending', 'claimed') then true
    when p_action = 'start' and v_task.status = 'claimed' then true
    when p_action = 'complete' and v_task.status = 'in_progress' then true
    when p_action = 'fail' and v_task.status in ('claimed', 'in_progress') then true
    when p_action = 'cancel' and v_task.status in ('pending', 'claimed', 'in_progress') then true
    else false end;
  if not v_allowed then
    raise exception using errcode = '23514', message = 'INVALID_TASK_TRANSITION';
  end if;
  if p_action in ('start', 'complete', 'fail')
    and v_task.assignee_employee_id is distinct from p_actor_employee_id
  then raise exception using errcode = '42501', message = 'TASK_CLAIMED_BY_OTHER_EMPLOYEE'; end if;
  if p_action in ('claim', 'transfer') and coalesce(p_target_employee_id, p_actor_employee_id) is null then
    raise exception using errcode = '22023', message = 'TASK_ASSIGNEE_REQUIRED';
  end if;
  if p_action in ('fail', 'cancel', 'transfer') and coalesce(trim(p_reason), '') = '' then
    raise exception using errcode = '22023', message = 'TASK_REASON_REQUIRED';
  end if;
  if p_action in ('start', 'complete') and exists (
    select 1 from public.encounter_charge_items ci
    where ci.tenant_id = v_task.tenant_id
      and ci.source_type = v_task.source_type
      and ci.source_id = v_task.source_id
      and ci.payment_required_before_execution
      and ci.status in ('pending', 'invoiced')
  ) then
    raise exception using errcode = '23514', message = 'PAYMENT_REQUIRED_BEFORE_EXECUTION';
  end if;

  update public.workflow_tasks set
    status = v_target_status,
    assignee_employee_id = case when p_action in ('claim', 'transfer') then coalesce(p_target_employee_id, p_actor_employee_id) else assignee_employee_id end,
    claimed_at = case when p_action = 'claim' then now() else claimed_at end,
    started_at = case when p_action = 'start' then now() else started_at end,
    completed_at = case when p_action = 'complete' then now() else completed_at end,
    outcome_note = case when p_action = 'complete' then p_reason else outcome_note end,
    failure_reason = case when p_action in ('fail', 'cancel') then p_reason else failure_reason end,
    last_operator_employee_id = p_actor_employee_id,
    version = version + 1, updated_at = now()
  where id = p_task_id returning * into v_task;

  perform public.append_patient_journey_event(
    v_task.tenant_id, v_task.store_id, p_actor_employee_id, p_actor_role,
    'workflow_task.' || p_action, 'workflow_task', v_task.id::text, v_task.customer_id,
    v_task.pet_id, null, null, v_task.encounter_id, v_before.status, v_task.status,
    p_reason, null, to_jsonb(v_before), to_jsonb(v_task), p_source_workbench,
    p_request_id, p_request_id, p_idempotency_key
  );
  return v_task;
end;
$$;

-- 医疗项目同步到收银待付款。来源唯一约束保证命令重试不重复计费。
create or replace function public.upsert_encounter_charge_item(
  p_encounter_id uuid,
  p_source_type text,
  p_source_id text,
  p_source_line_id text,
  p_catalog_item_id uuid,
  p_item_name text,
  p_quantity numeric,
  p_unit_price numeric,
  p_payment_required boolean,
  p_actor_employee_id uuid,
  p_actor_role text,
  p_source_workbench text,
  p_request_id text,
  p_idempotency_key text
)
returns public.encounter_charge_items
language plpgsql security definer set search_path = public
as $$
declare
  v_encounter public.encounters;
  v_charge public.encounter_charge_items;
  v_before public.encounter_charge_items;
begin
  select * into v_encounter from public.encounters where id = p_encounter_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'ENCOUNTER_NOT_FOUND'; end if;
  if v_encounter.clinical_status not in ('active', 'plan_ready') then
    raise exception using errcode = '23514', message = 'ENCOUNTER_NOT_CHARGEABLE';
  end if;
  if coalesce(trim(p_item_name), '') = '' or coalesce(p_quantity, 0) <= 0 or coalesce(p_unit_price, 0) < 0 then
    raise exception using errcode = '22023', message = 'INVALID_CHARGE_ITEM';
  end if;

  select * into v_before from public.encounter_charge_items
  where tenant_id = v_encounter.tenant_id and source_type = p_source_type
    and source_id = p_source_id and source_line_id = coalesce(p_source_line_id, '')
  for update;

  if found and v_before.status <> 'pending' then
    raise exception using errcode = '23514', message = 'CHARGE_ITEM_ALREADY_SETTLED';
  end if;

  insert into public.encounter_charge_items (
    tenant_id, store_id, encounter_id, customer_id, pet_id, source_type, source_id,
    source_line_id, catalog_item_id, item_name, quantity, unit_price,
    payment_required_before_execution, created_by_employee_id
  ) values (
    v_encounter.tenant_id, v_encounter.store_id, v_encounter.id, v_encounter.customer_id,
    v_encounter.pet_id, p_source_type, p_source_id, coalesce(p_source_line_id, ''),
    p_catalog_item_id, p_item_name, p_quantity, p_unit_price, p_payment_required,
    p_actor_employee_id
  )
  on conflict (tenant_id, source_type, source_id, source_line_id) do update set
    catalog_item_id = excluded.catalog_item_id, item_name = excluded.item_name,
    quantity = excluded.quantity, unit_price = excluded.unit_price,
    payment_required_before_execution = excluded.payment_required_before_execution,
    updated_at = now()
  returning * into v_charge;

  perform public.append_patient_journey_event(
    v_charge.tenant_id, v_charge.store_id, p_actor_employee_id, p_actor_role,
    case when v_before.id is null then 'charge_item.created' else 'charge_item.updated' end,
    'encounter_charge_item', v_charge.id::text, v_charge.customer_id, v_charge.pet_id,
    v_encounter.appointment_id, null, v_charge.encounter_id,
    case when v_before.id is null then null else v_before.status end, v_charge.status,
    null, null, coalesce(to_jsonb(v_before), '{}'::jsonb), to_jsonb(v_charge),
    p_source_workbench, p_request_id, p_request_id, p_idempotency_key
  );
  return v_charge;
end;
$$;

-- 收银员只能作废尚未结算的待付款条目，禁止物理删除。
create or replace function public.void_encounter_charge_item(
  p_charge_item_id uuid,
  p_reason text,
  p_actor_employee_id uuid,
  p_actor_role text,
  p_source_workbench text,
  p_request_id text,
  p_idempotency_key text
)
returns public.encounter_charge_items
language plpgsql security definer set search_path = public
as $$
declare
  v_charge public.encounter_charge_items;
  v_before public.encounter_charge_items;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception using errcode = '22023', message = 'VOID_REASON_REQUIRED';
  end if;
  select * into v_charge from public.encounter_charge_items where id = p_charge_item_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'CHARGE_ITEM_NOT_FOUND'; end if;
  if v_charge.status <> 'pending' then
    raise exception using errcode = '23514', message = 'ONLY_PENDING_CHARGE_CAN_BE_VOIDED';
  end if;
  v_before := v_charge;

  update public.encounter_charge_items set
    status = 'voided', voided_by_employee_id = p_actor_employee_id,
    voided_at = now(), void_reason = trim(p_reason), updated_at = now()
  where id = p_charge_item_id returning * into v_charge;

  update public.workflow_tasks set
    status = 'cancelled', failure_reason = '收费条目已作废：' || trim(p_reason),
    last_operator_employee_id = p_actor_employee_id, version = version + 1, updated_at = now()
  where tenant_id = v_charge.tenant_id and source_type = v_charge.source_type
    and source_id = v_charge.source_id and status in ('pending', 'claimed');

  perform public.append_patient_journey_event(
    v_charge.tenant_id, v_charge.store_id, p_actor_employee_id, p_actor_role,
    'charge_item.voided', 'encounter_charge_item', v_charge.id::text,
    v_charge.customer_id, v_charge.pet_id, null, null, v_charge.encounter_id,
    v_before.status, v_charge.status, trim(p_reason), '客户对收费项目提出异议',
    to_jsonb(v_before), to_jsonb(v_charge), p_source_workbench,
    p_request_id, p_request_id, p_idempotency_key
  );
  return v_charge;
end;
$$;

create or replace function public.transition_encounter_clinical_status(
  p_encounter_id uuid,
  p_target_status text,
  p_reason text,
  p_actor_employee_id uuid,
  p_actor_role text,
  p_source_workbench text,
  p_request_id text,
  p_idempotency_key text
)
returns public.encounters
language plpgsql security definer set search_path = public
as $$
declare
  v_encounter public.encounters;
  v_before public.encounters;
  v_blockers integer;
begin
  select * into v_encounter from public.encounters where id = p_encounter_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'ENCOUNTER_NOT_FOUND'; end if;
  v_before := v_encounter;

  if p_target_status = 'plan_ready' and v_encounter.clinical_status <> 'active' then
    raise exception using errcode = '23514', message = 'ENCOUNTER_NOT_ACTIVE';
  elsif p_target_status = 'closed' then
    select count(*) into v_blockers from public.workflow_tasks
    where encounter_id = p_encounter_id and status in ('pending', 'claimed', 'in_progress')
      and task_type not in ('record_sign', 'followup');
    if v_blockers > 0 then raise exception using errcode = '23514', message = 'ENCOUNTER_HAS_OPEN_TASKS'; end if;
    if exists (select 1 from public.encounter_charge_items where encounter_id = p_encounter_id and status in ('pending', 'invoiced')) then
      raise exception using errcode = '23514', message = 'ENCOUNTER_HAS_UNPAID_CHARGES';
    end if;
  elsif p_target_status in ('cancelled', 'transferred') and coalesce(trim(p_reason), '') = '' then
    raise exception using errcode = '22023', message = 'ENCOUNTER_REASON_REQUIRED';
  elsif p_target_status not in ('plan_ready', 'closed', 'cancelled', 'transferred') then
    raise exception using errcode = '22023', message = 'INVALID_ENCOUNTER_TARGET_STATUS';
  end if;

  update public.encounters set
    clinical_status = p_target_status,
    status = case when p_target_status = 'closed' then 'completed' else status end,
    ended_at = case when p_target_status in ('closed', 'cancelled', 'transferred') then now() else ended_at end,
    version = version + 1,
    updated_at = now()
  where id = p_encounter_id returning * into v_encounter;

  perform public.append_patient_journey_event(
    v_encounter.tenant_id, v_encounter.store_id, p_actor_employee_id, p_actor_role,
    'encounter.' || p_target_status, 'encounter', v_encounter.id::text,
    v_encounter.customer_id, v_encounter.pet_id, v_encounter.appointment_id, null,
    v_encounter.id, v_before.clinical_status, v_encounter.clinical_status, p_reason,
    null, to_jsonb(v_before), to_jsonb(v_encounter), p_source_workbench,
    p_request_id, p_request_id, p_idempotency_key
  );
  return v_encounter;
end;
$$;

-- RLS：员工可按门店读取；写入由 service role RPC 完成，不创建写策略。
-- 医生开具处方后，自动生成逐项待付款记录与药房任务。
-- 触发器运行在 issue_prescription 的同一事务中，任一写入失败会回滚处方开具。
create or replace function public.sync_issued_prescription_to_journey()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  v_item record;
  v_price numeric(14,2);
  v_name text;
begin
  if new.status <> 'issued' or old.status = 'issued' then return new; end if;
  for v_item in select * from public.prescription_items where prescription_id = new.id loop
    select coalesce(sci.custom_price, ci.default_price, 0), coalesce(sci.custom_name, ci.name, v_item.drug_name)
      into v_price, v_name
    from public.catalog_items ci
    left join public.store_catalog_items sci
      on sci.catalog_item_id = ci.id and sci.store_id = new.store_id and sci.is_active
    where ci.id = v_item.catalog_item_id;
    insert into public.encounter_charge_items (
      tenant_id, store_id, encounter_id, customer_id, pet_id, source_type, source_id,
      source_line_id, catalog_item_id, item_name, quantity, unit_price,
      payment_required_before_execution, created_by_employee_id
    ) values (
      new.tenant_id, new.store_id, new.encounter_id, new.customer_id, new.pet_id,
      'prescription', new.id::text, v_item.id::text, v_item.catalog_item_id,
      coalesce(v_name, v_item.drug_name), greatest(v_item.quantity, 0.001),
      coalesce(v_price, 0), true, new.prescriber_employee_id
    ) on conflict (tenant_id, source_type, source_id, source_line_id) do nothing;
  end loop;
  insert into public.workflow_tasks (
    tenant_id, store_id, encounter_id, customer_id, pet_id, task_type, owner_role,
    source_type, source_id, title, description, created_by_employee_id
  ) values (
    new.tenant_id, new.store_id, new.encounter_id, new.customer_id, new.pet_id,
    'prescription_dispense', 'pharmacist', 'prescription', new.id::text,
    '审核并发放处方药品', '付款完成后由药房审核、复核批次并发药', new.prescriber_employee_id
  ) on conflict (tenant_id, source_type, source_id, task_type, owner_role) do nothing;
  perform public.append_patient_journey_event(
    new.tenant_id, new.store_id, new.prescriber_employee_id, 'doctor',
    'prescription.issued', 'prescription', new.id::text, new.customer_id, new.pet_id,
    null, null, new.encounter_id, old.status, new.status, null, null,
    to_jsonb(old), to_jsonb(new), 'workbench.doctor', null, null,
    'prescription-issued:' || new.id::text
  );
  return new;
end;
$$;

drop trigger if exists trg_sync_issued_prescription_to_journey on public.prescriptions;
create trigger trg_sync_issued_prescription_to_journey
after update of status on public.prescriptions
for each row execute function public.sync_issued_prescription_to_journey();

-- 检验、影像申请创建后，自动生成收费项、执行岗位任务和不可变旅程事件。
create or replace function public.sync_diagnostic_order_to_journey()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  v_employee public.employees;
  v_role text;
  v_price numeric(14,2);
  v_name text;
  v_owner_role text;
  v_task_type text;
  v_source_type text;
begin
  if new.encounter_id is null or new.store_id is null then return new; end if;
  select * into v_employee from public.employees
    where tenant_id = new.tenant_id and user_id = new.requested_by and status = 'active' limit 1;
  if not found then raise exception using errcode = '42501', message = 'ACTIVE_EMPLOYEE_REQUIRED'; end if;
  select r.code into v_role
    from public.employee_role_assignments era join public.roles r on r.id = era.role_id
    where era.employee_id = v_employee.id and era.tenant_id = new.tenant_id
      and (era.store_id is null or era.store_id = new.store_id)
    order by case when r.code = 'doctor' then 0 else 1 end, r.code limit 1;
  if v_role is null then raise exception using errcode = '42501', message = 'ACTIVE_ROLE_CONTEXT_REQUIRED'; end if;
  v_source_type := case when tg_table_name = 'lab_orders' then 'lab_order' else 'imaging_order' end;
  v_owner_role := case when tg_table_name = 'lab_orders' then 'lab_technician' else 'imaging_technician' end;
  v_task_type := case when tg_table_name = 'lab_orders' then 'lab_test' else 'imaging_exam' end;
  if new.catalog_item_id is not null then
    select coalesce(sci.custom_price, ci.default_price, 0), coalesce(sci.custom_name, ci.name)
      into v_price, v_name
    from public.catalog_items ci
    left join public.store_catalog_items sci
      on sci.catalog_item_id = ci.id and sci.store_id = new.store_id and sci.is_active
    where ci.id = new.catalog_item_id;
    insert into public.encounter_charge_items (
      tenant_id, store_id, encounter_id, customer_id, pet_id, source_type, source_id,
      source_line_id, catalog_item_id, item_name, quantity, unit_price,
      payment_required_before_execution, created_by_employee_id
    ) values (
      new.tenant_id, new.store_id, new.encounter_id, new.customer_id, new.pet_id,
      v_source_type, new.id::text, '', new.catalog_item_id,
      coalesce(v_name, case when tg_table_name = 'lab_orders' then '检验项目' else '影像检查' end),
      1, coalesce(v_price, 0), true, v_employee.id
    ) on conflict (tenant_id, source_type, source_id, source_line_id) do nothing;
  end if;
  insert into public.workflow_tasks (
    tenant_id, store_id, encounter_id, customer_id, pet_id, task_type, owner_role,
    source_type, source_id, title, description, created_by_employee_id
  ) values (
    new.tenant_id, new.store_id, new.encounter_id, new.customer_id, new.pet_id,
    v_task_type, v_owner_role, v_source_type, new.id::text,
    case when tg_table_name = 'lab_orders' then '执行检验申请' else '执行影像检查' end,
    '默认付款后执行；急诊或授信放行需具备权限并填写原因', v_employee.id
  ) on conflict (tenant_id, source_type, source_id, task_type, owner_role) do nothing;
  perform public.append_patient_journey_event(
    new.tenant_id, new.store_id, v_employee.id, v_role,
    v_source_type || '.created', v_source_type, new.id::text, new.customer_id, new.pet_id,
    null, null, new.encounter_id, null, new.status, null, null,
    '{}'::jsonb, to_jsonb(new), 'workbench.' || v_role, null, null,
    v_source_type || '-created:' || new.id::text
  );
  return new;
end;
$$;

drop trigger if exists trg_sync_lab_order_to_journey on public.lab_orders;
create trigger trg_sync_lab_order_to_journey after insert on public.lab_orders
for each row execute function public.sync_diagnostic_order_to_journey();
drop trigger if exists trg_sync_imaging_order_to_journey on public.imaging_orders;
create trigger trg_sync_imaging_order_to_journey after insert on public.imaging_orders
for each row execute function public.sync_diagnostic_order_to_journey();

-- 从患者待付款条目原子创建发票，并把来源条目绑定到该发票。
create or replace function public.create_invoice_from_pending_charges(
  p_encounter_id uuid,
  p_charge_item_ids uuid[],
  p_discount_amount numeric,
  p_discount_reason text,
  p_tax_amount numeric,
  p_operator_employee_id uuid,
  p_actor_role text,
  p_source_workbench text,
  p_request_id text,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_encounter public.encounters;
  v_operator public.employees;
  v_items jsonb;
  v_result jsonb;
  v_invoice_id uuid;
  v_count integer;
begin
  select * into v_encounter from public.encounters where id=p_encounter_id for update;
  if not found then raise exception using errcode='P0002', message='ENCOUNTER_NOT_FOUND'; end if;
  if p_idempotency_key is not null then
    select after_data->'invoice' into v_result from public.patient_journey_events
      where tenant_id=v_encounter.tenant_id and event_type='invoice.created_from_charges'
        and idempotency_key=p_idempotency_key limit 1;
    if v_result is not null then return v_result; end if;
  end if;
  select * into v_operator from public.employees where id=p_operator_employee_id and tenant_id=v_encounter.tenant_id and status='active';
  if not found then raise exception using errcode='42501', message='ACTIVE_EMPLOYEE_REQUIRED'; end if;
  perform 1 from public.encounter_charge_items
    where id=any(p_charge_item_ids) and encounter_id=p_encounter_id for update;
  select count(*), jsonb_agg(jsonb_build_object(
    'catalog_item_id', catalog_item_id, 'name', item_name, 'unit_price', unit_price,
    'quantity', quantity, 'amount', amount, 'discount_amount', 0,
    'category', case when source_type='prescription' then 'drug'
      when source_type in ('lab_order','imaging_order') then 'exam' else 'service' end
  ) order by created_at) into v_count, v_items
  from public.encounter_charge_items
  where id=any(p_charge_item_ids) and encounter_id=p_encounter_id and status='pending';
  if v_count <> cardinality(p_charge_item_ids) or v_count=0 then
    raise exception using errcode='23514', message='CHARGE_ITEMS_NOT_ALL_PENDING';
  end if;
  v_result := public.create_invoice(
    v_encounter.tenant_id, v_encounter.store_id, v_encounter.customer_id, v_encounter.pet_id,
    v_encounter.id, v_items, coalesce(p_discount_amount,0), p_discount_reason,
    coalesce(p_tax_amount,0), null, null, v_operator.user_id, true
  );
  v_invoice_id := (v_result->>'invoiceId')::uuid;
  update public.encounter_charge_items set status='invoiced', invoice_id=v_invoice_id, updated_at=now()
    where id=any(p_charge_item_ids);
  perform public.append_patient_journey_event(
    v_encounter.tenant_id, v_encounter.store_id, p_operator_employee_id, p_actor_role,
    'invoice.created_from_charges', 'invoice', v_invoice_id::text, v_encounter.customer_id,
    v_encounter.pet_id, v_encounter.appointment_id, null, v_encounter.id, 'pending', 'invoiced',
    p_discount_reason, null, '{}'::jsonb,
    jsonb_build_object('invoice',v_result,'chargeItemIds',p_charge_item_ids),
    p_source_workbench, p_request_id, p_request_id, p_idempotency_key
  );
  return v_result;
end;
$$;

-- 发票支付、取消或退款后同步来源收费条目，保证下游付款门禁读取真实状态。
create or replace function public.sync_invoice_status_to_charge_items()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.status is not distinct from old.status then return new; end if;
  if new.status='paid' then
    update public.encounter_charge_items set status='paid', updated_at=now()
      where invoice_id=new.id and status='invoiced';
  elsif new.status='cancelled' then
    update public.encounter_charge_items set status='pending', invoice_id=null, updated_at=now()
      where invoice_id=new.id and status='invoiced';
  elsif new.status='refunded' then
    update public.encounter_charge_items set status='refunded', updated_at=now()
      where invoice_id=new.id and status='paid';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_sync_invoice_status_to_charge_items on public.invoices;
create trigger trg_sync_invoice_status_to_charge_items after update of status on public.invoices
for each row execute function public.sync_invoice_status_to_charge_items();

alter table public.clinical_queue_entries enable row level security;
alter table public.triage_assessments enable row level security;
alter table public.patient_journey_events enable row level security;
alter table public.workflow_tasks enable row level security;
alter table public.encounter_charge_items enable row level security;
alter table public.workbench_preferences enable row level security;

create policy clinical_queue_select on public.clinical_queue_entries for select to authenticated
  using (public.can_access_store(tenant_id, store_id));
create policy triage_assessments_select on public.triage_assessments for select to authenticated
  using (public.can_access_store(tenant_id, store_id));
create policy journey_events_select on public.patient_journey_events for select to authenticated
  using (store_id is null or public.can_access_store(tenant_id, store_id));
create policy workflow_tasks_select on public.workflow_tasks for select to authenticated
  using (public.can_access_store(tenant_id, store_id));
create policy encounter_charge_items_select on public.encounter_charge_items for select to authenticated
  using (public.can_access_store(tenant_id, store_id));
create policy workbench_preferences_select on public.workbench_preferences for select to authenticated
  using (employee_id = public.current_employee_id(tenant_id));

revoke all on function public.append_patient_journey_event(uuid, uuid, uuid, text, text, text, text, uuid, uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, text, text, text, text, jsonb, uuid, text) from public, authenticated;
revoke all on function public.check_in_clinical_patient(uuid, boolean, text, uuid, text, text, text, text) from public, authenticated;
revoke all on function public.record_clinical_triage(uuid, jsonb, uuid, text, text, text, text) from public, authenticated;
revoke all on function public.transition_clinical_queue(uuid, text, text, text, uuid, text, text, text, text) from public, authenticated;
revoke all on function public.transition_workflow_task(uuid, text, uuid, text, uuid, text, text, text, text) from public, authenticated;
revoke all on function public.upsert_encounter_charge_item(uuid, text, text, text, uuid, text, numeric, numeric, boolean, uuid, text, text, text, text) from public, authenticated;
revoke all on function public.void_encounter_charge_item(uuid, text, uuid, text, text, text, text) from public, authenticated;
revoke all on function public.transition_encounter_clinical_status(uuid, text, text, uuid, text, text, text, text) from public, authenticated;
revoke all on function public.create_invoice_from_pending_charges(uuid, uuid[], numeric, text, numeric, uuid, text, text, text, text) from public, authenticated;

insert into public.permissions (code, name, module) values
  ('workbench.frontdesk', '前台工作台', 'workflow'),
  ('workbench.triage', '分诊工作台', 'workflow'),
  ('workbench.doctor', '医生工作台', 'workflow'),
  ('workbench.nurse', '治疗护士工作台', 'workflow'),
  ('workbench.lab', '检验工作台', 'workflow'),
  ('workbench.imaging', '影像工作台', 'workflow'),
  ('workbench.cashier', '收银工作台', 'workflow'),
  ('workbench.pharmacy', '药房工作台', 'workflow'),
  ('workbench.followup', '回访工作台', 'workflow'),
  ('workbench.manager', '门店医务工作台', 'workflow'),
  ('queue.view', '查看候诊队列', 'clinical'),
  ('queue.manage', '管理候诊队列', 'clinical'),
  ('queue.call', '叫号与过号', 'clinical'),
  ('queue.display', '候诊大屏', 'clinical'),
  ('triage.view', '查看分诊', 'clinical'),
  ('triage.write', '执行分诊', 'clinical'),
  ('workflow_task.view', '查看岗位任务', 'workflow'),
  ('workflow_task.execute', '执行岗位任务', 'workflow'),
  ('workflow_task.transfer', '转派岗位任务', 'workflow'),
  ('encounter.close', '完成患者离院', 'clinical'),
  ('clinical.payment_override', '医疗支付门禁放行', 'clinical'),
  ('journey.audit', '查看患者旅程审计', 'audit'),
  ('prescription.verify', '药师审核处方', 'clinical'),
  ('prescription.dispense', '药房发药', 'clinical'),
  ('charge_item.void', '作废待付款项目', 'billing')
on conflict (code) do update set name = excluded.name, module = excluded.module;

-- 系统岗位模板；既有自定义角色不自动撤权。
insert into public.roles (code, name, description, permissions, is_system, scope) values
  ('receptionist', '前台接待', '预约、签到、候诊与离院协调', array['workbench.frontdesk','appointment.view','appointment.manage','queue.view','queue.manage','customer.view','customer.create','pet.view','pet.create'], true, 'store'),
  ('triage_nurse', '分诊护士', '生命体征、风险和急诊分级', array['workbench.triage','queue.view','triage.view','triage.write','pet.view','encounter.view'], true, 'store'),
  ('pharmacist', '药房', '审方、发药和用药交代', array['workbench.pharmacy','prescription.view','prescription.verify','prescription.dispense','inventory.view','inventory.confirm','workflow_task.view','workflow_task.execute'], true, 'store'),
  ('lab_technician', '检验人员', '采样、检测、审核与发布', array['workbench.lab','lab.view','lab.collect','lab.result.input','lab.result.review','lab_sample.read','lab_sample.write','workflow_task.view','workflow_task.execute'], true, 'store'),
  ('imaging_technician', '影像人员', '排程、影像执行和报告', array['workbench.imaging','imaging.view','imaging.order','imaging.report','workflow_task.view','workflow_task.execute','file.upload','file.download'], true, 'store'),
  ('followup_service', '客服回访', '回访登记与复诊预约', array['workbench.followup','followup.view','appointment.view','appointment.manage','customer.view','pet.view','workflow_task.view','workflow_task.execute'], true, 'store')
  ,('waiting_display', '候诊大屏', '仅可读取脱敏叫号队列', array['queue.display'], true, 'store')
on conflict (code) do update set name = excluded.name, description = excluded.description,
  permissions = excluded.permissions, is_system = true, scope = excluded.scope;

update public.roles set permissions = array(select distinct unnest(permissions || array[
  'workbench.doctor','queue.view','queue.call','triage.view','workflow_task.view','encounter.close'
])) where code = 'doctor';
update public.roles set permissions = array(select distinct unnest(permissions || array[
  'workbench.nurse','queue.view','triage.view','workflow_task.view','workflow_task.execute'
])) where code = 'nurse';
update public.roles set permissions = array(select distinct unnest(permissions || array[
  'workbench.cashier','workflow_task.view','workflow_task.execute','charge_item.void'
])) where code = 'cashier';
update public.roles set permissions = array(select distinct unnest(permissions || array[
  'workbench.manager','queue.view','queue.manage','workflow_task.view','workflow_task.transfer',
  'clinical.payment_override','journey.audit','encounter.close'
])) where code in ('store_manager', 'tenant_owner');
