-- ============================================================
-- 20260810000221_coupons.sql
-- Agent-05 CRM Growth & Marketing: 优惠券域
--   - coupons             优惠券模板(固定金额/百分比/门槛/范围/额度)
--   - coupon_issues       发放记录(客户 + 唯一码 + 状态机)
--   - coupon_redemptions  核销流水(不可变,幂等)
--   - preview_coupon_discount()  报价预览(只读,不锁)
--   - redeem_coupon()            权威核销(锁 + 幂等 + 快照)
-- 原则:
--   - 权威核销在服务端,禁止前端算折扣
--   - 同一 issue 并发核销通过 SELECT FOR UPDATE 防重复
--   - Redemption 流水不可变
-- 权限:
--   marketing.view / marketing.manage / marketing.adjust_entitlement
-- ============================================================
set search_path = public;

-- ===== 1. coupons 表(优惠券模板) =====
create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  name text not null,
  type text not null default 'fixed',              -- fixed / percentage
  value numeric(12,2) not null,                    -- 固定金额 或 折扣百分比
  min_spend numeric(12,2) not null default 0,
  max_discount numeric(12,2),                      -- 百分比券封顶(可空)
  catalog_type text,                               -- 限定目录类型 service/product/drug/vaccine/exam;null=不限
  catalog_item_id uuid,                            -- 限定目录项;null=不限
  store_id uuid references public.stores(id) on delete cascade, -- null=全门店
  valid_from timestamptz,
  valid_until timestamptz,
  quota integer not null default 0,                -- 0=不限量
  used_count integer not null default 0,
  per_customer_limit integer not null default 1,   -- 每人限领张数
  stacking_policy text not null default 'single',  -- single / stackable
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint coupons_type_check check (type in ('fixed', 'percentage')),
  constraint coupons_value_check check (value >= 0),
  constraint coupons_min_spend_check check (min_spend >= 0),
  constraint coupons_max_discount_check check (max_discount is null or max_discount >= 0),
  constraint coupons_quota_check check (quota >= 0),
  constraint coupons_stack_policy_check check (stacking_policy in ('single', 'stackable')),
  -- 目录类型与目录项互斥
  constraint coupons_target_check check (not (catalog_type is not null and catalog_item_id is not null))
);

create unique index if not exists idx_coupons_tenant_code on public.coupons (tenant_id, code);
create index if not exists idx_coupons_tenant_active on public.coupons (tenant_id, is_active);

drop trigger if exists trg_coupons_updated_at on public.coupons;
create trigger trg_coupons_updated_at
  before update on public.coupons
  for each row execute procedure public.touch_updated_at();

-- ===== 2. coupon_issues 表(发放记录) =====
create table if not exists public.coupon_issues (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  coupon_id uuid not null,
  customer_id uuid not null,
  code text not null,                               -- 唯一优惠码
  status text not null default 'available',         -- available/redeemed/expired/cancelled
  issued_at timestamptz not null default now(),
  expires_at timestamptz,
  redeemed_at timestamptz,
  redeemed_invoice_id uuid,
  cancelled_at timestamptz,
  cancel_reason text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint coupon_issues_status_check check (status in ('available', 'redeemed', 'expired', 'cancelled'))
);

create unique index if not exists idx_coupon_issues_tenant_code on public.coupon_issues (tenant_id, code);
create index if not exists idx_coupon_issues_tenant_coupon on public.coupon_issues (tenant_id, coupon_id, status);
create index if not exists idx_coupon_issues_tenant_customer on public.coupon_issues (tenant_id, customer_id, status);

drop trigger if exists trg_coupon_issues_updated_at on public.coupon_issues;
create trigger trg_coupon_issues_updated_at
  before update on public.coupon_issues
  for each row execute procedure public.touch_updated_at();

