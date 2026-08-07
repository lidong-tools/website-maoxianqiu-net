-- ============================================================
-- 20260806000018_operations.sql
-- Operations 领域(MXQ-12001~12009)
--   - 会员等级 / 会员关系(MXQ-12001)
--   - 积分流水 + adjust_points RPC(MXQ-12002)
--   - 消息模板(MXQ-12003)
--   - 提醒扫描 + scan_reminders RPC(MXQ-12004)
--   - 发送适配器 message_deliveries(MXQ-12005)
--   - 导入任务 import_tasks(MXQ-12006)
--   - 打印模板/任务(MXQ-12007)
--   - 报表定义/快照(MXQ-12008)
--   - 安全事件(MXQ-12009)
--   - jobs 异步任务队列(若不存在则创建,框架级)
--   - RLS 策略(基于 is_tenant_member / can_access_store / has_permission)
--   - 权限码:membership.view / membership.manage / points.adjust /
--             message.manage / reminder.manage / imports.manage /
--             print.manage / reports.view / security.view
-- 幂等,可重复应用
--
-- 状态机:
--   reminders:     pending → sent / pending → cancelled
--   deliveries:    queued → sent / queued → failed / queued → retry → sent
--   import_tasks:  pending → processing → completed | failed
--   print_jobs:    queued → printed / queued → failed
--
-- 设计要点:
--   - customer_id / pet_id / file_id 不加外键(假设 customers/pets/files 表存在,
--     但跨域 FK 会让迁移耦合,统一用 uuid + 应用层校验)
--   - point_transactions / security_events 不可变(RLS 拒绝 update/delete)
--   - security_events 仅 service_role 写入,system_admin 可读
--   - 跨表事务(积分增减 + 流水写入)走 adjust_points RPC
-- ============================================================

-- ===== 0. jobs 表(框架级异步任务队列,若不存在则创建) =====
-- 任务说明里提到 "jobs 表已存在(见migration 00009)",但实际未创建。
-- 此处兜底建表(if not exists),被 scan_reminders 等异步流程使用。
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  store_id uuid references public.stores(id) on delete cascade,
  queue text not null default 'default',                -- default / reminders / imports / reports
  payload jsonb not null default '{}',
  status text not null default 'queued',                -- queued / running / completed / failed
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  last_error text,
  available_at timestamptz not null default now(),
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint jobs_status_check check (status in ('queued', 'running', 'completed', 'failed'))
);

create index if not exists idx_jobs_queue_status on public.jobs (queue, status, available_at);
create index if not exists idx_jobs_tenant on public.jobs (tenant_id);

alter table public.jobs enable row level security;
-- jobs 表仅 service role 可读写;普通用户禁止访问
drop policy if exists "jobs_admin_read" on public.jobs;
create policy "jobs_admin_read" on public.jobs
  for select to authenticated using (public.is_system_admin());

-- ===== MXQ-12001 会员等级 =====
create table if not exists public.membership_tiers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  name text not null,
  discount_percent numeric(5,2) not null default 100.00,
  points_multiplier numeric(3,2) not null default 1.00,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint membership_tiers_discount_check check (discount_percent >= 0 and discount_percent <= 100),
  constraint membership_tiers_multiplier_check check (points_multiplier >= 0)
);

create unique index if not exists idx_membership_tiers_tenant_code on public.membership_tiers (tenant_id, code);
create index if not exists idx_membership_tiers_tenant_active on public.membership_tiers (tenant_id, is_active, sort_order);

-- 会员关系(客户当前所属等级 + 积分余额快照)
create table if not exists public.customer_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null,                            -- 不加 FK,跨模块解耦
  tier_id uuid references public.membership_tiers(id) on delete set null,
  points_balance integer not null default 0,
  joined_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_customer_memberships_tenant_customer on public.customer_memberships (tenant_id, customer_id);
create index if not exists idx_customer_memberships_tier on public.customer_memberships (tier_id);

