-- ============================================================
-- S3.1-AGENT-04: 客户回访任务 followup_tasks
-- 表 + 索引 + RLS
--
-- 状态机:
--   pending → in_progress → completed
--   pending/in_progress → cancelled
--
-- 核心原则:消息发送成功 ≠ 回访完成(完成必须登记 result)
-- ============================================================

create table if not exists public.followup_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,

  customer_id uuid not null,                -- 引用 customers.id,不加 FK(跨域查询由 Hono 聚合)
  pet_id uuid,                              -- 引用 pets.id,不加 FK

  source_type text not null default 'manual',   -- manual/encounter/discharge/reminder/complaint
  source_id uuid,

  task_type text not null default 'customer_care', -- post_visit/post_discharge/medication/recheck/customer_care/other
  scheduled_at timestamptz not null,
  assignee_employee_id uuid,                -- 引用 employees.id,不加 FK
  channel text,                             -- phone/wechat/sms/in_person/other

  status text not null default 'pending',   -- pending/in_progress/completed/cancelled

  result_code text,                         -- contacted/unreachable/rescheduled/other
  result_note text,
  started_at timestamptz,
  completed_at timestamptz,
  completed_by uuid,                        -- 引用 auth.users.id
  cancel_reason text,
  next_followup_at timestamptz,

  created_by uuid,                          -- 引用 auth.users.id
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint followup_tasks_status_check check (status in ('pending', 'in_progress', 'completed', 'cancelled')),
  constraint followup_tasks_source_type_check check (source_type in ('manual', 'encounter', 'discharge', 'reminder', 'complaint')),
  constraint followup_tasks_task_type_check check (task_type in ('post_visit', 'post_discharge', 'medication', 'recheck', 'customer_care', 'other')),
  constraint followup_tasks_channel_check check (channel is null or channel in ('phone', 'wechat', 'sms', 'in_person', 'other')),
  constraint followup_tasks_result_code_check check (result_code is null or result_code in ('contacted', 'unreachable', 'rescheduled', 'other')),
  -- 完成必须登记结果
  constraint followup_tasks_complete_has_result check (
    status <> 'completed' or (result_code is not null or result_note is not null)
  ),
  -- 取消必须给原因
  constraint followup_tasks_cancel_has_reason check (
    status <> 'cancelled' or (cancel_reason is not null and cancel_reason <> '')
  )
);

create index if not exists idx_followup_tasks_tenant_status_scheduled
  on public.followup_tasks (tenant_id, status, scheduled_at);
create index if not exists idx_followup_tasks_tenant_store_status
  on public.followup_tasks (tenant_id, store_id, status);
create index if not exists idx_followup_tasks_tenant_customer
  on public.followup_tasks (tenant_id, customer_id);
create index if not exists idx_followup_tasks_assignee
  on public.followup_tasks (assignee_employee_id) where assignee_employee_id is not null;
create index if not exists idx_followup_tasks_source
  on public.followup_tasks (source_type, source_id) where source_id is not null;

alter table public.followup_tasks enable row level security;

-- 读:租户成员可读,门店级数据须有该门店权限(同 customers 模式)
drop policy if exists "followup_tasks_select" on public.followup_tasks;
create policy "followup_tasks_select" on public.followup_tasks
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and (store_id is null or public.can_access_store(tenant_id, store_id))
  );

-- 写:通过 service role(Hono Command)为主;直连需 followup.manage 权限
drop policy if exists "followup_tasks_insert" on public.followup_tasks;
create policy "followup_tasks_insert" on public.followup_tasks
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'followup.manage')
  );

drop policy if exists "followup_tasks_update" on public.followup_tasks;
create policy "followup_tasks_update" on public.followup_tasks
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'followup.manage')
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'followup.manage')
  );

drop policy if exists "followup_tasks_delete" on public.followup_tasks;
create policy "followup_tasks_delete" on public.followup_tasks
  for delete to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'followup.manage')
  );
