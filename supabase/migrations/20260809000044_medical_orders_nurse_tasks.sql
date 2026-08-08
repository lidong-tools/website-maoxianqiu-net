-- ============================================================
-- 20260809000044_medical_orders_nurse_tasks.sql
-- S3.1 并发任务 C 医疗闭环增强:医嘱(medical_orders)+ 护士任务源增强
--
-- 角色:开发员工 C(独占 migration 44~49)
--
-- 本文件内容:
--   1. medical_orders 医嘱表(注射/输液/治疗/处置/护理/用药)
--   2. nurse_tasks 增强:source_type/source_id(保证 source 幂等)+
--      状态机扩展 pending/in_progress/completed/failed/cancelled(兼容旧 done/skipped)+
--      超时/异常字段(overdue_at / due_soon_at / exception_note / failed_reason / cancel_*)
--   3. RLS 策略(medical_orders 镜像 nurse_tasks)
--   4. 原子 RPC(全部 service-role-only,Hono 以 service role 调用):
--      create_medical_order / complete_nurse_task / cancel_nurse_task
--      fail_nurse_task / cancel_medical_order / scan_nurse_task_overdue
--   5. 审计:各 RPC 事务内写 audit_logs
--
-- 设计要点:
--   - 医生开立医嘱 → 自动生成护士任务(source_type='medical_order', source_id=order.id);
--     unique partial index 保证"同 source 仅一条任务"→ source 幂等
--   - source 取消:未执行任务 → cancelled;已执行任务(completed/failed)永久保留
--   - 完成/取消/失败/超时扫描全部走单事务 RPC,禁止前端直连改状态
--   - 幂等:create_medical_order 支持 idempotency-key(经 idempotency_records)
--   - 状态机:医嘱 active→completed/cancelled/expired;任务 pending/in_progress→completed/failed/cancelled
-- 幂等,可重复应用
-- ============================================================

-- ============================================================
-- 1. medical_orders 表(医嘱,MXQ-7007 闭环上游)
-- ============================================================
create table if not exists public.medical_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,
  encounter_id uuid,                                      -- 引用 encounters.id,不加 FK
  admission_id uuid,                                      -- 引用 admissions.id,不加 FK(住院医嘱)
  pet_id uuid not null,                                   -- 引用 pets.id,不加 FK
  customer_id uuid,                                       -- 引用 customers.id,不加 FK
  order_no text not null,                                 -- 医嘱单号(租户内唯一)
  order_type text not null default 'treatment',           -- injection/infusion/treatment/disposal/nursing/medication/other
  item_name text not null,                                -- 医嘱项目(如:静脉输液 / 皮下注射 / 换药)
  dosage text,                                            -- 剂量
  frequency text,                                         -- 频次(如 qd / bid / tid)
  quantity numeric(12,2) not null default 1,
  unit text,
  instructions text,                                      -- 执行说明
  scheduled_at timestamptz,                               -- 计划执行时间(缺省立即执行)
  assignee_id uuid,                                       -- 指定执行护士(auth.users.id,可空=待分派)
  status text not null default 'active',                  -- active/completed/cancelled/expired
  created_by uuid,                                        -- 开立医生(auth.users.id)
  completed_at timestamptz,
  completed_by uuid,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint medical_orders_type_check check (
    order_type in ('injection', 'infusion', 'treatment', 'disposal', 'nursing', 'medication', 'other')
  ),
  constraint medical_orders_status_check check (status in ('active', 'completed', 'cancelled', 'expired')),
  constraint medical_orders_quantity_check check (quantity >= 0)
);

-- 租户内医嘱单号唯一
create unique index if not exists idx_medical_orders_tenant_no
  on public.medical_orders (tenant_id, order_no);
create index if not exists idx_medical_orders_tenant_store
  on public.medical_orders (tenant_id, store_id);
create index if not exists idx_medical_orders_encounter
  on public.medical_orders (encounter_id) where encounter_id is not null;
create index if not exists idx_medical_orders_admission
  on public.medical_orders (admission_id) where admission_id is not null;