-- ===== MXQ-12002 积分流水(不可变) =====
create table if not exists public.point_transactions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null,                            -- 不加 FK,跨模块解耦
  delta integer not null,                               -- 正数获得,负数消耗
  reason text not null,                                 -- purchase / redeem / adjust / expiry
  reference_type text,                                  -- 关联业务实体类型(encounter/order/import/...)
  reference_id uuid,                                    -- 关联业务实体 id
  balance_after integer not null,                       -- 操作后余额(快照)
  operator_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint point_transactions_reason_check check (reason in ('purchase', 'redeem', 'adjust', 'expiry')),
  constraint point_transactions_delta_check check (delta <> 0)
);

create index if not exists idx_point_transactions_customer on public.point_transactions (tenant_id, customer_id, created_at desc);
create index if not exists idx_point_transactions_reference on public.point_transactions (reference_type, reference_id) where reference_id is not null;

-- ===== MXQ-12003 消息模板 =====
create table if not exists public.message_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  name text not null,
  channel text not null,                                -- sms / email / wechat / work_wechat
  subject text,
  body text not null,
  variables jsonb not null default '{}'::jsonb,         -- 变量 schema 定义
  is_active boolean not null default true,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint message_templates_channel_check check (channel in ('sms', 'email', 'wechat', 'work_wechat'))
);

create unique index if not exists idx_message_templates_tenant_code on public.message_templates (tenant_id, code);
create index if not exists idx_message_templates_tenant_active on public.message_templates (tenant_id, is_active);

drop trigger if exists trg_message_templates_updated_at on public.message_templates;
create trigger trg_message_templates_updated_at
  before update on public.message_templates
  for each row execute procedure public.touch_updated_at();

-- ===== MXQ-12004 提醒 =====
create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  store_id uuid references public.stores(id) on delete cascade,
  customer_id uuid,                                     -- 不加 FK
  pet_id uuid,                                          -- 不加 FK
  type text not null,                                   -- vaccine / deworming / revisit / birthday / other
  scheduled_at timestamptz not null,
  status text not null default 'pending',               -- pending / sent / cancelled
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint reminders_type_check check (type in ('vaccine', 'deworming', 'revisit', 'birthday', 'other')),
  constraint reminders_status_check check (status in ('pending', 'sent', 'cancelled'))
);

create index if not exists idx_reminders_tenant_store on public.reminders (tenant_id, store_id, scheduled_at);
create index if not exists idx_reminders_pending on public.reminders (tenant_id, status, scheduled_at) where status = 'pending';
create index if not exists idx_reminders_customer on public.reminders (customer_id) where customer_id is not null;

-- ===== MXQ-12005 发送适配器 =====
create table if not exists public.message_deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  reminder_id uuid references public.reminders(id) on delete set null,
  template_id uuid references public.message_templates(id) on delete set null,
  channel text not null,                                -- sms / email / wechat / work_wechat
  recipient text not null,                              -- 手机号 / 邮箱 / openid
  content_snapshot text not null,                       -- 发送时内容快照(防止模板后续修改)
  provider_message_id text,                             -- 供应商返回的消息 id
  status text not null default 'queued',                -- queued / sent / failed / retry
  error text,
  attempts integer not null default 0,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  constraint deliveries_channel_check check (channel in ('sms', 'email', 'wechat', 'work_wechat')),
  constraint deliveries_status_check check (status in ('queued', 'sent', 'failed', 'retry'))
);

-- 幂等:同一 reminder_id + template_id 不重复发送(reminder_id 为空时跳过)
create unique index if not exists idx_message_deliveries_reminder_template
  on public.message_deliveries (reminder_id, template_id)
  where reminder_id is not null and template_id is not null;

create index if not exists idx_message_deliveries_tenant_status on public.message_deliveries (tenant_id, status, created_at);