-- ===== 3. coupon_redemptions 表(核销流水,不可变) =====
create table if not exists public.coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  issue_id uuid not null,
  coupon_id uuid not null,
  customer_id uuid not null,
  invoice_id uuid,
  discount_amount numeric(12,2) not null,
  snapshot jsonb not null default '{}'::jsonb,       -- 核销时规则快照(防模板后续修改)
  idempotency_key text,
  operator_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint coupon_redemptions_amount_check check (discount_amount >= 0)
);

-- 幂等:同一业务请求不重复核销
create unique index if not exists idx_coupon_redemptions_tenant_idem
  on public.coupon_redemptions (tenant_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists idx_coupon_redemptions_issue on public.coupon_redemptions (issue_id);
create index if not exists idx_coupon_redemptions_invoice on public.coupon_redemptions (invoice_id) where invoice_id is not null;

-- ===== 4. 优惠码生成(租户内唯一) =====
create or replace function public.gen_coupon_code(p_tenant_id uuid)
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  v_code text;
begin
  loop
    v_code := 'MXQ-' || upper(substr(md5(gen_random_uuid()::text), 1, 8));
    exit when not exists (
      select 1 from public.coupon_issues where tenant_id = p_tenant_id and code = v_code
    );
  end loop;
  return v_code;
end;
$$;

-- ===== 5. issue_coupons RPC(发放) =====
-- 向一组客户发放优惠券,校验每人限领张数
-- 返回 {issued: n, issues: [{issue_id, code}]}
create or replace function public.issue_coupons(
  p_tenant_id uuid,
  p_coupon_id uuid,
  p_customer_ids uuid[],
  p_operator_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_coupon record;
  v_cid uuid;
  v_issued_count integer := 0;
  v_existing integer;
  v_issue_id uuid;
  v_code text;
  v_result jsonb := '[]'::jsonb;
  v_now timestamptz := now();
begin
  select * into v_coupon from public.coupons
  where id = p_coupon_id and tenant_id = p_tenant_id and is_active = true;
  if not found then
    raise exception 'COUPON_NOT_FOUND_OR_INACTIVE';
  end if;

  foreach v_cid in array p_customer_ids loop
    -- 校验客户属于该租户
    if not exists (
      select 1 from public.customers where id = v_cid and tenant_id = p_tenant_id and status = 'active'
    ) then
      continue;
    end if;

    -- 每人限领张数:已可用 + 本次 1 张
    select count(*)::int into v_existing
    from public.coupon_issues
    where tenant_id = p_tenant_id and coupon_id = p_coupon_id
      and customer_id = v_cid and status = 'available';
    if v_existing >= v_coupon.per_customer_limit then
      continue;
    end if;

    v_code := public.gen_coupon_code(p_tenant_id);
    insert into public.coupon_issues
      (tenant_id, coupon_id, customer_id, code, status, issued_at, expires_at, created_by)
    values
      (p_tenant_id, p_coupon_id, v_cid, v_code, 'available', v_now, v_coupon.valid_until, p_operator_id)
    returning id into v_issue_id;

    v_issued_count := v_issued_count + 1;
    v_result := v_result || jsonb_build_object('issue_id', v_issue_id, 'code', v_code, 'customer_id', v_cid);
  end loop;

  -- 同步已发放计数
  update public.coupons set used_count = (
    select count(*)::int from public.coupon_issues where coupon_id = p_coupon_id and status = 'available'
  ) where id = p_coupon_id;

  return jsonb_build_object('issued', v_issued_count, 'issues', v_result);
end;
$$;

-- ===== 6. preview_coupon_discount RPC(报价预览,只读) =====
-- 校验优惠券是否可用并计算折扣(不锁、不核销)
create or replace function public.preview_coupon_discount(
  p_tenant_id uuid,
  p_issue_id uuid,
  p_store_id uuid,
  p_subtotal numeric
) returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_issue record;
  v_coupon record;
  v_discount numeric;
  v_error text;
begin
  select i.*, c.type as coupon_type, c.value as coupon_value, c.min_spend as coupon_min_spend,
         c.max_discount as coupon_max_discount, c.catalog_type as coupon_catalog_type,
         c.catalog_item_id as coupon_catalog_item_id, c.store_id as coupon_store_id,
         c.valid_from as coupon_valid_from, c.valid_until as coupon_valid_until
  into v_issue
  from public.coupon_issues i
  join public.coupons c on c.id = i.coupon_id
  where i.id = p_issue_id and i.tenant_id = p_tenant_id;
  if not found then
    raise exception 'ISSUE_NOT_FOUND';
  end if;

  -- 状态
  if v_issue.status <> 'available' then
    raise exception 'COUPON_NOT_AVAILABLE';
  end if;
  -- 有效期
  if (v_issue.coupon_valid_from is not null and v_issue.coupon_valid_from > now())
     or (v_issue.coupon_valid_until is not null and v_issue.coupon_valid_until < now()) then
    raise exception 'COUPON_EXPIRED';
  end if;
  if v_issue.expires_at is not null and v_issue.expires_at < now() then
    raise exception 'COUPON_EXPIRED';
  end if;
  -- 门店范围
  if v_issue.coupon_store_id is not null and v_issue.coupon_store_id <> p_store_id then
    raise exception 'COUPON_WRONG_STORE';
  end if;
  -- 门槛
  if p_subtotal < v_issue.coupon_min_spend then
    raise exception 'COUPON_MIN_SPEND_NOT_MET';
  end if;

  -- 计算折扣
  if v_issue.coupon_type = 'fixed' then
    v_discount := v_issue.coupon_value;
  else
    v_discount := round(p_subtotal * v_issue.coupon_value / 100.0, 2);
    if v_issue.coupon_max_discount is not null and v_discount > v_issue.coupon_max_discount then
      v_discount := v_issue.coupon_max_discount;
    end if;
  end if;
  if v_discount > p_subtotal then
    v_discount := p_subtotal;
  end if;

  return jsonb_build_object(
    'issue_id', p_issue_id,
    'coupon_id', v_issue.coupon_id,
    'code', v_issue.code,
    'discount_amount', v_discount,
    'status', 'valid'
  );
end;
$$;

-- ===== 7. redeem_coupon RPC(权威核销:锁 + 幂等 + 快照) =====
-- 流程:幂等检查 → 锁 issue 行 → 校验 → 核销 → 写流水
create or replace function public.redeem_coupon(
  p_tenant_id uuid,
  p_issue_id uuid,
  p_customer_id uuid,
  p_store_id uuid,
  p_subtotal numeric,
  p_invoice_id uuid default null,
  p_idempotency_key text default null,
  p_operator_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_redemption record;
  v_issue record;
  v_coupon record;
  v_discount numeric;
  v_snapshot jsonb;
begin
  -- 幂等:相同业务请求直接返回既有核销结果
  if p_idempotency_key is not null then
    select r.id, r.discount_amount, r.snapshot into v_redemption
    from public.coupon_redemptions r
    where r.tenant_id = p_tenant_id and r.idempotency_key = p_idempotency_key
    limit 1;
    if found then
      return jsonb_build_object(
        'redemption_id', v_redemption.id,
        'discount_amount', v_redemption.discount_amount,
        'idempotent', true
      );
    end if;
  end if;

  -- 锁 issue 行(防并发核销同券)
  select i.* into v_issue
  from public.coupon_issues i
  where i.id = p_issue_id and i.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'ISSUE_NOT_FOUND';
  end if;

  select * into v_coupon
  from public.coupons
  where id = v_issue.coupon_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'COUPON_NOT_FOUND';
  end if;

  -- 校验
  if v_issue.status <> 'available' then
    raise exception 'COUPON_NOT_AVAILABLE';
  end if;
  if v_issue.customer_id <> p_customer_id then
    raise exception 'COUPON_CUSTOMER_MISMATCH';
  end if;
  if (v_coupon.valid_from is not null and v_coupon.valid_from > now())
     or (v_coupon.valid_until is not null and v_coupon.valid_until < now()) then
    raise exception 'COUPON_EXPIRED';
  end if;
  if v_issue.expires_at is not null and v_issue.expires_at < now() then
    raise exception 'COUPON_EXPIRED';
  end if;
  if v_coupon.store_id is not null and v_coupon.store_id <> p_store_id then
    raise exception 'COUPON_WRONG_STORE';
  end if;
  if p_subtotal < v_coupon.min_spend then
    raise exception 'COUPON_MIN_SPEND_NOT_MET';
  end if;
  if v_coupon.quota > 0 and v_coupon.used_count >= v_coupon.quota then
    raise exception 'COUPON_QUOTA_EXHAUSTED';
  end if;

  -- 计算折扣
  if v_coupon.type = 'fixed' then
    v_discount := v_coupon.value;
  else
    v_discount := round(p_subtotal * v_coupon.value / 100.0, 2);
    if v_coupon.max_discount is not null and v_discount > v_coupon.max_discount then
      v_discount := v_coupon.max_discount;
    end if;
  end if;
  if v_discount > p_subtotal then
    v_discount := p_subtotal;
  end if;

  -- 规则快照(防模板后续修改影响审计)
  v_snapshot := jsonb_build_object(
    'coupon_code', v_coupon.code,
    'coupon_name', v_coupon.name,
    'type', v_coupon.type,
    'value', v_coupon.value,
    'min_spend', v_coupon.min_spend,
    'max_discount', v_coupon.max_discount,
    'issue_code', v_issue.code,
    'subtotal', p_subtotal
  );

  -- 核销 issue(状态机 available → redeemed)
  update public.coupon_issues
  set status = 'redeemed',
      redeemed_at = now(),
      redeemed_invoice_id = p_invoice_id,
      updated_at = now()
  where id = p_issue_id;

  -- 写不可变流水
  insert into public.coupon_redemptions
    (tenant_id, issue_id, coupon_id, customer_id, invoice_id, discount_amount, snapshot, idempotency_key, operator_id)
  values
    (p_tenant_id, v_issue.id, v_coupon.id, p_customer_id, p_invoice_id, v_discount, v_snapshot, p_idempotency_key, p_operator_id)
  returning id into v_redemption.id;

  -- 更新额度(CAS 语义:used_count 在锁内自增)
  update public.coupons
  set used_count = used_count + 1, updated_at = now()
  where id = v_coupon.id;

  return jsonb_build_object(
    'redemption_id', v_redemption.id,
    'discount_amount', v_discount,
    'idempotent', false
  );
end;
$$;

-- ===== 8. cancel_coupon_issue RPC(作废,反向冲正) =====
create or replace function public.cancel_coupon_issue(
  p_tenant_id uuid,
  p_issue_id uuid,
  p_reason text,
  p_operator_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_issue record;
begin
  select i.* into v_issue
  from public.coupon_issues i
  where i.id = p_issue_id and i.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'ISSUE_NOT_FOUND';
  end if;

  if v_issue.status not in ('available', 'expired') then
    raise exception 'ISSUE_NOT_CANCELLABLE';
  end if;

  update public.coupon_issues
  set status = 'cancelled',
      cancelled_at = now(),
      cancel_reason = coalesce(p_reason, ''),
      updated_at = now()
  where id = p_issue_id;

  -- 回收已发放计数
  update public.coupons set used_count = (
    select count(*)::int from public.coupon_issues where coupon_id = v_issue.coupon_id and status = 'available'
  ) where id = v_issue.coupon_id;

  return jsonb_build_object('issue_id', p_issue_id, 'status', 'cancelled');
end;
$$;

-- ===== 9. RLS =====
alter table public.coupons enable row level security;
alter table public.coupon_issues enable row level security;
alter table public.coupon_redemptions enable row level security;

drop policy if exists "coupons_select" on public.coupons;
create policy "coupons_select" on public.coupons
  for select to authenticated using (public.is_tenant_member(tenant_id));

drop policy if exists "coupon_issues_select" on public.coupon_issues;
create policy "coupon_issues_select" on public.coupon_issues
  for select to authenticated using (public.is_tenant_member(tenant_id));

drop policy if exists "coupon_redemptions_select" on public.coupon_redemptions;
create policy "coupon_redemptions_select" on public.coupon_redemptions
  for select to authenticated using (public.is_tenant_member(tenant_id));

-- 模板写:marketing.manage(服务端 RPC 为主)
drop policy if exists "coupons_insert" on public.coupons;
create policy "coupons_insert" on public.coupons
  for insert to authenticated
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'marketing.manage'));

drop policy if exists "coupons_update" on public.coupons;
create policy "coupons_update" on public.coupons
  for update to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'marketing.manage'))
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'marketing.manage'));