create index if not exists idx_medical_orders_pet
  on public.medical_orders (tenant_id, pet_id);
create index if not exists idx_medical_orders_status
  on public.medical_orders (tenant_id, store_id, status);

drop trigger if exists trg_medical_orders_updated_at on public.medical_orders;
create trigger trg_medical_orders_updated_at
  before update on public.medical_orders
  for each row execute procedure public.touch_updated_at();

-- ============================================================
-- 2. nurse_tasks 源增强(S3.1 医疗闭环)
--    保留旧列/旧状态(done/skipped)兼容既有 UI,新增源与异常字段
-- ============================================================
alter table public.nurse_tasks
  add column if not exists source_type text,              -- medical_order / manual(手建为空)
  add column if not exists source_id uuid,                -- 来源实体 id(medical_orders.id)
  add column if not exists started_at timestamptz,        -- 开始执行时间
  add column if not exists failed_reason text,            -- 失败原因(status=failed 时必填)
  add column if not exists exception_note text,           -- 异常备注(超时/待确认等)
  add column if not exists overdue_at timestamptz,        -- 超时标记时间(扫描 RPC 写入)
  add column if not exists due_soon_at timestamptz,       -- 即将到期标记时间(扫描 RPC 写入)
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid,
  add column if not exists cancel_reason text;

-- 状态机扩展:S3.1 新增 completed/failed/cancelled,保留 done/skipped 兼容旧 UI
alter table public.nurse_tasks drop constraint if exists nurse_tasks_status_check;
alter table public.nurse_tasks add constraint nurse_tasks_status_check
  check (status in ('pending', 'in_progress', 'done', 'skipped', 'completed', 'failed', 'cancelled'));

-- source 幂等:同 (source_type, source_id) 仅允许一条任务
-- 医生重复提交同一医嘱(网络重试/并发双击)不会生成重复护士任务
create unique index if not exists idx_nurse_tasks_source_unique
  on public.nurse_tasks (source_type, source_id)
  where source_type is not null and source_id is not null;

create index if not exists idx_nurse_tasks_source_id
  on public.nurse_tasks (source_id) where source_id is not null;

-- ============================================================
-- 3. RLS 策略(medical_orders 镜像 nurse_tasks 的 can_access_store 隔离)
-- ============================================================
alter table public.medical_orders enable row level security;

drop policy if exists "medical_orders_select" on public.medical_orders;
create policy "medical_orders_select" on public.medical_orders
  for select to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
    )
  );

drop policy if exists "medical_orders_insert" on public.medical_orders;
create policy "medical_orders_insert" on public.medical_orders
  for insert to authenticated
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'nurse_task.manage')
    )
  );

drop policy if exists "medical_orders_update" on public.medical_orders;
create policy "medical_orders_update" on public.medical_orders
  for update to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'nurse_task.manage')
    )
  )
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'nurse_task.manage')
    )
  );

drop policy if exists "medical_orders_delete" on public.medical_orders;
create policy "medical_orders_delete" on public.medical_orders
  for delete to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'nurse_task.manage')
    )
  );

-- ============================================================
-- 4. 医嘱类型 → 护士任务类型映射(函数,供 RPC 复用)
-- ============================================================
create or replace function public.medical_order_to_task_type(p_order_type text)
returns text
language sql
immutable
as $$
  select case p_order_type
    when 'injection'  then 'medication'       -- 注射归入给药
    when 'medication' then 'medication'       -- 用药归入给药
    when 'infusion'   then 'other'            -- 输液(现有 task_type 无输液项,归 other)
    when 'treatment'  then 'other'            -- 治疗处置
    when 'disposal'   then 'other'            -- 处置
    when 'nursing'    then 'care'             -- 护理
    else 'other'
  end;
$$;

revoke all on function public.medical_order_to_task_type(text) from public;
grant execute on function public.medical_order_to_task_type(text) to authenticated;

