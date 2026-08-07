-- ============================================================
-- 20260806000020_billing.sql
-- MXQ-8001~8007 Billing 领域(收费收银)
--   - billing_sequences   业务序号(租户+门店+类型+周期,用于 invoice_no 生成)
--     注意:独立表名,避免与 00015(CRM)的 business_sequences(sequence_key 结构)冲突
--   - invoices            收费发票(MXQ-8001)
--   - invoice_items       发票明细(MXQ-8001)
--   - approvals           审批记录(大额折扣审批,MXQ-8002)
--   - payments            支付记录(MXQ-8003)
--   - refunds             退款记录(MXQ-8004)
--   - RLS 策略(can_access_store + has_permission)
--   - RPC:generate_invoice_no / create_invoice / confirm_invoice /
--         cancel_invoice / process_payment / process_refund / generate_receipt
--   - 权限码:invoice.view / invoice.create / invoice.confirm /
--             invoice.cancel / payment.process / refund.process / receipt.print
-- 幂等,可重复应用
--
-- 状态机:
--   发票:  draft → confirmed → paid → refunded
--          draft → cancelled
--          confirmed → partially_paid → paid
--   支付/退款:单次原子操作,幂等防重复(idempotency_key)
--
-- 设计要点:
--   - 跨表引用(customer_id/pet_id/encounter_id/catalog_item_id/store_catalog_item_id)
--     用 uuid,不加 FK 约束,跨模块解耦
--   - 支付/退款走 Hono Command + PostgreSQL RPC,事务化保证一致性
--   - 幂等:(tenant_id, idempotency_key) 唯一索引 + idempotency_records 兜底
--   - 金额一致性:invoice.total = sum(items.amount) - discount_amount + tax_amount
--     items.amount = unit_price * quantity - items.discount_amount
--     RPC 内对二者均做校验
--   - 大额折扣(>10%)需 manager 审批,审批通过后才能 confirm
-- ============================================================

-- ===== 1. billing_sequences 表(业务序号) =====
-- 独立表名:与 CRM 的 business_sequences 隔离,避免同表不同结构冲突(R-01)
create table if not exists public.billing_sequences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  sequence_type text not null,                          -- invoice_no / order_no / ...
  period text not null,                                 -- YYYYMM 或 YYYYMMDD
  current_value integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint billing_sequences_type_check check (sequence_type in ('invoice_no', 'order_no', 'refund_no', 'other'))
);

create unique index if not exists idx_billing_sequences_unique
  on public.billing_sequences (tenant_id, store_id, sequence_type, period);
create index if not exists idx_billing_sequences_tenant_store
  on public.billing_sequences (tenant_id, store_id);

-- ===== 2. invoices 表(MXQ-8001) =====
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete cascade,
  invoice_no text not null,
  customer_id uuid,                                     -- 跨模块不加 FK
  pet_id uuid,                                          -- 跨模块不加 FK
  encounter_id uuid,                                    -- 跨模块不加 FK
  subtotal numeric(12,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  discount_reason text,
  tax_amount numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  paid_amount numeric(12,2) not null default 0,
  status text not null default 'draft',                 -- draft/confirmed/paid/partially_paid/refunded/cancelled
  payment_method text,                                  -- cash/wechat/alipay/card/other
  due_date date,
  confirmed_at timestamptz,
  confirmed_by uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint invoices_status_check check (status in ('draft', 'confirmed', 'paid', 'partially_paid', 'refunded', 'cancelled')),
  constraint invoices_payment_method_check check (
    payment_method is null or payment_method in ('cash', 'wechat', 'alipay', 'card', 'other')
  ),
  constraint invoices_total_check check (total >= 0),
  constraint invoices_paid_check check (paid_amount >= 0),
  constraint invoices_discount_check check (discount_amount >= 0),
  constraint invoices_tax_check check (tax_amount >= 0)
);

create unique index if not exists idx_invoices_tenant_invoice_no
  on public.invoices (tenant_id, invoice_no);
create index if not exists idx_invoices_tenant_store_status
  on public.invoices (tenant_id, store_id, status);
create index if not exists idx_invoices_tenant_customer
  on public.invoices (tenant_id, customer_id) where customer_id is not null;
create index if not exists idx_invoices_status
  on public.invoices (tenant_id, status, created_at desc);