-- ===== MXQ-12006 导入任务 =====
create table if not exists public.import_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  store_id uuid references public.stores(id) on delete set null,
  type text not null,                                   -- customer / pet / product / inventory
  file_id uuid,                                         -- 不加 FK,跨模块解耦
  status text not null default 'pending',               -- pending / processing / completed / failed
  total_rows integer not null default 0,
  success_count integer not null default 0,
  failed_count integer not null default 0,
  error_summary jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint import_tasks_type_check check (type in ('customer', 'pet', 'product', 'inventory')),
  constraint import_tasks_status_check check (status in ('pending', 'processing', 'completed', 'failed'))
);

create index if not exists idx_import_tasks_tenant_status on public.import_tasks (tenant_id, status, created_at desc);
create index if not exists idx_import_tasks_tenant_type on public.import_tasks (tenant_id, type);

drop trigger if exists trg_import_tasks_updated_at on public.import_tasks;
create trigger trg_import_tasks_updated_at
  before update on public.import_tasks
  for each row execute procedure public.touch_updated_at();

-- ===== MXQ-12007 打印模板/任务 =====
create table if not exists public.print_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  name text not null,
  type text not null,                                   -- invoice / prescription / medical_record / label / other
  template text not null,                               -- html / liquid 模板内容
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint print_templates_type_check check (type in ('invoice', 'prescription', 'medical_record', 'label', 'other'))
);

create unique index if not exists idx_print_templates_tenant_code on public.print_templates (tenant_id, code);
create index if not exists idx_print_templates_tenant_active on public.print_templates (tenant_id, is_active);

create table if not exists public.print_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  store_id uuid references public.stores(id) on delete set null,
  template_id uuid references public.print_templates(id) on delete set null,
  entity_type text not null,                            -- invoice / prescription / medical_record / ...
  entity_id uuid not null,
  status text not null default 'queued',                -- queued / printed / failed
  operator_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint print_jobs_status_check check (status in ('queued', 'printed', 'failed'))
);

create index if not exists idx_print_jobs_tenant_status on public.print_jobs (tenant_id, status, created_at desc);
create index if not exists idx_print_jobs_entity on public.print_jobs (entity_type, entity_id);

-- ===== MXQ-12008 报表 =====
create table if not exists public.report_definitions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  name text not null,
  category text not null,                               -- revenue / inventory / customer / medical
  query_config jsonb not null default '{}'::jsonb,      -- 查询参数 schema
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint report_definitions_category_check check (category in ('revenue', 'inventory', 'customer', 'medical'))
);

create unique index if not exists idx_report_definitions_tenant_code on public.report_definitions (tenant_id, code);
create index if not exists idx_report_definitions_tenant_active on public.report_definitions (tenant_id, is_active);

create table if not exists public.report_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  report_id uuid not null references public.report_definitions(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  data jsonb not null default '{}'::jsonb,
  generated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_report_snapshots_report_period on public.report_snapshots (report_id, period_start, period_end);
create index if not exists idx_report_snapshots_tenant on public.report_snapshots (tenant_id, created_at desc);

-- ===== MXQ-12009 安全事件(不可变,仅 service_role 写入) =====
create table if not exists public.security_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  event_type text not null,                             -- login_failed / permission_denied / suspicious / data_export
  severity text not null default 'info',                -- info / warning / critical
  description text,
  ip text,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint security_events_type_check check (event_type in ('login_failed', 'permission_denied', 'suspicious', 'data_export')),
  constraint security_events_severity_check check (severity in ('info', 'warning', 'critical'))
);

create index if not exists idx_security_events_tenant_time on public.security_events (tenant_id, created_at desc);
create index if not exists idx_security_events_type on public.security_events (event_type, severity);
create index if not exists idx_security_events_user on public.security_events (user_id) where user_id is not null;

-- ============================================================
-- RLS 策略
-- ============================================================

-- 启用 RLS
alter table public.membership_tiers enable row level security;
alter table public.customer_memberships enable row level security;
alter table public.point_transactions enable row level security;
alter table public.message_templates enable row level security;
alter table public.reminders enable row level security;
alter table public.message_deliveries enable row level security;
alter table public.import_tasks enable row level security;
alter table public.print_templates enable row level security;
alter table public.print_jobs enable row level security;
alter table public.report_definitions enable row level security;
alter table public.report_snapshots enable row level security;
alter table public.security_events enable row level security;