-- ============================================================
-- 5. create_medical_order RPC(开立医嘱 + 自动生成护士任务,单事务)
--    - 幂等:idempotency-key 命中返回原结果
--    - source 幂等:unique index (source_type, source_id) 防重复任务
-- ============================================================
create or replace function public.create_medical_order(
  p_tenant_id uuid,
  p_store_id uuid,
  p_pet_id uuid,
  p_customer_id uuid default null,
  p_encounter_id uuid default null,
  p_admission_id uuid default null,
  p_order_type text default 'treatment',
  p_item_name text default null,
  p_dosage text default null,
  p_frequency text default null,
  p_quantity numeric default 1,
  p_unit text default null,
  p_instructions text default null,
  p_scheduled_at timestamptz default null,
  p_assignee_id uuid default null,
  p_operator_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing jsonb;
  v_order public.medical_orders;
  v_task_id uuid;
  v_order_no text;
begin
  -- 幂等检查:同 idempotency_key 命中返回原结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  -- 校验医嘱类型合法(约束外再防御,返回明确错误码)
  if p_order_type not in ('injection', 'infusion', 'treatment', 'disposal', 'nursing', 'medication', 'other') then
    raise exception 'INVALID_ORDER_TYPE' using errcode = 'P0003';
  end if;

  -- 生成租户内唯一医嘱单号:MO-YYYYMMDD-随机后缀
  v_order_no := 'MO-' || to_char(now() at time zone 'Asia/Shanghai', 'YYYYMMDD') || '-' || upper(substr(md5(random()::text), 1, 6));

  -- 1) 写入医嘱
  insert into public.medical_orders (
    tenant_id, store_id, encounter_id, admission_id, pet_id, customer_id,
    order_no, order_type, item_name, dosage, frequency, quantity, unit,
    instructions, scheduled_at, assignee_id, status, created_by
  )
  values (
    p_tenant_id, p_store_id, p_encounter_id, p_admission_id, p_pet_id, p_customer_id,
    v_order_no, p_order_type, p_item_name, p_dosage, p_frequency, p_quantity, p_unit,
    p_instructions, p_scheduled_at, p_assignee_id, 'active', p_operator_id
  )
  returning * into v_order;

  -- 2) 自动生成护士任务(source 幂等由 unique index 兜底)
  insert into public.nurse_tasks (
    tenant_id, store_id, encounter_id, pet_id, assigned_to,
    task_type, description, scheduled_at, status,
    source_type, source_id
  )
  values (
    p_tenant_id, p_store_id, p_encounter_id, p_pet_id, p_assignee_id,
    public.medical_order_to_task_type(p_order_type),
    p_item_name || coalesce('(' || nullif(p_dosage, '') || ')', ''),
    coalesce(p_scheduled_at, now()), 'pending',
    'medical_order', v_order.id
  )
  returning id into v_task_id;

  -- 3) 记录幂等结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (p_tenant_id, p_idempotency_key, 'create_medical_order', 'medical_order', v_order.id, jsonb_build_object(
      'orderId', v_order.id,
      'taskId', v_task_id,
      'orderNo', v_order_no,
      'status', v_order.status
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  -- 4) 审计
  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (p_tenant_id, p_store_id, p_operator_id, 'medical_order.create', 'medical_order', v_order.id,
          jsonb_build_object('orderNo', v_order_no, 'orderType', p_order_type, 'itemName', p_item_name,
                             'taskId', v_task_id, 'encounterId', p_encounter_id, 'admissionId', p_admission_id));

  return jsonb_build_object(
    'orderId', v_order.id,
    'taskId', v_task_id,
    'orderNo', v_order_no,
    'status', v_order.status
  );
end;
$$;

-- ============================================================
-- 6. complete_nurse_task RPC(完成任务,单事务 + 审计)
--    - 状态机:pending/in_progress → completed
--    - 任务完成后,若其来源医嘱所有任务均已终态 → 医嘱自动 completed
-- ============================================================
create or replace function public.complete_nurse_task(
  p_task_id uuid,
  p_operator_id uuid default null,
  p_note text default null
)
returns public.nurse_tasks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.nurse_tasks;
begin
  select * into v_task from public.nurse_tasks where id = p_task_id for update;
  if not found then
    raise exception 'NURSE_TASK_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_task.status not in ('pending', 'in_progress', 'done') then
    raise exception 'NURSE_TASK_NOT_RUNNABLE' using errcode = 'P0003';
  end if;

  update public.nurse_tasks
  set status = 'completed',
      completed_at = now(),
      completed_by = p_operator_id,
      note = coalesce(p_note, note),
      exception_note = null,
      updated_at = now()
  where id = p_task_id
  returning * into v_task;

  -- 来源医嘱联动:所有关联任务均终态 → 医嘱 completed
  if v_task.source_type = 'medical_order' and v_task.source_id is not null then
    update public.medical_orders mo
    set status = 'completed', completed_at = now(), completed_by = p_operator_id, updated_at = now()
    where mo.id = v_task.source_id
      and mo.status = 'active'
      and not exists (
        select 1 from public.nurse_tasks nt
        where nt.source_type = 'medical_order' and nt.source_id = v_task.source_id
          and nt.status in ('pending', 'in_progress')
      );
  end if;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_task.tenant_id, v_task.store_id, p_operator_id, 'nurse_task.complete', 'nurse_task', p_task_id,
          jsonb_build_object('note', p_note, 'sourceType', v_task.source_type, 'sourceId', v_task.source_id));

  return v_task;