drop policy if exists "coupons_delete" on public.coupons;
create policy "coupons_delete" on public.coupons
  for delete to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'marketing.manage'));

-- 发放记录:adjust_entitlement(发/作废)
drop policy if exists "coupon_issues_insert" on public.coupon_issues;
create policy "coupon_issues_insert" on public.coupon_issues
  for insert to authenticated
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'marketing.adjust_entitlement'));

drop policy if exists "coupon_issues_update" on public.coupon_issues;
create policy "coupon_issues_update" on public.coupon_issues
  for update to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'marketing.adjust_entitlement'))
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'marketing.adjust_entitlement'));

-- ===== 10. 高危 RPC ACL:仅 service_role =====
revoke all on function public.gen_coupon_code(uuid) from public;
revoke all on function public.gen_coupon_code(uuid) from anon;
revoke all on function public.gen_coupon_code(uuid) from authenticated;
grant execute on function public.gen_coupon_code(uuid) to service_role;

revoke all on function public.issue_coupons(uuid, uuid, uuid[], uuid) from public;
revoke all on function public.issue_coupons(uuid, uuid, uuid[], uuid) from anon;
revoke all on function public.issue_coupons(uuid, uuid, uuid[], uuid) from authenticated;
grant execute on function public.issue_coupons(uuid, uuid, uuid[], uuid) to service_role;