-- ===== MXQ-12001 membership_tiers =====
-- 读:租户成员可读;写:membership.manage 权限
drop policy if exists "membership_tiers_select" on public.membership_tiers;
create policy "membership_tiers_select" on public.membership_tiers
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

drop policy if exists "membership_tiers_insert" on public.membership_tiers;
create policy "membership_tiers_insert" on public.membership_tiers
  for insert to authenticated
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'membership.manage'));

drop policy if exists "membership_tiers_update" on public.membership_tiers;
create policy "membership_tiers_update" on public.membership_tiers
  for update to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'membership.manage'))
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'membership.manage'));

drop policy if exists "membership_tiers_delete" on public.membership_tiers;
create policy "membership_tiers_delete" on public.membership_tiers
  for delete to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'membership.manage'));

-- ===== MXQ-12001 customer_memberships =====
drop policy if exists "customer_memberships_select" on public.customer_memberships;
create policy "customer_memberships_select" on public.customer_memberships
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

drop policy if exists "customer_memberships_insert" on public.customer_memberships;
create policy "customer_memberships_insert" on public.customer_memberships
  for insert to authenticated
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'membership.manage'));

drop policy if exists "customer_memberships_update" on public.customer_memberships;
create policy "customer_memberships_update" on public.customer_memberships
  for update to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'membership.manage'))
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'membership.manage'));

drop policy if exists "customer_memberships_delete" on public.customer_memberships;
create policy "customer_memberships_delete" on public.customer_memberships
  for delete to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'membership.manage'));

-- ===== MXQ-12002 point_transactions(不可变:仅 insert,拒绝 update/delete) =====
-- 注:customer_memberships.points_balance 由 adjust_points RPC 维护,前端不可直连 update
drop policy if exists "point_transactions_select" on public.point_transactions;
create policy "point_transactions_select" on public.point_transactions
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

drop policy if exists "point_transactions_insert" on public.point_transactions;
create policy "point_transactions_insert" on public.point_transactions
  for insert to authenticated
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'points.adjust'));

-- 显式拒绝 update / delete(不创建策略即默认拒绝,这里加注释说明意图)
-- point_transactions: NO update policy, NO delete policy → 默认拒绝 authenticated

-- ===== MXQ-12003 message_templates =====
drop policy if exists "message_templates_select" on public.message_templates;
create policy "message_templates_select" on public.message_templates
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

drop policy if exists "message_templates_insert" on public.message_templates;
create policy "message_templates_insert" on public.message_templates
  for insert to authenticated
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'message.manage'));

drop policy if exists "message_templates_update" on public.message_templates;
create policy "message_templates_update" on public.message_templates
  for update to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'message.manage'))
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'message.manage'));

drop policy if exists "message_templates_delete" on public.message_templates;
create policy "message_templates_delete" on public.message_templates
  for delete to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'message.manage'));

-- ===== MXQ-12004 reminders =====
drop policy if exists "reminders_select" on public.reminders;
create policy "reminders_select" on public.reminders
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and (store_id is null or public.can_access_store(tenant_id, store_id))
  );

drop policy if exists "reminders_insert" on public.reminders;
create policy "reminders_insert" on public.reminders
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'reminder.manage')
  );

drop policy if exists "reminders_update" on public.reminders;
create policy "reminders_update" on public.reminders
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'reminder.manage')
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'reminder.manage')
  );

drop policy if exists "reminders_delete" on public.reminders;
create policy "reminders_delete" on public.reminders
  for delete to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'reminder.manage')
  );

-- ===== MXQ-12005 message_deliveries =====
drop policy if exists "message_deliveries_select" on public.message_deliveries;
create policy "message_deliveries_select" on public.message_deliveries
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

drop policy if exists "message_deliveries_insert" on public.message_deliveries;
create policy "message_deliveries_insert" on public.message_deliveries
  for insert to authenticated
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'message.manage'));

