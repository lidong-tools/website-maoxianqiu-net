-- ============================================================
-- S32-A: Import Center V2 数据模型
-- 20260810000100
-- ============================================================
-- 背景:
--   将"上传即建任务"的 Import Center 升级为真实迁移工具(5 类数据:
--   客户/宠物/商品/员工/库存期初)。本批优先复用既有 import_jobs 表,
--   仅按需扩展列与约束;新增 import_job_errors(错误明细)与两张
--   "命令队列"表(opening_stock_import_requests / employee_invite_imports),
--   用于把跨域动作(库存期初/员工邀请)固化为待处理命令,交由
--   S32-E Integrator 接入既有 Inventory/IAM Command,本 Agent 不直接
--   修改库存余额、不绕过 IAM 邀请。
--
-- 迁移编号锁:S3.2 Agent A 使用 100~103;不得占用 92~99(S3.1 Fix)。
-- 幂等性:全部使用 if not exists / drop constraint if exists。
-- ============================================================

set search_path = public;

-- ===== 1. 扩展 import_jobs(既有表) =====

-- 1a. 扩展 type 约束:新增 catalog-item / employee / opening-stock
alter table public.import_jobs drop constraint if exists import_jobs_type_check;
alter table public.import_jobs
  add constraint import_jobs_type_check check (
    type in ('customer', 'pet', 'catalog-item', 'employee', 'opening-stock')
  );

-- 1b. 扩展 status 约束:新增 uploaded / mapped / validated / queued / cancelled
--     (保留 pending 以兼容既有 create_import_job RPC)
alter table public.import_jobs drop constraint if exists import_jobs_status_check;
alter table public.import_jobs
  add constraint import_jobs_status_check check (
    status in ('uploaded', 'mapped', 'validated', 'queued', 'pending', 'processing', 'completed', 'failed', 'cancelled')
  );

-- 1c. 新增 V2 所需列
alter table public.import_jobs add column if not exists mapping jsonb;
alter table public.import_jobs add column if not exists duplicate_strategy text;
alter table public.import_jobs add column if not exists valid_rows integer not null default 0;
alter table public.import_jobs add column if not exists invalid_rows integer not null default 0;
alter table public.import_jobs add column if not exists started_at timestamptz;
alter table public.import_jobs add column if not exists finished_at timestamptz;
alter table public.import_jobs add column if not exists error_summary jsonb not null default '{}'::jsonb;

-- ===== 2. import_job_errors(错误明细) =====
create table if not exists public.import_job_errors (
  id uuid primary key default gen_random_uuid(),
  import_job_id uuid not null references public.import_jobs(id) on delete cascade,
  row_number integer not null,
  field text,
  code text,
  message text not null,
  raw_data jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_import_job_errors_job on public.import_job_errors (import_job_id);
create index if not exists idx_import_job_errors_job_row on public.import_job_errors (import_job_id, row_number);

alter table public.import_job_errors enable row level security;

-- 读:租户成员可读本租户任务的错误明细(与 import_jobs 同构)
drop policy if exists "import_job_errors_select" on public.import_job_errors;
create policy "import_job_errors_select" on public.import_job_errors
  for select to authenticated
  using (
    exists (
      select 1 from public.import_jobs j
      where j.id = import_job_id
        and public.is_tenant_member(j.tenant_id)
        and (j.store_id is null or public.can_access_store(j.tenant_id, j.store_id))
    )
  );

-- 写:仅 service role(Hono Command 直写,绕过 RLS)。不开放 insert/update/delete 策略。

-- ===== 3. opening_stock_import_requests(库存期初命令队列) =====
-- 边界:本 Agent 不直接 update inventory_balances / inventory_batches。
-- 校验通过后把"期初入账命令"写入此表(status=pending),由 S32-E Integrator
-- 对接既有 Inventory Command(见 S32-A-HANDOFF)。
create table if not exists public.opening_stock_import_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  store_id uuid references public.stores(id) on delete set null,
  import_job_id uuid references public.import_jobs(id) on delete set null,
  row_number integer not null,

  catalog_code text,                                 -- 模板中的商品编码(解析用)
  catalog_item_id uuid,                              -- 解析后落库的商品 id
  warehouse_code text,                               -- 模板中的仓库编码
  warehouse_id uuid,                                 -- 解析后落库的仓库 id
  batch_no text,
  quantity numeric(12,3) not null default 0,
  unit_cost numeric(12,2) not null default 0,
  expiry_date date,

  status text not null default 'pending',            -- pending / applied / skipped / failed
  error_message text,
  created_at timestamptz not null default now(),

  constraint opening_stock_import_requests_status_check
    check (status in ('pending', 'applied', 'skipped', 'failed'))
);

create index if not exists idx_opening_stock_req_job on public.opening_stock_import_requests (import_job_id);
create index if not exists idx_opening_stock_req_tenant on public.opening_stock_import_requests (tenant_id);
create index if not exists idx_opening_stock_req_status on public.opening_stock_import_requests (status);

alter table public.opening_stock_import_requests enable row level security;
-- 读/写:仅 service role。Integrator 经 service role 消费命令队列。

-- ===== 4. employee_invite_imports(员工待邀请队列) =====
-- 边界:本 Agent 不直接创建 auth 用户 / 发送邀请。校验通过后把"待邀请"记录
-- 写入此表(status=pending),由 S32-E Integrator 对接既有 IAM 邀请 API
-- (见 S32-A-HANDOFF)。
create table if not exists public.employee_invite_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  store_id uuid references public.stores(id) on delete set null,
  import_job_id uuid references public.import_jobs(id) on delete set null,
  row_number integer not null,

  email text not null,
  name text not null,
  phone text,
  employee_no text,
  title text,
  role_code text,                                    -- 角色码,如 staff / veterinarian(由 IAM 侧解析)
  store_codes text[] not null default '{}',          -- 门店编码数组

  status text not null default 'pending',            -- pending / sent / failed / duplicate
  error_message text,
  created_at timestamptz not null default now(),

  constraint employee_invite_imports_status_check
    check (status in ('pending', 'sent', 'failed', 'duplicate'))
);

create index if not exists idx_employee_invite_job on public.employee_invite_imports (import_job_id);
create index if not exists idx_employee_invite_tenant on public.employee_invite_imports (tenant_id);
create index if not exists idx_employee_invite_email on public.employee_invite_imports (tenant_id, email);
create index if not exists idx_employee_invite_status on public.employee_invite_imports (status);

alter table public.employee_invite_imports enable row level security;
-- 读/写:仅 service role。Integrator 经 service role 消费待邀请队列。

-- ============================================================
-- ACL 收口(S30-F02 约定):新表无 policy 即默认拒绝;
-- 未新增 RPC,故无需 revoke/grant 函数。
-- ============================================================