-- ===== 3. invoice_items 表(MXQ-8001) =====
create table if not exists public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  catalog_item_id uuid,                                 -- 跨模块不加 FK
  store_catalog_item_id uuid,                           -- 跨模块不加 FK
  name text not null,
  unit_price numeric(12,2) not null default 0,
  quantity numeric(10,2) not null default 1,
  discount_amount numeric(12,2) not null default 0,
  amount numeric(12,2) not null default 0,
  sort_order integer not null default 0,
  category text not null default 'service',             -- service/drug/vaccine/exam/product

  constraint invoice_items_category_check check (category in ('service', 'drug', 'vaccine', 'exam', 'product')),
  constraint invoice_items_qty_check check (quantity > 0),
  constraint invoice_items_amount_check check (amount >= 0),
  constraint invoice_items_discount_check check (discount_amount >= 0),
  constraint invoice_items_unit_price_check check (unit_price >= 0)
);

create index if not exists idx_invoice_items_invoice
  on public.invoice_items (invoice_id);
create index if not exists idx_invoice_items_tenant
  on public.invoice_items (tenant_id);

-- ===== 4. approvals 表(大额折扣审批,MXQ-8002) =====
create table if not exists public.approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  entity_type text not null,                            -- invoice_discount / refund / ...
  entity_id uuid not null,                              -- 关联业务实体(invoice_id)
  requested_by uuid references auth.users(id) on delete set null,
  reason text,
  status text not null default 'pending',               -- pending / approved / rejected
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  approval_metadata jsonb not null default '{}'::jsonb, -- 保存折扣金额/比例等
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint approvals_entity_type_check check (entity_type in ('invoice_discount', 'refund', 'other')),
  constraint approvals_status_check check (status in ('pending', 'approved', 'rejected'))
);

create index if not exists idx_approvals_entity
  on public.approvals (tenant_id, entity_type, entity_id);
create index if not exists idx_approvals_status
  on public.approvals (tenant_id, store_id, status);

-- ===== 5. payments 表(MXQ-8003) =====
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  amount numeric(12,2) not null,
  method text not null,                                 -- cash/wechat/alipay/card/other
  transaction_no text,                                  -- 外部交易号(微信/支付宝等)
  idempotency_key text not null,
  operator_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint payments_method_check check (method in ('cash', 'wechat', 'alipay', 'card', 'other')),
  constraint payments_amount_check check (amount > 0)
);

create unique index if not exists idx_payments_tenant_idem
  on public.payments (tenant_id, idempotency_key);
create index if not exists idx_payments_invoice
  on public.payments (invoice_id, created_at desc);
create index if not exists idx_payments_tenant_time
  on public.payments (tenant_id, created_at desc);

-- ===== 6. refunds 表(MXQ-8004) =====
create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  payment_id uuid references public.payments(id) on delete set null,
  amount numeric(12,2) not null,
  reason text,
  idempotency_key text not null,
  operator_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint refunds_amount_check check (amount > 0)
);

create unique index if not exists idx_refunds_tenant_idem
  on public.refunds (tenant_id, idempotency_key);
create index if not exists idx_refunds_invoice
  on public.refunds (invoice_id, created_at desc);
create index if not exists idx_refunds_tenant_time
  on public.refunds (tenant_id, created_at desc);

-- ===== 7. updated_at 触发器 =====
drop trigger if exists trg_invoices_updated_at on public.invoices;
create trigger trg_invoices_updated_at
  before update on public.invoices
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_approvals_updated_at on public.approvals;
create trigger trg_approvals_updated_at
  before update on public.approvals
  for each row execute procedure public.touch_updated_at();

-- ===== 8. RLS 策略 =====
alter table public.billing_sequences enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_items enable row level security;
alter table public.approvals enable row level security;
alter table public.payments enable row level security;
alter table public.refunds enable row level security;

-- billing_sequences:仅 service_role 读写(RPC 内部使用),普通用户禁止
-- 不创建 select/insert/update/delete 策略 → 默认拒绝 authenticated
drop policy if exists "billing_sequences_admin_read" on public.billing_sequences;
create policy "billing_sequences_admin_read" on public.billing_sequences
  for select to authenticated using (public.is_system_admin());

-- invoices:can_access_store 校验
drop policy if exists "invoices_select" on public.invoices;
create policy "invoices_select" on public.invoices
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
  );

drop policy if exists "invoices_insert" on public.invoices;
create policy "invoices_insert" on public.invoices
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'invoice.create')
  );