end;
$$;

-- ============================================================
-- 7. cancel_nurse_task RPC(取消任务,单事务 + 审计)
--    - 仅未执行任务(pending/in_progress)可取消;已执行任务永久保留
-- ============================================================
create or replace function public.cancel_nurse_task(
  p_task_id uuid,
  p_operator_id uuid default null,
  p_reason text default null
)
returns public.nurse_tasks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.nurse_tasks;
begin
  select * into v_task from public.nurse_tasks where id = p_task_id for update;
  if not found then
    raise exception 'NURSE_TASK_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_task.status not in ('pending', 'in_progress') then
    raise exception 'NURSE_TASK_ALREADY_EXECUTED' using errcode = 'P0003';
  end if;

  update public.nurse_tasks
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = p_operator_id,
      cancel_reason = p_reason,
      updated_at = now()
  where id = p_task_id
  returning * into v_task;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_task.tenant_id, v_task.store_id, p_operator_id, 'nurse_task.cancel', 'nurse_task', p_task_id,
          jsonb_build_object('reason', p_reason, 'sourceType', v_task.source_type, 'sourceId', v_task.source_id));

  return v_task;
end;
$$;

-- ============================================================
-- 8. fail_nurse_task RPC(标记失败,单事务 + 审计)
--    - 状态机:pending/in_progress → failed(须填写失败原因)
-- ============================================================
create or replace function public.fail_nurse_task(
  p_task_id uuid,
  p_reason text,
  p_operator_id uuid default null
)
returns public.nurse_tasks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.nurse_tasks;
begin
  if p_reason is null or p_reason = '' then
    raise exception 'FAIL_REASON_REQUIRED' using errcode = 'P0003';
  end if;

  select * into v_task from public.nurse_tasks where id = p_task_id for update;
  if not found then
    raise exception 'NURSE_TASK_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_task.status not in ('pending', 'in_progress') then
    raise exception 'NURSE_TASK_NOT_RUNNABLE' using errcode = 'P0003';
  end if;

  update public.nurse_tasks
  set status = 'failed',
      failed_reason = p_reason,
      updated_at = now()
  where id = p_task_id
  returning * into v_task;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_task.tenant_id, v_task.store_id, p_operator_id, 'nurse_task.fail', 'nurse_task', p_task_id,
          jsonb_build_object('reason', p_reason, 'sourceType', v_task.source_type, 'sourceId', v_task.source_id));

  return v_task;
end;
$$;

