-- ============================================================
-- 20260810000059_imaging_orders.sql
-- Agent-03 影像工作流基础表(PRD §12.3)
--   申请 → 预约 → 执行 → 附件 → 报告 → 审核 → 发布
--   不做 DICOM/PACS,仅工作流 + 文件 + 报告
-- 幂等,可重复应用
-- ============================================================

-- ===== 1. imaging_orders 影像申请单 =====
create table if not exists public.imaging_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,

  order_no text not null unique,
  encounter_id uuid references public.encounters(id) on delete set null,
  customer_id uuid not null references public.customers(id) on delete restrict,
  pet_id uuid not null references public.pets(id) on delete restrict,
  requested_by uuid references auth.users(id) on delete set null,

  imaging_type text not null check (imaging_type in ('ultrasound', 'xray', 'cr', 'ct', 'mri', 'other')),
  catalog_item_id uuid references public.catalog_items(id) on delete set null,

  scheduled_at timestamptz,
  performed_at timestamptz,
  performed_by uuid references auth.users(id) on delete set null,

  status text not null default 'requested' check (
    status in ('requested', 'scheduled', 'in_progress', 'performed', 'reported', 'reviewed', 'published', 'cancelled')
  ),
  clinical_question text,
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_imaging_orders_tenant on public.imaging_orders (tenant_id);
create index if not exists idx_imaging_orders_store on public.imaging_orders (store_id);
create index if not exists idx_imaging_orders_encounter on public.imaging_orders (encounter_id);
create index if not exists idx_imaging_orders_pet on public.imaging_orders (pet_id);
create index if not exists idx_imaging_orders_status on public.imaging_orders (tenant_id, store_id, status);

-- ===== 2. imaging_reports 影像报告(版本化) =====
-- 已发布报告不可静默覆盖:修订走新版本行
create table if not exists public.imaging_reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,
  imaging_order_id uuid not null references public.imaging_orders(id) on delete cascade,

  version integer not null default 1,
  findings text,
  impression text,
  recommendation text,

  author_id uuid references auth.users(id) on delete set null,
  reviewer_id uuid references auth.users(id) on delete set null,

  status text not null default 'draft' check (status in ('draft', 'submitted', 'reviewed', 'published')),
  published_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint imaging_reports_order_version_unique unique (imaging_order_id, version)
);

create index if not exists idx_imaging_reports_tenant on public.imaging_reports (tenant_id);
create index if not exists idx_imaging_reports_order on public.imaging_reports (imaging_order_id);
create index if not exists idx_imaging_reports_status on public.imaging_reports (imaging_order_id, status);

-- ===== 3. RLS =====
alter table public.imaging_orders enable row level security;
alter table public.imaging_reports enable row level security;

-- imaging_orders 读:租户成员且门店可见
drop policy if exists "imaging_orders_select" on public.imaging_orders;
create policy "imaging_orders_select" on public.imaging_orders
  for select to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
    )
  );

-- imaging_orders 写:走 Hono Command(service role)为主;直连需 imaging.* 权限
drop policy if exists "imaging_orders_insert" on public.imaging_orders;
create policy "imaging_orders_insert" on public.imaging_orders
  for insert to authenticated
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and public.has_permission(tenant_id, store_id, 'imaging.order')
    )
  );

drop policy if exists "imaging_orders_update" on public.imaging_orders;
create policy "imaging_orders_update" on public.imaging_orders
  for update to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and (
        public.has_permission(tenant_id, store_id, 'imaging.perform')
        or public.has_permission(tenant_id, store_id, 'imaging.report')
      )
    )
  )
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and (
        public.has_permission(tenant_id, store_id, 'imaging.perform')
        or public.has_permission(tenant_id, store_id, 'imaging.report')
      )
    )
  );

-- imaging_reports 读:跟随 imaging_order 可见性
drop policy if exists "imaging_reports_select" on public.imaging_reports;
create policy "imaging_reports_select" on public.imaging_reports
  for select to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
    )
  );

drop policy if exists "imaging_reports_insert" on public.imaging_reports;
create policy "imaging_reports_insert" on public.imaging_reports
  for insert to authenticated
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'imaging.report')
    )
  );

drop policy if exists "imaging_reports_update" on public.imaging_reports;
create policy "imaging_reports_update" on public.imaging_reports
  for update to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'imaging.report')
    )
  )
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'imaging.report')
    )
  );