drop policy if exists "invoices_update" on public.invoices;
create policy "invoices_update" on public.invoices
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
  );

drop policy if exists "invoices_delete" on public.invoices;
create policy "invoices_delete" on public.invoices
  for delete to authenticated
  using (
    public.is_system_admin()
    and public.can_access_store(tenant_id, store_id)
  );

-- invoice_items:跟随 invoice(联表校验),写入需 invoice.create
drop policy if exists "invoice_items_select" on public.invoice_items;
create policy "invoice_items_select" on public.invoice_items
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.invoices inv
      where inv.id = invoice_items.invoice_id
        and public.can_access_store(inv.tenant_id, inv.store_id)
    )
  );

drop policy if exists "invoice_items_insert" on public.invoice_items;
create policy "invoice_items_insert" on public.invoice_items
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.invoices inv
      where inv.id = invoice_items.invoice_id
        and public.can_access_store(inv.tenant_id, inv.store_id)
    )
    and public.has_permission(tenant_id, null, 'invoice.create')
  );

drop policy if exists "invoice_items_update" on public.invoice_items;
create policy "invoice_items_update" on public.invoice_items
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.invoices inv
      where inv.id = invoice_items.invoice_id
        and public.can_access_store(inv.tenant_id, inv.store_id)
    )
  )
  with check (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.invoices inv
      where inv.id = invoice_items.invoice_id
        and public.can_access_store(inv.tenant_id, inv.store_id)
    )
  );

drop policy if exists "invoice_items_delete" on public.invoice_items;
create policy "invoice_items_delete" on public.invoice_items
  for delete to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.invoices inv
      where inv.id = invoice_items.invoice_id
        and public.can_access_store(inv.tenant_id, inv.store_id)
    )
  );

-- approvals:can_access_store + 写入需 invoice.create/invoice.confirm
drop policy if exists "approvals_select" on public.approvals;
create policy "approvals_select" on public.approvals
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
  );

drop policy if exists "approvals_insert" on public.approvals;
create policy "approvals_insert" on public.approvals
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
  );

drop policy if exists "approvals_update" on public.approvals;
create policy "approvals_update" on public.approvals
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'invoice.confirm')
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'invoice.confirm')
  );

drop policy if exists "approvals_delete" on public.approvals;
create policy "approvals_delete" on public.approvals
  for delete to authenticated
  using (public.is_system_admin());

-- payments:不可变(RLS 拒绝 update/delete),仅 select/insert
drop policy if exists "payments_select" on public.payments;
create policy "payments_select" on public.payments
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.invoices inv
      where inv.id = payments.invoice_id
        and public.can_access_store(inv.tenant_id, inv.store_id)
    )
  );

drop policy if exists "payments_insert" on public.payments;
create policy "payments_insert" on public.payments
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.invoices inv
      where inv.id = payments.invoice_id
        and public.can_access_store(inv.tenant_id, inv.store_id)
    )
  );
-- 显式拒绝 update / delete:不创建策略即默认拒绝(流水不可变)

-- refunds:不可变(RLS 拒绝 update/delete),仅 select/insert
drop policy if exists "refunds_select" on public.refunds;
create policy "refunds_select" on public.refunds
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.invoices inv
      where inv.id = refunds.invoice_id
        and public.can_access_store(inv.tenant_id, inv.store_id)
    )
  );

drop policy if exists "refunds_insert" on public.refunds;
create policy "refunds_insert" on public.refunds
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.invoices inv
      where inv.id = refunds.invoice_id
        and public.can_access_store(inv.tenant_id, inv.store_id)
    )
  );
-- 显式拒绝 update / delete:不创建策略即默认拒绝(流水不可变)