drop policy if exists "message_deliveries_update" on public.message_deliveries;
create policy "message_deliveries_update" on public.message_deliveries
  for update to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'message.manage'))
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'message.manage'));

drop policy if exists "message_deliveries_delete" on public.message_deliveries;
create policy "message_deliveries_delete" on public.message_deliveries
  for delete to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'message.manage'));

-- ===== MXQ-12006 import_tasks =====
drop policy if exists "import_tasks_select" on public.import_tasks;
create policy "import_tasks_select" on public.import_tasks
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and (store_id is null or public.can_access_store(tenant_id, store_id))
  );

drop policy if exists "import_tasks_insert" on public.import_tasks;
create policy "import_tasks_insert" on public.import_tasks
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'imports.manage')
  );

drop policy if exists "import_tasks_update" on public.import_tasks;
create policy "import_tasks_update" on public.import_tasks
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'imports.manage')
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'imports.manage')
  );

drop policy if exists "import_tasks_delete" on public.import_tasks;
create policy "import_tasks_delete" on public.import_tasks
  for delete to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'imports.manage')
  );

-- ===== MXQ-12007 print_templates =====
drop policy if exists "print_templates_select" on public.print_templates;
create policy "print_templates_select" on public.print_templates
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

drop policy if exists "print_templates_insert" on public.print_templates;
create policy "print_templates_insert" on public.print_templates
  for insert to authenticated
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'print.manage'));

drop policy if exists "print_templates_update" on public.print_templates;
create policy "print_templates_update" on public.print_templates
  for update to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'print.manage'))
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'print.manage'));

drop policy if exists "print_templates_delete" on public.print_templates;
create policy "print_templates_delete" on public.print_templates
  for delete to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'print.manage'));

-- ===== MXQ-12007 print_jobs =====
drop policy if exists "print_jobs_select" on public.print_jobs;
create policy "print_jobs_select" on public.print_jobs
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and (store_id is null or public.can_access_store(tenant_id, store_id))
  );

drop policy if exists "print_jobs_insert" on public.print_jobs;
create policy "print_jobs_insert" on public.print_jobs
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'print.manage')
  );

drop policy if exists "print_jobs_update" on public.print_jobs;
create policy "print_jobs_update" on public.print_jobs
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'print.manage')
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'print.manage')
  );

drop policy if exists "print_jobs_delete" on public.print_jobs;
create policy "print_jobs_delete" on public.print_jobs
  for delete to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'print.manage')
  );

-- ===== MXQ-12008 report_definitions =====
drop policy if exists "report_definitions_select" on public.report_definitions;
create policy "report_definitions_select" on public.report_definitions
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

drop policy if exists "report_definitions_insert" on public.report_definitions;
create policy "report_definitions_insert" on public.report_definitions
  for insert to authenticated
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'reports.view'));

drop policy if exists "report_definitions_update" on public.report_definitions;
create policy "report_definitions_update" on public.report_definitions
  for update to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'reports.view'))
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'reports.view'));

drop policy if exists "report_definitions_delete" on public.report_definitions;
create policy "report_definitions_delete" on public.report_definitions
  for delete to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'reports.view'));

-- ===== MXQ-12008 report_snapshots =====
drop policy if exists "report_snapshots_select" on public.report_snapshots;
create policy "report_snapshots_select" on public.report_snapshots
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

drop policy if exists "report_snapshots_insert" on public.report_snapshots;
create policy "report_snapshots_insert" on public.report_snapshots
  for insert to authenticated
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'reports.view'));

drop policy if exists "report_snapshots_delete" on public.report_snapshots;
create policy "report_snapshots_delete" on public.report_snapshots
  for delete to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'reports.view'));

-- ===== MXQ-12009 security_events(不可变 + 仅超管可读) =====
-- 不创建 insert/update/delete 策略 → 默认拒绝 authenticated;仅 service_role 可写
drop policy if exists "security_events_select" on public.security_events;
create policy "security_events_select" on public.security_events
  for select to authenticated
  using (public.is_system_admin());

