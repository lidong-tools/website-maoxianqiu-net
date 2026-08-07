-- ============================================================
-- 20260809000035_tenant_init_schema.sql
-- S3.1 并发任务 A:租户初始化数据底座(migration 35,独占 35~38)
--
-- 新建 4 张表(全部幂等,可重复应用):
--   1. tenant_initializations  初始化状态机(pending/running/completed/failed)
--   2. payment_contexts        支付上下文(cash/card/wechat/alipay/other)
--   3. print_settings          打印设置(58mm/80mm/a4)
--   4. base_dictionaries       基础字典(Pilot 必需字典项)
--
-- 设计要点:
--   * 状态机约束 + 部分唯一索引 idx_tenant_init_single_active:
--     同一 tenant 同时仅允许一条 pending/running(active)初始化记录;
--   * 初始化记录为租户级数据(不绑定 store),store 是初始化产出;
--   * 写操作全部走 service-role-only RPC(initialize_tenant),本 migration 仅建表;
--   * RLS 策略与权限码 seed 在 migration 37 统一处理;
--   * updated_at 触发器复用 migration 15 已定义的 public.touch_updated_at()。
-- ============================================================

-- ============================================================
-- 1. tenant_initializations 初始化状态机
-- ============================================================
create table if not exists public.tenant_initializations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  -- 初始化产出(完成时回填)
  store_id uuid references public.stores(id) on delete set null,
  store_name text,
  store_code text,
  owner_user_id uuid references auth.users(id) on delete set null,
  owner_name text,
  owner_phone text,
  -- 幂等键:同一租户同一请求不重复初始化(与 idempotency_records 双重兜底)
  idempotency_key text not null,
  -- 失败重试
  attempts integer not null default 0,
  last_error text,
  failed_reason text,
  -- 时间线
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 同租户幂等键唯一
  constraint tenant_initializations_idem_unique unique (tenant_id, idempotency_key)
);

comment on table public.tenant_initializations is '租户初始化状态机:S3.1-A 新建医院后一键可营业的初始化闭环记录';
comment on column public.tenant_initializations.status is 'pending=等待执行 / running=执行中 / completed=已完成 / failed=失败(可重试)';
comment on column public.tenant_initializations.idempotency_key is '幂等键:客户端生成,同一租户重复请求返回首次结果,不重复创建资源';

-- 同一 tenant 同时仅一条 active(pending/running)初始化(部分唯一索引)
create unique index if not exists idx_tenant_init_single_active
  on public.tenant_initializations (tenant_id)
  where status in ('pending', 'running');

-- 租户最新初始化查询索引
create index if not exists idx_tenant_init_tenant_latest
  on public.tenant_initializations (tenant_id, created_at desc);

-- ============================================================
-- 2. payment_contexts 支付上下文
--    默认 5 种:cash / card / wechat / alipay / other
-- ============================================================
create table if not exists public.payment_contexts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  method text not null check (method in ('cash', 'card', 'wechat', 'alipay', 'other')),
  label text not null,
  is_default boolean not null default false,
  is_active boolean not null default true,
  config jsonb not null default '{}'::jsonb,           -- 扩展配置(如收款账号等,预留)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_contexts_method_label_unique unique (tenant_id, store_id, method)
);

comment on table public.payment_contexts is '支付上下文:门店可用的收款方式(cash/card/wechat/alipay/other)';
comment on column public.payment_contexts.is_default is '门店默认收款方式;每个门店仅一个 default(部分唯一索引兜底)';

-- 每个门店仅一个默认支付方式
create unique index if not exists idx_payment_contexts_default_per_store
  on public.payment_contexts (tenant_id, store_id)
  where is_default = true and is_active = true;

-- 默认收银上下文常用查询
create index if not exists idx_payment_contexts_store
  on public.payment_contexts (tenant_id, store_id, is_active);

-- ============================================================
-- 3. print_settings 打印设置
--    默认 3 种:58mm / 80mm / a4
-- ============================================================
create table if not exists public.print_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  paper_size text not null check (paper_size in ('58mm', '80mm', 'a4')),
  label text not null,
  is_default boolean not null default false,
  is_active boolean not null default true,
  config jsonb not null default '{}'::jsonb,           -- 扩展配置(份数/边距/水印等,预留)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint print_settings_paper_unique unique (tenant_id, store_id, paper_size)
);

comment on table public.print_settings is '打印设置:门店默认纸张规格(58mm 热敏小票 / 80mm 标签 / a4 报告)';
comment on column public.print_settings.is_default is '门店默认打印规格;每个门店仅一个 default(部分唯一索引兜底)';

-- 每个门店仅一个默认打印规格
create unique index if not exists idx_print_settings_default_per_store
  on public.print_settings (tenant_id, store_id)
  where is_default = true and is_active = true;

create index if not exists idx_print_settings_store
  on public.print_settings (tenant_id, store_id, is_active);

-- ============================================================
-- 4. base_dictionaries 基础字典
--    Pilot 必需字典(种类/品种/毛色等),由初始化 RPC 幂等写入
-- ============================================================
create table if not exists public.base_dictionaries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  category text not null,                                -- species / breed / color / ...
  code text not null,
  label text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint base_dictionaries_category_code_unique unique (tenant_id, category, code)
);

comment on table public.base_dictionaries is '基础字典:Pilot 必需字典项(物种/品种/毛色等),租户初始化时幂等写入';
comment on column public.base_dictionaries.category is '字典分类(如 species 物种 / breed 品种 / color 毛色)';
comment on column public.base_dictionaries.code is '字典项编码,同分类内唯一';
comment on column public.base_dictionaries.label is '字典项展示名';

create index if not exists idx_base_dictionaries_category
  on public.base_dictionaries (tenant_id, category, sort_order, is_active);

-- ============================================================
-- 5. updated_at 触发器(复用 migration 15 的 public.touch_updated_at())
-- ============================================================
drop trigger if exists trg_tenant_initializations_updated_at on public.tenant_initializations;
create trigger trg_tenant_initializations_updated_at
  before update on public.tenant_initializations
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_payment_contexts_updated_at on public.payment_contexts;
create trigger trg_payment_contexts_updated_at
  before update on public.payment_contexts
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_print_settings_updated_at on public.print_settings;
create trigger trg_print_settings_updated_at
  before update on public.print_settings
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_base_dictionaries_updated_at on public.base_dictionaries;
create trigger trg_base_dictionaries_updated_at
  before update on public.base_dictionaries
  for each row execute procedure public.touch_updated_at();