-- ===== 9. 新增权限码(MXQ-8001~8007) =====
insert into public.permissions (code, name, module) values
  ('invoice.view', '查看发票', 'invoice'),
  ('invoice.create', '创建发票', 'invoice'),
  ('invoice.confirm', '确认发票', 'invoice'),
  ('invoice.cancel', '取消发票', 'invoice'),
  ('payment.process', '处理支付', 'payment'),
  ('refund.process', '处理退款', 'refund'),
  ('receipt.print', '打印小票', 'receipt')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- system_admin:全部 billing 权限
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'system_admin'
  and p.code in (
    'invoice.view', 'invoice.create', 'invoice.confirm', 'invoice.cancel',
    'payment.process', 'refund.process', 'receipt.print'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- store_manager:全部 billing 权限(含审批)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code in (
    'invoice.view', 'invoice.create', 'invoice.confirm', 'invoice.cancel',
    'payment.process', 'refund.process', 'receipt.print'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- cashier:收银相关权限(不含审批 confirm,但可创建/查看/收款/退款/打印)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'cashier'
  and p.code in (
    'invoice.view', 'invoice.create',
    'payment.process', 'refund.process', 'receipt.print'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容旧代码读取)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'invoice.view', 'invoice.create', 'invoice.confirm', 'invoice.cancel',
    'payment.process', 'refund.process', 'receipt.print'
  ])
)
where code = 'system_admin' and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'invoice.view', 'invoice.create', 'invoice.confirm', 'invoice.cancel',
    'payment.process', 'refund.process', 'receipt.print'
  ])
)
where code = 'store_manager' and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'invoice.view', 'invoice.create',
    'payment.process', 'refund.process', 'receipt.print'
  ])
)
where code = 'cashier' and is_system = true;