-- ============================================================
-- 新增权限码(MXQ-12001~12009)
-- ============================================================
insert into public.permissions (code, name, module) values
  ('membership.view', '查看会员等级', 'membership'),
  ('membership.manage', '管理会员等级', 'membership'),
  ('points.adjust', '调整积分', 'points'),
  ('message.manage', '管理消息模板', 'message'),
  ('reminder.manage', '管理提醒', 'reminder'),
  ('imports.manage', '管理导入任务', 'imports'),
  ('print.manage', '管理打印', 'print'),
  ('reports.view', '查看报表', 'reports'),
  ('security.view', '查看安全事件', 'security')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- system_admin 补全部权限(幂等)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'system_admin'
  and p.code in (
    'membership.view', 'membership.manage', 'points.adjust',
    'message.manage', 'reminder.manage', 'imports.manage',
    'print.manage', 'reports.view', 'security.view'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- store_manager 补业务权限(不含 security.view,仅超管可读安全事件)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code in (
    'membership.view', 'membership.manage', 'points.adjust',
    'message.manage', 'reminder.manage', 'imports.manage',
    'print.manage', 'reports.view'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容旧代码读取)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'membership.view', 'membership.manage', 'points.adjust',
    'message.manage', 'reminder.manage', 'imports.manage',
    'print.manage', 'reports.view', 'security.view'
  ])
)
where code = 'system_admin' and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'membership.view', 'membership.manage', 'points.adjust',
    'message.manage', 'reminder.manage', 'imports.manage',
    'print.manage', 'reports.view'
  ])
)
where code = 'store_manager' and is_system = true;

-- ============================================================
-- MXQ-12002 adjust_points RPC
-- 事务化增减积分 + 写流水 + 幂等控制
--   - p_delta > 0 增加,< 0 消耗
--   - p_idempotency_key 非空时,同租户+key 命中直接返回已有结果
--   - 自动创建 customer_memberships(若不存在)
--   - balance_after 写入流水快照
--   - 消耗时余额不可为负 → 抛 INSUFFICIENT_POINTS
-- ============================================================
create or replace function public.adjust_points(
  p_tenant_id uuid,
  p_customer_id uuid,
  p_delta integer,
  p_reason text,
  p_reference_id uuid default null,
  p_reference_type text default null,
  p_operator_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_membership public.customer_memberships;
  v_balance_after integer;
  v_txn public.point_transactions;
  v_idem record;
  v_idem_action text := 'adjust_points';
begin
  -- 参数校验
  if p_delta = 0 then
    raise exception 'INVALID_DELTA' using errcode = 'P0003';
  end if;
  if p_reason not in ('purchase', 'redeem', 'adjust', 'expiry') then
    raise exception 'INVALID_REASON' using errcode = 'P0003';
  end if;

  -- 幂等检查
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select * into v_idem
    from public.idempotency_records
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key
    limit 1;
    if found then
      return v_idem.result_json;
    end if;
  end if;

  -- 取/建会员关系(行锁)
  select * into v_membership
  from public.customer_memberships
  where tenant_id = p_tenant_id and customer_id = p_customer_id
  for update;

  if not found then
    insert into public.customer_memberships (tenant_id, customer_id, points_balance)
    values (p_tenant_id, p_customer_id, 0)
    on conflict (tenant_id, customer_id) do nothing
    returning * into v_membership;

    if not found then
      select * into v_membership
      from public.customer_memberships
      where tenant_id = p_tenant_id and customer_id = p_customer_id
      for update;
    end if;
  end if;

  -- 余额校验(消耗时不可为负)
  if p_delta < 0 and (v_membership.points_balance + p_delta) < 0 then
    raise exception 'INSUFFICIENT_POINTS' using errcode = 'P0003';
  end if;

  -- 更新余额
  v_balance_after := v_membership.points_balance + p_delta;
  update public.customer_memberships
  set points_balance = v_balance_after
  where id = v_membership.id;

  -- 写流水
  insert into public.point_transactions (
    tenant_id, customer_id, delta, reason,
    reference_type, reference_id,
    balance_after, operator_id
  )
  values (
    p_tenant_id, p_customer_id, p_delta, p_reason,
    p_reference_type, p_reference_id,
    v_balance_after, p_operator_id
  )
  returning * into v_txn;

  -- 写幂等记录
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (
      p_tenant_id, p_idempotency_key, v_idem_action,
      'point_transaction', v_txn.id,
      jsonb_build_object(
        'transaction_id', v_txn.id,
        'customer_id', p_customer_id,
        'balance_after', v_balance_after,
        'delta', p_delta
      )
    )
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'transaction_id', v_txn.id,
    'customer_id', p_customer_id,
    'balance_after', v_balance_after,
    'delta', p_delta
  );