-- ============================================================
-- 9. cancel_medical_order RPC(取消医嘱,单事务 + 审计)
--    source 取消规则:未执行任务 → cancelled;已执行任务(completed/failed)永久保留
-- ============================================================
create or replace function public.cancel_medical_order(
  p_order_id uuid,
  p_operator_id uuid default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.medical_orders;
  v_cancelled_tasks integer := 0;
  v_kept_tasks integer := 0;
begin
  select * into v_order from public.medical_orders where id = p_order_id for update;
  if not found then
    raise exception 'MEDICAL_ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_order.status <> 'active' then
    raise exception 'MEDICAL_ORDER_NOT_ACTIVE' using errcode = 'P0003';
  end if;

  -- 未执行任务 → cancelled;已执行任务永久保留
  update public.nurse_tasks
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = p_operator_id,
      cancel_reason = coalesce(p_reason, '医嘱取消'),
      updated_at = now()
  where source_type = 'medical_order'
    and source_id = p_order_id
    and status in ('pending', 'in_progress');
  get diagnostics v_cancelled_tasks = row_count;

  select count(*) into v_kept_tasks
  from public.nurse_tasks
  where source_type = 'medical_order'
    and source_id = p_order_id
    and status in ('completed', 'failed', 'done');

  update public.medical_orders
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = p_operator_id,
      cancel_reason = p_reason,
      updated_at = now()
  where id = p_order_id;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_order.tenant_id, v_order.store_id, p_operator_id, 'medical_order.cancel', 'medical_order', p_order_id,
          jsonb_build_object('reason', p_reason, 'cancelledTasks', v_cancelled_tasks, 'keptExecutedTasks', v_kept_tasks));

  return jsonb_build_object(
    'orderId', p_order_id,
    'status', 'cancelled',
    'cancelledTasks', v_cancelled_tasks,
    'keptExecutedTasks', v_kept_tasks
  );
end;
$$;

-- ============================================================
-- 10. scan_nurse_task_overdue RPC(超时/即将到期扫描,单事务 + 审计)
--     规则(Asia/Shanghai 业务时区):
--       - scheduled_at < now() 且未完成 → overdue_at 置位 + exception_note
--       - now() ≤ scheduled_at ≤ now()+2h 且未完成 → due_soon_at 置位
--     幂等:已标记的不重复覆盖;重复扫描返回已更新数
-- ============================================================
create or replace function public.scan_nurse_task_overdue(
  p_tenant_id uuid,
  p_store_id uuid default null,
  p_due_soon_minutes integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_overdue integer := 0;
  v_due_soon integer := 0;
begin
  -- 超时:pending/in_progress 且计划时间已过
  update public.nurse_tasks
  set overdue_at = coalesce(overdue_at, now()),
      exception_note = coalesce(exception_note, '任务已超过计划执行时间')
  where tenant_id = p_tenant_id
    and (p_store_id is null or store_id = p_store_id)
    and status in ('pending', 'in_progress')
    and scheduled_at is not null
    and scheduled_at < now()
    and overdue_at is null;
  get diagnostics v_overdue = row_count;

  -- 即将到期:pending/in_progress 且未来 p_due_soon_minutes 分钟内执行
  update public.nurse_tasks
  set due_soon_at = coalesce(due_soon_at, now())
  where tenant_id = p_tenant_id
    and (p_store_id is null or store_id = p_store_id)
    and status in ('pending', 'in_progress')
    and scheduled_at is not null
    and scheduled_at between now() and now() + make_interval(mins => p_due_soon_minutes)
    and due_soon_at is null;
  get diagnostics v_due_soon = row_count;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (p_tenant_id, p_store_id, null, 'nurse_task.scan_overdue', 'nurse_task', null,
          jsonb_build_object('overdueCount', v_overdue, 'dueSoonCount', v_due_soon));

  return jsonb_build_object('overdueCount', v_overdue, 'dueSoonCount', v_due_soon);
end;
$$;

-- ============================================================
-- 11. 结束(权限收紧统一放 migration 49 的 revoke DO 块)
-- ============================================================