-- ===== 10. generate_invoice_no RPC(MXQ-8006) =====
-- 基于业务序号表生成发票号,UPSERT + 行级锁保证并发安全
-- 格式:INV-{STORE_CODE}-{YYYYMM}-{6位序号}
create or replace function public.generate_invoice_no(
  p_tenant_id uuid,
  p_store_id uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period text := to_char(now(), 'YYYYMM');
  v_seq integer;
  v_store_code text;
  v_invoice_no text;
  v_store_exists integer;
begin
  -- 校验门店存在且归属同租户
  select count(*) into v_store_exists
  from public.stores
  where id = p_store_id and tenant_id = p_tenant_id and archived_at is null;
  if v_store_exists = 0 then
    raise exception 'STORE_NOT_FOUND' using errcode = 'P0002';
  end if;

  select code into v_store_code from public.stores where id = p_store_id;

  -- UPSERT 自增序号(on conflict 时 current_value + 1)
  insert into public.billing_sequences (tenant_id, store_id, sequence_type, period, current_value)
  values (p_tenant_id, p_store_id, 'invoice_no', v_period, 1)
  on conflict (tenant_id, store_id, sequence_type, period)
  do update set current_value = public.billing_sequences.current_value + 1,
                 updated_at = now()
  returning current_value into v_seq;

  -- 格式:INV-{STORE_CODE}-{YYYYMM}-{6位序号}
  v_invoice_no := 'INV-' || coalesce(v_store_code, upper(left(p_store_id::text, 6))) || '-' || v_period || '-' || lpad(v_seq::text, 6, '0');

  return v_invoice_no;
end;
$$;

revoke all on function public.generate_invoice_no(uuid, uuid) from public;
grant execute on function public.generate_invoice_no(uuid, uuid) to authenticated;

-- ===== 11. create_invoice RPC(MXQ-8001) =====
-- 事务化建发票 + 明细,校验金额一致性
-- p_items:[{catalog_item_id, store_catalog_item_id, name, unit_price, quantity, discount_amount, amount, sort_order, category}]
-- 金额一致性:
--   1) items.amount = items.unit_price * items.quantity - items.discount_amount
--   2) invoice.subtotal = sum(items.amount)
--   3) invoice.total = subtotal - invoice.discount_amount + invoice.tax_amount
create or replace function public.create_invoice(
  p_tenant_id uuid,
  p_store_id uuid,
  p_customer_id uuid default null,
  p_pet_id uuid default null,
  p_encounter_id uuid default null,
  p_items jsonb default '[]'::jsonb,
  p_discount_amount numeric default 0,
  p_discount_reason text default null,
  p_tax_amount numeric default 0,
  p_payment_method text default null,
  p_due_date date default null,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_invoice_no text;
  v_item record;
  v_subtotal numeric(12,2) := 0;
  v_total numeric(12,2) := 0;
  v_item_amount numeric(12,2);
  v_item_expected_amount numeric(12,2);
  v_items_count integer;
begin
  -- 参数校验
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_ITEMS' using errcode = 'P0003';
  end if;

  if p_discount_amount < 0 then
    raise exception 'INVALID_DISCOUNT' using errcode = 'P0003';
  end if;

  if p_tax_amount < 0 then
    raise exception 'INVALID_TAX' using errcode = 'P0003';
  end if;

  -- 生成发票号
  v_invoice_no := public.generate_invoice_no(p_tenant_id, p_store_id);

  -- 计算 subtotal = sum(items.amount),同时校验每条 amount = unit_price * quantity - discount_amount
  v_subtotal := 0;
  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    v_item_amount := coalesce((v_item.item->>'amount')::numeric, 0);
    v_item_expected_amount := coalesce((v_item.item->>'unit_price')::numeric, 0)
      * coalesce((v_item.item->>'quantity')::numeric, 0)
      - coalesce((v_item.item->>'discount_amount')::numeric, 0);

    -- 金额一致性校验:允许 0.01 元容差(浮点误差)
    if abs(v_item_amount - v_item_expected_amount) > 0.01 then
      raise exception 'ITEM_AMOUNT_MISMATCH' using errcode = 'P0003',
        detail = format('item amount=%s, expected=%s', v_item_amount, v_item_expected_amount);
    end if;

    v_subtotal := v_subtotal + v_item_amount;
  end loop;

  -- 折扣不可超过 subtotal
  if p_discount_amount > v_subtotal then
    raise exception 'DISCOUNT_EXCEEDS_SUBTOTAL' using errcode = 'P0003';
  end if;

  v_total := v_subtotal - p_discount_amount + p_tax_amount;

  -- 写入发票
  insert into public.invoices (
    tenant_id, store_id, invoice_no,
    customer_id, pet_id, encounter_id,
    subtotal, discount_amount, discount_reason, tax_amount, total, paid_amount,
    status, payment_method, due_date, created_by
  )
  values (
    p_tenant_id, p_store_id, v_invoice_no,
    p_customer_id, p_pet_id, p_encounter_id,
    v_subtotal, p_discount_amount, p_discount_reason, p_tax_amount, v_total, 0,
    'draft', p_payment_method, p_due_date, p_operator_id
  )
  returning * into v_invoice;

  -- 写入明细
  v_items_count := 0;
  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    insert into public.invoice_items (
      tenant_id, invoice_id, catalog_item_id, store_catalog_item_id,
      name, unit_price, quantity, discount_amount, amount, sort_order, category
    )
    values (
      p_tenant_id, v_invoice.id,
      nullif(v_item.item->>'catalog_item_id', '')::uuid,
      nullif(v_item.item->>'store_catalog_item_id', '')::uuid,
      v_item.item->>'name',
      coalesce((v_item.item->>'unit_price')::numeric, 0),
      coalesce((v_item.item->>'quantity')::numeric, 1),
      coalesce((v_item.item->>'discount_amount')::numeric, 0),
      coalesce((v_item.item->>'amount')::numeric, 0),
      coalesce((v_item.item->>'sort_order')::integer, 0),
      coalesce(v_item.item->>'category', 'service')
    );
    v_items_count := v_items_count + 1;
  end loop;

  -- 若折扣比例超过 10%,自动创建审批记录(需 manager 审批后才能 confirm)
  if v_subtotal > 0 and p_discount_amount / v_subtotal > 0.10 then
    insert into public.approvals (
      tenant_id, store_id, entity_type, entity_id,
      requested_by, reason, status, approval_metadata
    )
    values (
      p_tenant_id, p_store_id, 'invoice_discount', v_invoice.id,
      p_operator_id, p_discount_reason, 'pending',
      jsonb_build_object(
        'discount_amount', p_discount_amount,
        'discount_percent', round((p_discount_amount / v_subtotal * 100)::numeric, 2),
        'subtotal', v_subtotal
      )
    );
  end if;

  return jsonb_build_object(
    'invoiceId', v_invoice.id,
    'invoiceNo', v_invoice.invoice_no,
    'total', v_total,
    'itemsCount', v_items_count
  );
end;
$$;

revoke all on function public.create_invoice(uuid, uuid, uuid, uuid, uuid, jsonb, numeric, text, numeric, text, date, uuid) from public;
grant execute on function public.create_invoice(uuid, uuid, uuid, uuid, uuid, jsonb, numeric, text, numeric, text, date, uuid) to authenticated;

-- ===== 12. confirm_invoice RPC(MXQ-8002) =====
-- 确认发票:校验大额折扣审批(>10%),通过后将 status 从 draft → confirmed
create or replace function public.confirm_invoice(
  p_invoice_id uuid,
  p_operator_id uuid default null
)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_pending_approval_count integer;
  v_discount_ratio numeric;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_invoice.status <> 'draft' then
    raise exception 'INVOICE_STATUS_INVALID' using errcode = 'P0003',
      detail = format('current status=%s, expected=draft', v_invoice.status);
  end if;

  -- 校验大额折扣审批(>10% 折扣需 manager 审批通过)
  if v_invoice.subtotal > 0 and v_invoice.discount_amount / v_invoice.subtotal > 0.10 then
    select count(*) into v_pending_approval_count
    from public.approvals
    where entity_type = 'invoice_discount'
      and entity_id = p_invoice_id
      and status = 'pending';

    if v_pending_approval_count > 0 then
      raise exception 'DISCOUNT_APPROVAL_PENDING' using errcode = 'P0003';
    end if;

    -- 校验是否存在已批准的审批记录
    select count(*) into v_pending_approval_count
    from public.approvals
    where entity_type = 'invoice_discount'
      and entity_id = p_invoice_id
      and status = 'approved';

    if v_pending_approval_count = 0 then
      raise exception 'DISCOUNT_APPROVAL_REQUIRED' using errcode = 'P0003';
    end if;
  end if;

  -- 状态转换:draft → confirmed
  update public.invoices
  set status = 'confirmed',
      confirmed_at = now(),
      confirmed_by = p_operator_id,
      updated_at = now()
  where id = p_invoice_id
  returning * into v_invoice;

  return v_invoice;
end;
$$;

revoke all on function public.confirm_invoice(uuid, uuid) from public;
grant execute on function public.confirm_invoice(uuid, uuid) to authenticated;

-- ===== 13. approve_discount RPC(MXQ-8002,manager 审批大额折扣) =====
create or replace function public.approve_discount(
  p_approval_id uuid,
  p_status text,
  p_approved_by uuid default null,
  p_reason text default null
)
returns public.approvals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_approval public.approvals;
begin
  if p_status not in ('approved', 'rejected') then
    raise exception 'INVALID_APPROVAL_STATUS' using errcode = 'P0003';
  end if;

  select * into v_approval from public.approvals where id = p_approval_id for update;
  if not found then
    raise exception 'APPROVAL_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_approval.status <> 'pending' then
    raise exception 'APPROVAL_ALREADY_PROCESSED' using errcode = 'P0003';
  end if;

  update public.approvals
  set status = p_status,
      approved_by = p_approved_by,
      approved_at = now(),
      reason = coalesce(p_reason, reason),
      updated_at = now()
  where id = p_approval_id
  returning * into v_approval;

  return v_approval;
end;
$$;

revoke all on function public.approve_discount(uuid, text, uuid, text) from public;
grant execute on function public.approve_discount(uuid, text, uuid, text) to authenticated;

-- ===== 14. cancel_invoice RPC(MXQ-8001) =====
-- 取消发票:仅 draft/confirmed 状态可取消
create or replace function public.cancel_invoice(
  p_invoice_id uuid,
  p_operator_id uuid default null,
  p_reason text default null
)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 已支付/部分支付/已退款的状态不可取消
  if v_invoice.status in ('paid', 'partially_paid', 'refunded') then
    raise exception 'INVOICE_STATUS_INVALID' using errcode = 'P0003',
      detail = format('cannot cancel invoice in status=%s', v_invoice.status);
  end if;

  if v_invoice.status = 'cancelled' then
    raise exception 'INVOICE_ALREADY_CANCELLED' using errcode = 'P0003';
  end if;

  update public.invoices
  set status = 'cancelled',
      updated_at = now()
  where id = p_invoice_id
  returning * into v_invoice;

  return v_invoice;
end;
$$;

revoke all on function public.cancel_invoice(uuid, uuid, text) from public;
grant execute on function public.cancel_invoice(uuid, uuid, text) to authenticated;

-- ===== 15. process_payment RPC(MXQ-8003,幂等防重复) =====
-- 事务:校验 invoice status=confirmed/partially_paid → 记录 payment → 更新 paid_amount → 状态机
-- 幂等:同 idempotency_key 返回原结果
create or replace function public.process_payment(
  p_invoice_id uuid,
  p_amount numeric,
  p_method text,
  p_operator_id uuid default null,
  p_idempotency_key text default null,
  p_transaction_no text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_existing jsonb;
  v_payment public.payments;
  v_new_paid_amount numeric(12,2);
  v_new_status text;
begin
  -- 参数校验
  if p_amount <= 0 then
    raise exception 'INVALID_AMOUNT' using errcode = 'P0003';
  end if;
  if p_method not in ('cash', 'wechat', 'alipay', 'card', 'other') then
    raise exception 'INVALID_METHOD' using errcode = 'P0003';
  end if;

  -- 幂等检查:命中已存在记录直接返回原结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where tenant_id = (select tenant_id from public.invoices where id = p_invoice_id)
      and idempotency_key = p_idempotency_key
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  -- 行锁发票
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 状态校验:仅 confirmed / partially_paid 可支付
  if v_invoice.status not in ('confirmed', 'partially_paid') then
    raise exception 'INVOICE_STATUS_INVALID' using errcode = 'P0003',
      detail = format('current status=%s, expected=confirmed or partially_paid', v_invoice.status);
  end if;

  -- 校验支付金额不超过未付余额(允许 0.01 容差)
  if p_amount > (v_invoice.total - v_invoice.paid_amount) + 0.01 then
    raise exception 'AMOUNT_EXCEEDS_DUE' using errcode = 'P0003';
  end if;

  -- 写支付记录(唯一索引兜底防重复)
  insert into public.payments (
    tenant_id, invoice_id, amount, method, transaction_no, idempotency_key, operator_id
  )
  values (
    v_invoice.tenant_id, p_invoice_id, p_amount, p_method, p_transaction_no, p_idempotency_key, p_operator_id
  )
  returning * into v_payment;

  -- 更新发票已付金额与状态
  v_new_paid_amount := v_invoice.paid_amount + p_amount;
  if v_new_paid_amount >= v_invoice.total - 0.01 then
    v_new_status := 'paid';
  else
    v_new_status := 'partially_paid';
  end if;

  update public.invoices
  set paid_amount = v_new_paid_amount,
      status = v_new_status,
      payment_method = coalesce(v_invoice.payment_method, p_method),
      updated_at = now()
  where id = p_invoice_id;

  -- 记录幂等结果(service role 绕过 RLS 写入)
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (
      v_invoice.tenant_id, p_idempotency_key, 'process_payment', 'payment', v_payment.id,
      jsonb_build_object(
        'paymentId', v_payment.id,
        'invoiceId', p_invoice_id,
        'amount', p_amount,
        'method', p_method,
        'paidAmount', v_new_paid_amount,
        'status', v_new_status,
        'transactionNo', p_transaction_no
      )
    )
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'paymentId', v_payment.id,
    'invoiceId', p_invoice_id,
    'amount', p_amount,
    'method', p_method,
    'paidAmount', v_new_paid_amount,
    'status', v_new_status,
    'transactionNo', p_transaction_no
  );
end;
$$;

revoke all on function public.process_payment(uuid, numeric, text, uuid, text, text) from public;
grant execute on function public.process_payment(uuid, numeric, text, uuid, text, text) to authenticated;

-- ===== 16. process_refund RPC(MXQ-8004,幂等防重复) =====
-- 事务:校验 invoice status=paid/partially_paid → 记录 refund → 扣减 paid_amount → 状态机
-- 退款金额不可超过 paid_amount
-- 幂等:同 idempotency_key 返回原结果
create or replace function public.process_refund(
  p_invoice_id uuid,
  p_amount numeric,
  p_reason text,
  p_operator_id uuid default null,
  p_idempotency_key text default null,
  p_payment_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_existing jsonb;
  v_refund public.refunds;
  v_new_paid_amount numeric(12,2);
  v_new_status text;
begin
  -- 参数校验
  if p_amount <= 0 then
    raise exception 'INVALID_AMOUNT' using errcode = 'P0003';
  end if;
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'REFUND_REASON_REQUIRED' using errcode = 'P0003';
  end if;

  -- 幂等检查
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where tenant_id = (select tenant_id from public.invoices where id = p_invoice_id)
      and idempotency_key = p_idempotency_key
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  -- 行锁发票
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 状态校验:仅 paid / partially_paid 可退款
  if v_invoice.status not in ('paid', 'partially_paid') then
    raise exception 'INVOICE_STATUS_INVALID' using errcode = 'P0003',
      detail = format('current status=%s, expected=paid or partially_paid', v_invoice.status);
  end if;

  -- 退款金额不可超过已付金额
  if p_amount > v_invoice.paid_amount then
    raise exception 'REFUND_EXCEEDS_PAID' using errcode = 'P0003';
  end if;

  -- 写退款记录
  insert into public.refunds (
    tenant_id, invoice_id, payment_id, amount, reason, idempotency_key, operator_id
  )
  values (
    v_invoice.tenant_id, p_invoice_id, p_payment_id, p_amount, p_reason, p_idempotency_key, p_operator_id
  )
  returning * into v_refund;

  -- 扣减已付金额,更新状态
  v_new_paid_amount := v_invoice.paid_amount - p_amount;
  if v_new_paid_amount <= 0.01 then
    v_new_paid_amount := 0;
    v_new_status := 'refunded';
  else
    v_new_status := 'partially_paid';
  end if;

  update public.invoices
  set paid_amount = v_new_paid_amount,
      status = v_new_status,
      updated_at = now()
  where id = p_invoice_id;

  -- 记录幂等结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (
      v_invoice.tenant_id, p_idempotency_key, 'process_refund', 'refund', v_refund.id,
      jsonb_build_object(
        'refundId', v_refund.id,
        'invoiceId', p_invoice_id,
        'amount', p_amount,
        'reason', p_reason,
        'paidAmount', v_new_paid_amount,
        'status', v_new_status
      )
    )
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'refundId', v_refund.id,
    'invoiceId', p_invoice_id,
    'amount', p_amount,
    'reason', p_reason,
    'paidAmount', v_new_paid_amount,
    'status', v_new_status
  );
end;
$$;

revoke all on function public.process_refund(uuid, numeric, text, uuid, text, uuid) from public;
grant execute on function public.process_refund(uuid, numeric, text, uuid, text, uuid) to authenticated;

-- ===== 17. generate_receipt RPC(MXQ-8007) =====
-- 生成小票数据(jsonb),含门店信息/项目明细/支付/找零等
create or replace function public.generate_receipt(
  p_invoice_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_store record;
  v_items jsonb;
  v_payments jsonb;
  v_refunds jsonb;
  v_change numeric(12,2);
begin
  select * into v_invoice from public.invoices where id = p_invoice_id;
  if not found then
    raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 取门店信息
  select id, name, code, address, phone into v_store
  from public.stores where id = v_invoice.store_id;

  -- 取明细
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ii.id,
    'name', ii.name,
    'category', ii.category,
    'unitPrice', ii.unit_price,
    'quantity', ii.quantity,
    'discountAmount', ii.discount_amount,
    'amount', ii.amount,
    'sortOrder', ii.sort_order
  ) order by ii.sort_order, ii.created_at), '[]'::jsonb) into v_items
  from public.invoice_items ii
  where ii.invoice_id = p_invoice_id;

  -- 取支付记录
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'amount', p.amount,
    'method', p.method,
    'transactionNo', p.transaction_no,
    'createdAt', p.created_at
  ) order by p.created_at), '[]'::jsonb) into v_payments
  from public.payments p
  where p.invoice_id = p_invoice_id;

  -- 取退款记录
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'amount', r.amount,
    'reason', r.reason,
    'createdAt', r.created_at
  ) order by r.created_at), '[]'::jsonb) into v_refunds
  from public.refunds r
  where r.invoice_id = p_invoice_id;

  -- 找零 = 已付金额 - 发票总额(仅现金支付时可能有找零)
  v_change := greatest(v_invoice.paid_amount - v_invoice.total, 0);

  return jsonb_build_object(
    'invoiceId', v_invoice.id,
    'invoiceNo', v_invoice.invoice_no,
    'status', v_invoice.status,
    'store', jsonb_build_object(
      'id', v_store.id,
      'name', v_store.name,
      'code', v_store.code,
      'address', v_store.address,
      'phone', v_store.phone
    ),
    'customerId', v_invoice.customer_id,
    'petId', v_invoice.pet_id,
    'encounterId', v_invoice.encounter_id,
    'subtotal', v_invoice.subtotal,
    'discountAmount', v_invoice.discount_amount,
    'discountReason', v_invoice.discount_reason,
    'taxAmount', v_invoice.tax_amount,
    'total', v_invoice.total,
    'paidAmount', v_invoice.paid_amount,
    'change', v_change,
    'paymentMethod', v_invoice.payment_method,
    'items', v_items,
    'payments', v_payments,
    'refunds', v_refunds,
    'createdAt', v_invoice.created_at,
    'confirmedAt', v_invoice.confirmed_at
  );
end;
$$;

revoke all on function public.generate_receipt(uuid) from public;
grant execute on function public.generate_receipt(uuid) to authenticated;