end;
$$;

revoke all on function public.adjust_points(uuid, uuid, integer, text, uuid, text, uuid, text) from public;
grant execute on function public.adjust_points(uuid, uuid, integer, text, uuid, text, uuid, text) to authenticated;

-- ============================================================
-- MXQ-12004 scan_reminders RPC
-- 扫描到期提醒,生成发送任务(写入 message_deliveries)
--   - 仅扫描 pending 且 scheduled_at <= now 的提醒
--   - 每条提醒生成一条 delivery(若已存在则跳过,幂等)
--   - 返回本次生成的 delivery 数量
--   - 实际业务规则(模板选择、收件人解析)后续补充,此处为框架
-- ============================================================
create or replace function public.scan_reminders(
  p_tenant_id uuid,
  p_store_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_now timestamptz := now();
begin
  -- 选取到期待发送提醒
  insert into public.message_deliveries (
    tenant_id, reminder_id, template_id, channel, recipient, content_snapshot, status
  )
  select
    r.tenant_id,
    r.id,
    null,                                   -- template_id 暂空,后续由发送流程匹配
    'sms',                                  -- 默认 sms,后续按客户偏好覆盖
    '',                                     -- recipient 暂空,后续由发送流程解析
    COALESCE(r.payload::text, '{}'),
    'queued'
  from public.reminders r
  where r.tenant_id = p_tenant_id
    and (p_store_id is null or r.store_id = p_store_id)
    and r.status = 'pending'
    and r.scheduled_at <= v_now
    and not exists (
      select 1 from public.message_deliveries md
      where md.reminder_id = r.id
    )
  on conflict do nothing;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- 写入 jobs 队列(异步处理发送任务)
  insert into public.jobs (tenant_id, store_id, queue, payload, status)
  values (
    p_tenant_id, p_store_id, 'reminders',
    jsonb_build_object('scanned_at', v_now, 'created_count', v_count),
    'queued'
  );

  return jsonb_build_object(
    'scanned_count', v_count,
    'scanned_at', v_now
  );
end;
$$;

revoke all on function public.scan_reminders(uuid, uuid) from public;
grant execute on function public.scan_reminders(uuid, uuid) to authenticated;

-- ============================================================
-- MXQ-12005 send_delivery RPC(发送适配器框架)
-- 模拟发送:标记 sent + 写 provider_message_id
--   - 状态机:queued → sent / queued → failed / queued → retry → sent
--   - 实际供应商集成后续补充
-- ============================================================
create or replace function public.send_delivery(
  p_delivery_id uuid,
  p_provider_message_id text default null
)
returns public.message_deliveries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.message_deliveries;
begin
  select * into v_row from public.message_deliveries where id = p_delivery_id for update;
  if not found then
    raise exception 'DELIVERY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.status = 'sent' then
    raise exception 'DELIVERY_ALREADY_SENT' using errcode = 'P0003';
  end if;

  -- 模拟发送成功(实际集成时替换为供应商调用)
  update public.message_deliveries
  set status = 'sent',
      sent_at = now(),
      provider_message_id = coalesce(p_provider_message_id, 'mock-' || p_delivery_id::text),
      attempts = v_row.attempts + 1
  where id = p_delivery_id
  returning * into v_row;

  -- 同步更新 reminder 状态(若关联)
  if v_row.reminder_id is not null then
    update public.reminders
    set status = 'sent', sent_at = now()
    where id = v_row.reminder_id and status = 'pending';
  end if;

  return v_row;
end;
$$;

revoke all on function public.send_delivery(uuid, text) from public;
grant execute on function public.send_delivery(uuid, text) to authenticated;

-- ============================================================
-- MXQ-12006 create_import_task RPC
-- 事务化创建导入任务 + 入队 jobs
-- ============================================================
create or replace function public.create_import_task(
  p_tenant_id uuid,
  p_type text,
  p_store_id uuid default null,
  p_file_id uuid default null,
  p_created_by uuid default null
)
returns public.import_tasks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.import_tasks;
begin
  if p_type not in ('customer', 'pet', 'product', 'inventory') then
    raise exception 'INVALID_IMPORT_TYPE' using errcode = 'P0003';
  end if;

  insert into public.import_tasks (
    tenant_id, store_id, type, file_id, status, created_by
  )
  values (
    p_tenant_id, p_store_id, p_type, p_file_id, 'pending', p_created_by
  )
  returning * into v_row;

  -- 入队异步处理
  insert into public.jobs (tenant_id, store_id, queue, payload, status)
  values (
    p_tenant_id, p_store_id, 'imports',
    jsonb_build_object('task_id', v_row.id, 'type', p_type, 'file_id', p_file_id),
    'queued'
  );

  return v_row;
end;
$$;

revoke all on function public.create_import_task(uuid, text, uuid, uuid, uuid) from public;
grant execute on function public.create_import_task(uuid, text, uuid, uuid, uuid) to authenticated;

-- ============================================================
-- MXQ-12007 create_print_job RPC
-- 事务化创建打印任务
-- ============================================================
create or replace function public.create_print_job(
  p_tenant_id uuid,
  p_template_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_store_id uuid default null,
  p_operator_id uuid default null
)
returns public.print_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.print_jobs;
begin
  insert into public.print_jobs (
    tenant_id, store_id, template_id, entity_type, entity_id, status, operator_id
  )
  values (
    p_tenant_id, p_store_id, p_template_id, p_entity_type, p_entity_id, 'queued', p_operator_id
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.create_print_job(uuid, uuid, text, uuid, uuid, uuid) from public;
grant execute on function public.create_print_job(uuid, uuid, text, uuid, uuid, uuid) to authenticated;

-- ============================================================
-- MXQ-12008 generate_report_snapshot RPC
-- 框架实现:读取 report_definitions,生成空快照(实际查询逻辑后续补)
-- ============================================================
create or replace function public.generate_report_snapshot(
  p_tenant_id uuid,
  p_report_code text,
  p_period_start date,
  p_period_end date,
  p_generated_by uuid default null
)
returns public.report_snapshots
language plpgsql
security definer
set search_path = public
as $$
declare
  v_def public.report_definitions;
  v_row public.report_snapshots;
begin
  select * into v_def
  from public.report_definitions
  where tenant_id = p_tenant_id and code = p_report_code and is_active = true
  for update;

  if not found then
    raise exception 'REPORT_DEFINITION_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_period_start > p_period_end then
    raise exception 'INVALID_PERIOD' using errcode = 'P0003';
  end if;

  -- 框架实现:实际查询逻辑由后续阶段补充,当前仅落空数据快照
  insert into public.report_snapshots (
    tenant_id, report_id, period_start, period_end, data, generated_by
  )
  values (
    p_tenant_id, v_def.id, p_period_start, p_period_end,
    jsonb_build_object('status', 'placeholder', 'query_config', v_def.query_config),
    p_generated_by
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.generate_report_snapshot(uuid, text, date, date, uuid) from public;
grant execute on function public.generate_report_snapshot(uuid, text, date, date, uuid) to authenticated;