revoke all on function public.preview_coupon_discount(uuid, uuid, uuid, numeric) from public;
revoke all on function public.preview_coupon_discount(uuid, uuid, uuid, numeric) from anon;
revoke all on function public.preview_coupon_discount(uuid, uuid, uuid, numeric) from authenticated;
grant execute on function public.preview_coupon_discount(uuid, uuid, uuid, numeric) to service_role;

revoke all on function public.redeem_coupon(uuid, uuid, uuid, uuid, numeric, uuid, text, uuid) from public;
revoke all on function public.redeem_coupon(uuid, uuid, uuid, uuid, numeric, uuid, text, uuid) from anon;
revoke all on function public.redeem_coupon(uuid, uuid, uuid, uuid, numeric, uuid, text, uuid) from authenticated;
grant execute on function public.redeem_coupon(uuid, uuid, uuid, uuid, numeric, uuid, text, uuid) to service_role;

revoke all on function public.cancel_coupon_issue(uuid, uuid, text, uuid) from public;
revoke all on function public.cancel_coupon_issue(uuid, uuid, text, uuid) from anon;
revoke all on function public.cancel_coupon_issue(uuid, uuid, text, uuid) from authenticated;
grant execute on function public.cancel_coupon_issue(uuid, uuid, text, uuid) to service_role;

-- ===== 11. 权限 seed =====
insert into public.permissions (code, name, module) values
  ('marketing.view', '查看营销', 'marketing'),
  ('marketing.manage', '管理营销', 'marketing'),
  ('marketing.adjust_entitlement', '发放权益(券/套餐)', 'marketing')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code in ('system_admin', 'tenant_owner', 'store_manager')
  and p.code in ('marketing.view', 'marketing.manage', 'marketing.adjust_entitlement')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

update public.roles
set permissions = array(
  select distinct unnest(permissions || array['marketing.view', 'marketing.manage', 'marketing.adjust_entitlement'])
)
where code in ('system_admin', 'tenant_owner', 'store_manager') and is_system = true;
