-- ============================================================
-- 20260811000052_inpatient_charge_rules_periods.sql
-- E-R-1(3.6.2-02) 住院/寄养自动计费规则(修复任务清单 R-1, P0)
--
-- 能力落地:
--   1. inpatient_charge_rules:计费规则表(room_type 关联默认项目 + cage_id 可覆盖 + 价格快照)
--   2. inpatient_charge_periods:计费周期表(逐日 period + 换房分段,幂等键防重)
--   3. run_daily_billing RPC:按日切规则对在住/在养记录逐日生成费用
--      (住院 → inpatient_charges;寄养 → boarding_service_charges.is_base_rate=true)
--   4. 换房分段计费:transfer_cage / boarding_change_cage 截断当前开放 period,
--      新笼位按新规则/新价格快照开启续算 period
--   5. 寄养基础房费改为逐日自动计费:boarding_prepare_checkout / boarding_checkout
--      复用 periods(boarding_service_charges)汇总,不再离店一次性补算
--   6. 定时调度:pg_cron 可用时注册每日日切任务;不可用静默跳过 → Hono API 手动触发兜底
--
-- 说明:
--   - cutoff_time / grace_minutes 为规则元数据列(日切点/延迟出院宽限),
--     当前 run_daily_billing 按自然日逐日执行,后续日切策略可据此扩展。
--   - 无规则时回退 cages.daily_rate,并以 cage.id 作为 catalog_item_id 占位,
--     复用既有唯一索引实现幂等(migration 21 generate_daily_charges 同模式)。
--   - 幂等,可重复应用。
-- ============================================================

-- ===== 1. inpatient_charge_rules 表(计费规则) =====
create table if not exists public.inpatient_charge_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null,                                -- 规则名称(如:普通房床位费/寄养房日费)
  catalog_item_id uuid,                              -- 跨 migration 不加 FK(引用 catalog_items)
  billing_unit text not null default 'day',          -- 计费单位: day/night/stay
  cutoff_time time not null default '00:00:00',      -- 日切时间(营业日切点,规则元数据)
  grace_minutes integer not null default 0,          -- 延迟出院宽限分钟(不足一日按一日,规则元数据)
  status text not null default 'active',             -- active / inactive
  room_type text,                                    -- 房间类型(默认规则;cage_id 为空时按 room_type 匹配)
  cage_id uuid,                                      -- 笼位覆盖规则(优先于 room_type 默认规则)
  price_snapshot numeric(12,2) not null default 0,   -- 价格快照(计费时固化,后续改价不影响已生成费用)
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint inpatient_charge_rules_status_check check (status in ('active', 'inactive')),
  constraint inpatient_charge_rules_unit_check check (billing_unit in ('day', 'night', 'stay')),
  constraint inpatient_charge_rules_grace_check check (grace_minutes >= 0),
  constraint inpatient_charge_rules_price_check check (price_snapshot >= 0),
  -- 默认规则(room_type)与覆盖规则(cage_id)至少其一
  constraint inpatient_charge_rules_target_check check (room_type is not null or cage_id is not null)
);

-- 同租户门店下:room_type 默认规则唯一;cage_id 覆盖规则唯一(仅 active 参与唯一)
create unique index if not exists idx_charge_rules_tenant_store_room_type
  on public.inpatient_charge_rules (tenant_id, store_id, room_type)
  where room_type is not null and cage_id is null and status = 'active';
create unique index if not exists idx_charge_rules_tenant_store_cage
  on public.inpatient_charge_rules (tenant_id, store_id, cage_id)
  where cage_id is not null and status = 'active';
create index if not exists idx_charge_rules_tenant_store
  on public.inpatient_charge_rules (tenant_id, store_id);

drop trigger if exists trg_inpatient_charge_rules_updated_at on public.inpatient_charge_rules;
create trigger trg_inpatient_charge_rules_updated_at
  before update on public.inpatient_charge_rules
  for each row execute procedure public.touch_updated_at();

-- ===== 2. inpatient_charge_periods 表(计费周期) =====
create table if not exists public.inpatient_charge_periods (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete cascade,
  source_type text not null,                         -- inpatient / boarding
  admission_id uuid,                                 -- 住院(跨 migration 不加 FK)
  boarding_stay_id uuid,                             -- 寄养(跨 migration 不加 FK)
  catalog_item_id uuid,                              -- 跨 migration 不加 FK
  description text,
  billing_period text not null,                      -- 计费周期标识(自然日 YYYY-MM-DD;换房分段 YYYY-MM-DD HH24:MI~)
  period_start timestamptz not null,                 -- 周期开始
  period_end timestamptz,                            -- 周期结束(空 = 当前开放周期)
  unit_price numeric(12,2) not null default 0,       -- 价格快照
  amount numeric(12,2) not null default 0,
  invoice_line_id uuid,                              -- 跨 migration 不加 FK(invoice_lines.id)
  idempotency_key text,
  created_at timestamptz not null default now(),

  constraint inpatient_charge_periods_source_check check (source_type in ('inpatient', 'boarding')),
  constraint inpatient_charge_periods_amount_check check (amount >= 0),
  -- 住院周期必须带 admission_id;寄养周期必须带 boarding_stay_id(互斥)
  constraint inpatient_charge_periods_source_target_check check (
    (source_type = 'inpatient' and admission_id is not null and boarding_stay_id is null)
    or (source_type = 'boarding' and boarding_stay_id is not null and admission_id is null)
  )
);

-- 幂等键:住院 (admission_id, catalog_item_id, billing_period);寄养 (boarding_stay_id, catalog_item_id, billing_period)
create unique index if not exists idx_charge_periods_inpatient_idem
  on public.inpatient_charge_periods (admission_id, catalog_item_id, billing_period)
  where source_type = 'inpatient' and catalog_item_id is not null;
create unique index if not exists idx_charge_periods_boarding_idem
  on public.inpatient_charge_periods (boarding_stay_id, catalog_item_id, billing_period)
  where source_type = 'boarding' and catalog_item_id is not null;
-- 同一来源同时最多一个开放周期(period_end is null),用于换房分段截断
create unique index if not exists idx_charge_periods_inpatient_open
  on public.inpatient_charge_periods (admission_id)
  where source_type = 'inpatient' and period_end is null;
create unique index if not exists idx_charge_periods_boarding_open
  on public.inpatient_charge_periods (boarding_stay_id)
  where source_type = 'boarding' and period_end is null;
create index if not exists idx_charge_periods_tenant_store
  on public.inpatient_charge_periods (tenant_id, store_id, period_start desc);
create index if not exists idx_charge_periods_idempotency
  on public.inpatient_charge_periods (idempotency_key);

-- ===== 3. RLS(随 inpatient / boarding 域) =====
alter table public.inpatient_charge_rules enable row level security;
alter table public.inpatient_charge_periods enable row level security;

-- 规则:读须 inpatient.view 或 boarding.view
drop policy if exists "inpatient_charge_rules_select" on public.inpatient_charge_rules;
create policy "inpatient_charge_rules_select" on public.inpatient_charge_rules
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and (
      public.has_permission(tenant_id, store_id, 'inpatient.view')
      or public.has_permission(tenant_id, store_id, 'boarding.view')
    )
  );

drop policy if exists "inpatient_charge_rules_insert" on public.inpatient_charge_rules;
create policy "inpatient_charge_rules_insert" on public.inpatient_charge_rules
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and (
      public.has_permission(tenant_id, store_id, 'inpatient.admit')
      or public.has_permission(tenant_id, store_id, 'boarding.manage')
    )
  );

drop policy if exists "inpatient_charge_rules_update" on public.inpatient_charge_rules;
create policy "inpatient_charge_rules_update" on public.inpatient_charge_rules
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and (
      public.has_permission(tenant_id, store_id, 'inpatient.admit')
      or public.has_permission(tenant_id, store_id, 'boarding.manage')
    )
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and (
      public.has_permission(tenant_id, store_id, 'inpatient.admit')
      or public.has_permission(tenant_id, store_id, 'boarding.manage')
    )
  );

drop policy if exists "inpatient_charge_rules_delete" on public.inpatient_charge_rules;
create policy "inpatient_charge_rules_delete" on public.inpatient_charge_rules
  for delete to authenticated
  using (
    public.is_system_admin()
    and public.can_access_store(tenant_id, store_id)
  );

-- 周期:读须 inpatient.view 或 boarding.view;写由 security definer RPC 完成(直连仅系统管理员)
drop policy if exists "inpatient_charge_periods_select" on public.inpatient_charge_periods;
create policy "inpatient_charge_periods_select" on public.inpatient_charge_periods
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and (
      public.has_permission(tenant_id, store_id, 'inpatient.view')
      or public.has_permission(tenant_id, store_id, 'boarding.view')
    )
  );

drop policy if exists "inpatient_charge_periods_delete" on public.inpatient_charge_periods;
create policy "inpatient_charge_periods_delete" on public.inpatient_charge_periods
  for delete to authenticated
  using (
    public.is_system_admin()
    and public.can_access_store(tenant_id, store_id)
  );

-- ===== 4. boarding_service_charges 增加基础房费标记列 =====
-- is_base_rate=true 的行 = 逐日自动房费(寄养基础房费);false/null = 手动额外服务费
alter table public.boarding_service_charges
  add column if not exists is_base_rate boolean not null default false;

-- 自动房费幂等键:同 stay 同日期同项目不重复生成
create unique index if not exists idx_boarding_service_charges_auto_idem
  on public.boarding_service_charges (boarding_stay_id, charge_date, catalog_item_id)
  where is_base_rate = true and catalog_item_id is not null;

-- ===== 5. resolve_charge_rule 辅助函数(规则解析) =====
-- 解析笼位适用计费规则与价格快照,优先级:
--   cage_id 覆盖规则 → room_type 默认规则 → cages.daily_rate 兜底(以 cage.id 占位 catalog_item_id)
create or replace function public.resolve_charge_rule(
  p_tenant_id uuid,
  p_store_id uuid,
  p_cage_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cage public.cages;
  v_room public.rooms;
  v_rule public.inpatient_charge_rules;
  v_catalog_item_id uuid;
  v_unit_price numeric(12,2);
  v_name text;
begin
  select * into v_cage from public.cages where id = p_cage_id;
  if v_cage is null then
    return jsonb_build_object('catalogItemId', null, 'unitPrice', 0, 'name', null, 'ruleFound', false);
  end if;

  -- 1) cage_id 覆盖规则(优先)
  select * into v_rule from public.inpatient_charge_rules
  where tenant_id = p_tenant_id and store_id = p_store_id
    and cage_id = p_cage_id and status = 'active'
  limit 1;

  -- 2) room_type 默认规则
  if v_rule is null then
    select * into v_room from public.rooms where id = v_cage.room_id;
    if v_room is not null then
      select * into v_rule from public.inpatient_charge_rules
      where tenant_id = p_tenant_id and store_id = p_store_id
        and room_type = v_room.room_type and cage_id is null and status = 'active'
      limit 1;
    end if;
  end if;

  if v_rule is not null then
    v_catalog_item_id := v_rule.catalog_item_id;
    v_unit_price := v_rule.price_snapshot;
    v_name := v_rule.name;
  else
    -- 3) 兜底:笼位日费率(cage.id 作为 catalog_item_id 占位,兼容唯一索引幂等)
    v_catalog_item_id := v_cage.id;
    v_unit_price := v_cage.daily_rate;
    v_name := '笼位费 - ' || coalesce(v_cage.name, v_cage.code);
  end if;

  -- 规则存在但未绑定收费项目时,同样以 cage.id 占位保证幂等
  if v_catalog_item_id is null then
    v_catalog_item_id := v_cage.id;
  end if;

  return jsonb_build_object(
    'catalogItemId', v_catalog_item_id,
    'unitPrice', v_unit_price,
    'name', v_name,
    'ruleFound', v_rule is not null,
    'cageDailyRate', v_cage.daily_rate
  );
end;
$$;

-- ===== 6. run_daily_billing RPC(日切自动计费) =====
-- 对在住住院(admitted)与在养寄养(checked_in/in_service/checkout_pending)按自然日逐日生成费用
-- 幂等:inpatient_charges 唯一键 / boarding_service_charges 自动房费唯一键 / periods 幂等键,重复执行不增行
create or replace function public.run_daily_billing(
  p_target_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_date date := coalesce(p_target_date, current_date);
  v_admission record;
  v_stay record;
  v_rule jsonb;
  v_catalog_item_id uuid;
  v_unit_price numeric(12,2);
  v_name text;
  v_begin_date date;
  v_cur_date date;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_inpatient_count integer := 0;
  v_boarding_count integer := 0;
begin
  -- ===== 1) 住院日费(admitted) =====
  for v_admission in
    select a.id, a.tenant_id, a.store_id, a.cage_id, a.admitted_at
    from public.admissions a
    where a.status = 'admitted'
  loop
    -- 自上次已生成日期的次日开始(首次从入院日起),避免重复扫描历史
    select coalesce(max(billing_period::date) + 1, (v_admission.admitted_at at time zone 'Asia/Shanghai')::date)
      into v_begin_date
    from public.inpatient_charge_periods
    where source_type = 'inpatient' and admission_id = v_admission.id;

    v_begin_date := greatest(v_begin_date, (v_admission.admitted_at at time zone 'Asia/Shanghai')::date);
    if v_begin_date > v_target_date then
      continue;
    end if;

    v_rule := public.resolve_charge_rule(v_admission.tenant_id, v_admission.store_id, v_admission.cage_id);
    v_unit_price := (v_rule->>'unitPrice')::numeric(12,2);
    v_catalog_item_id := nullif(v_rule->>'catalogItemId', '')::uuid;
    v_name := coalesce(v_rule->>'name', '笼位费');
    -- 无规则且笼位费率为 0 时跳过(无需计费)
    if v_unit_price = 0 then
      continue;
    end if;

    v_cur_date := v_begin_date;
    while v_cur_date <= v_target_date loop
      v_period_start := (v_cur_date::timestamp at time zone 'Asia/Shanghai');
      v_period_end := v_period_start + interval '1 day' - interval '1 second';

      -- 幂等插入费用行
      insert into public.inpatient_charges (
        tenant_id, store_id, admission_id, charge_date,
        catalog_item_id, description, quantity, unit_price, amount, is_auto
      )
      values (
        v_admission.tenant_id, v_admission.store_id, v_admission.id, v_cur_date,
        v_catalog_item_id, v_name, 1, v_unit_price, v_unit_price, true
      )
      on conflict (admission_id, charge_date, catalog_item_id)
      where catalog_item_id is not null
      do nothing;

      if found then
        v_inpatient_count := v_inpatient_count + 1;
      end if;

      -- period 记录(幂等键 (admission_id, catalog_item_id, billing_period))
      insert into public.inpatient_charge_periods (
        tenant_id, store_id, source_type, admission_id, catalog_item_id,
        description, billing_period, period_start, period_end, unit_price, amount, idempotency_key
      )
      values (
        v_admission.tenant_id, v_admission.store_id, 'inpatient', v_admission.id, v_catalog_item_id,
        v_name, to_char(v_cur_date, 'YYYY-MM-DD'), v_period_start, v_period_end, v_unit_price, v_unit_price,
        'daily:' || v_admission.id || ':' || to_char(v_cur_date, 'YYYY-MM-DD')
      )
      on conflict (admission_id, catalog_item_id, billing_period)
      where source_type = 'inpatient' and catalog_item_id is not null
      do nothing;

      v_cur_date := v_cur_date + 1;
    end loop;
  end loop;

  -- ===== 2) 寄养基础房费(在养状态) =====
  for v_stay in
    select s.id, s.tenant_id, s.store_id, s.cage_id, s.check_in_at
    from public.boarding_stays s
    where s.status in ('checked_in', 'in_service', 'checkout_pending')
      and s.cage_id is not null
  loop
    -- 自上次已生成日期的次日开始(首次从入住日起)
    select coalesce(max(billing_period::date) + 1, (v_stay.check_in_at at time zone 'Asia/Shanghai')::date)
      into v_begin_date
    from public.inpatient_charge_periods
    where source_type = 'boarding' and boarding_stay_id = v_stay.id;

    v_begin_date := greatest(v_begin_date, (v_stay.check_in_at at time zone 'Asia/Shanghai')::date);
    if v_begin_date > v_target_date then
      continue;
    end if;

    v_rule := public.resolve_charge_rule(v_stay.tenant_id, v_stay.store_id, v_stay.cage_id);
    v_unit_price := (v_rule->>'unitPrice')::numeric(12,2);
    v_catalog_item_id := nullif(v_rule->>'catalogItemId', '')::uuid;
    v_name := coalesce(v_rule->>'name', '寄养房费');
    if v_unit_price = 0 then
      continue;
    end if;

    v_cur_date := v_begin_date;
    while v_cur_date <= v_target_date loop
      v_period_start := (v_cur_date::timestamp at time zone 'Asia/Shanghai');
      v_period_end := v_period_start + interval '1 day' - interval '1 second';

      -- 幂等插入寄养房费行(is_base_rate=true)
      insert into public.boarding_service_charges (
        tenant_id, store_id, boarding_stay_id, catalog_item_id,
        description, quantity, unit_price, amount, charge_date, is_base_rate
      )
      values (
        v_stay.tenant_id, v_stay.store_id, v_stay.id, v_catalog_item_id,
        v_name, 1, v_unit_price, v_unit_price, v_cur_date, true
      )
      on conflict (boarding_stay_id, charge_date, catalog_item_id)
      where is_base_rate = true and catalog_item_id is not null
      do nothing;

      if found then
        v_boarding_count := v_boarding_count + 1;
      end if;

      -- period 记录(幂等键 (boarding_stay_id, catalog_item_id, billing_period))
      insert into public.inpatient_charge_periods (
        tenant_id, store_id, source_type, boarding_stay_id, catalog_item_id,
        description, billing_period, period_start, period_end, unit_price, amount, idempotency_key
      )
      values (
        v_stay.tenant_id, v_stay.store_id, 'boarding', v_stay.id, v_catalog_item_id,
        v_name, to_char(v_cur_date, 'YYYY-MM-DD'), v_period_start, v_period_end, v_unit_price, v_unit_price,
        'daily:' || v_stay.id || ':' || to_char(v_cur_date, 'YYYY-MM-DD')
      )
      on conflict (boarding_stay_id, catalog_item_id, billing_period)
      where source_type = 'boarding' and catalog_item_id is not null
      do nothing;

      v_cur_date := v_cur_date + 1;
    end loop;
  end loop;

  return jsonb_build_object(
    'targetDate', v_target_date,
    'generatedInpatientCount', v_inpatient_count,
    'generatedBoardingCount', v_boarding_count
  );
end;
$$;

-- ===== 7. generate_daily_charges 兼容委托(旧调用方继续可用) =====
create or replace function public.generate_daily_charges(
  p_target_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_inpatient_count integer;
begin
  v_result := public.run_daily_billing(p_target_date);
  v_inpatient_count := (v_result->>'generatedInpatientCount')::integer;
  return jsonb_build_object(
    'targetDate', v_result->>'targetDate',
    'generatedCount', v_inpatient_count,
    'generatedBoardingCount', v_result->>'generatedBoardingCount'
  );
end;
$$;

-- ===== 8. billing_close_and_open_period 辅助函数(换房分段) =====
-- 关闭来源当前开放周期(如有),并按新笼位规则/价格快照开启新开放周期
create or replace function public.billing_close_and_open_period(
  p_tenant_id uuid,
  p_store_id uuid,
  p_source_type text,
  p_source_id uuid,
  p_cage_id uuid,
  p_closed_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rule jsonb;
  v_catalog_item_id uuid;
  v_unit_price numeric(12,2);
  v_name text;
begin
  -- 1) 关闭当前开放周期(如有)
  if p_source_type = 'inpatient' then
    update public.inpatient_charge_periods
    set period_end = p_closed_at
    where source_type = 'inpatient' and admission_id = p_source_id and period_end is null;
  else
    update public.inpatient_charge_periods
    set period_end = p_closed_at
    where source_type = 'boarding' and boarding_stay_id = p_source_id and period_end is null;
  end if;

  -- 2) 按新笼位解析规则与价格快照
  v_rule := public.resolve_charge_rule(p_tenant_id, p_store_id, p_cage_id);
  v_unit_price := (v_rule->>'unitPrice')::numeric(12,2);
  v_catalog_item_id := nullif(v_rule->>'catalogItemId', '')::uuid;
  v_name := coalesce(v_rule->>'name', '笼位费');
  if v_catalog_item_id is null then
    v_catalog_item_id := p_cage_id;
  end if;

  -- 3) 开启新开放周期(billing_period 带时间戳,避免同日内多次换房冲突)
  if p_source_type = 'inpatient' then
    insert into public.inpatient_charge_periods (
      tenant_id, store_id, source_type, admission_id, catalog_item_id,
      description, billing_period, period_start, period_end, unit_price, amount, idempotency_key
    )
    values (
      p_tenant_id, p_store_id, 'inpatient', p_source_id, v_catalog_item_id,
      v_name, to_char(p_closed_at, 'YYYY-MM-DD HH24:MI"~"'), p_closed_at, null, v_unit_price, 0,
      'period:' || p_source_id || ':' || p_closed_at::text
    )
    on conflict (admission_id, catalog_item_id, billing_period)
    where source_type = 'inpatient' and catalog_item_id is not null
    do nothing;
  else
    insert into public.inpatient_charge_periods (
      tenant_id, store_id, source_type, boarding_stay_id, catalog_item_id,
      description, billing_period, period_start, period_end, unit_price, amount, idempotency_key
    )
    values (
      p_tenant_id, p_store_id, 'boarding', p_source_id, v_catalog_item_id,
      v_name, to_char(p_closed_at, 'YYYY-MM-DD HH24:MI"~"'), p_closed_at, null, v_unit_price, 0,
      'period:' || p_source_id || ':' || p_closed_at::text
    )
    on conflict (boarding_stay_id, catalog_item_id, billing_period)
    where source_type = 'boarding' and catalog_item_id is not null
    do nothing;
  end if;
end;
$$;

-- ===== 9. transfer_cage 换房分段计费(覆盖 migration 21 版本) =====
-- 在原换房逻辑基础上:截断当前开放 period → 生成当日费用(旧笼费率)→ 更新笼位 → 新笼开新 period
create or replace function public.transfer_cage(
  p_admission_id uuid,
  p_new_cage_id uuid,
  p_reason text default null,
  p_operator_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admission public.admissions;
  v_old_cage public.cages;
  v_new_cage public.cages;
  v_existing jsonb;
  v_transfer public.cage_transfers;
begin
  -- 幂等检查
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where idempotency_key = p_idempotency_key
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  -- 锁定住院记录
  select * into v_admission from public.admissions
  where id = p_admission_id
  for update;
  if not found then
    raise exception 'ADMISSION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_admission.status <> 'admitted' then
    raise exception 'ADMISSION_NOT_ADMITTED' using errcode = 'P0003';
  end if;

  -- 锁定旧笼位
  select * into v_old_cage from public.cages
  where id = v_admission.cage_id
  for update;
  if not found then
    raise exception 'OLD_CAGE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 锁定新笼位
  select * into v_new_cage from public.cages
  where id = p_new_cage_id and tenant_id = v_admission.tenant_id and store_id = v_admission.store_id
  for update;
  if not found then
    raise exception 'NEW_CAGE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_new_cage.status <> 'available' then
    raise exception 'NEW_CAGE_NOT_AVAILABLE' using errcode = 'P0003';
  end if;
  if v_new_cage.id = v_old_cage.id then
    raise exception 'SAME_CAGE' using errcode = 'P0003';
  end if;

  -- ===== 换房分段计费(新增) =====
  -- 1) 生成截至今日的费用(此时 admission.cage_id 仍为旧笼,按旧笼费率/规则)
  perform public.run_daily_billing(current_date);
  -- 2) 截断当前开放周期 + 为新笼开启新开放周期(旧笼费率已固化在已生成行中)
  perform public.billing_close_and_open_period(
    v_admission.tenant_id, v_admission.store_id, 'inpatient', p_admission_id, p_new_cage_id, now()
  );

  -- 更新住院记录的笼位
  update public.admissions
  set cage_id = p_new_cage_id,
      updated_at = now()
  where id = p_admission_id;

  -- 释放旧笼位
  update public.cages
  set status = 'available',
      current_admission_id = null,
      updated_at = now()
  where id = v_old_cage.id;

  -- 占用新笼位
  update public.cages
  set status = 'occupied',
      current_admission_id = p_admission_id,
      updated_at = now()
  where id = p_new_cage_id;

  -- 写入换房历史
  insert into public.cage_transfers (
    tenant_id, store_id, admission_id, from_cage_id, to_cage_id, reason, operator_id
  )
  values (
    v_admission.tenant_id, v_admission.store_id, p_admission_id,
    v_old_cage.id, p_new_cage_id, p_reason, p_operator_id
  )
  returning * into v_transfer;

  -- 记录幂等结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (v_admission.tenant_id, p_idempotency_key, 'transfer_cage', 'cage_transfer', v_transfer.id, jsonb_build_object(
      'transferId', v_transfer.id,
      'admissionId', p_admission_id,
      'fromCageId', v_old_cage.id,
      'toCageId', p_new_cage_id
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'transferId', v_transfer.id,
    'admissionId', p_admission_id,
    'fromCageId', v_old_cage.id,
    'toCageId', p_new_cage_id
  );
end;
$$;

-- ===== 10. boarding_change_cage 换笼位分段计费(覆盖 migration 71 版本) =====
create or replace function public.boarding_change_cage(
  p_stay_id uuid,
  p_new_cage_id uuid,
  p_reason text default null,
  p_operator_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stay public.boarding_stays;
  v_old_cage public.cages;
  v_new_cage public.cages;
  v_existing jsonb;
  v_was_checked_in boolean;
begin
  -- 幂等检查
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where idempotency_key = p_idempotency_key
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  select * into v_stay from public.boarding_stays
  where id = p_stay_id
  for update;
  if not found then
    raise exception 'BOARDING_STAY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_stay.status in ('checked_out', 'cancelled') then
    raise exception 'BOARDING_NOT_CHANGEABLE' using errcode = 'P0003';
  end if;

  -- 锁定旧笼
  select * into v_old_cage from public.cages
  where id = v_stay.cage_id and tenant_id = v_stay.tenant_id and store_id = v_stay.store_id
  for update;
  if not found then
    raise exception 'OLD_CAGE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 锁定新笼,校验可用
  select * into v_new_cage from public.cages
  where id = p_new_cage_id and tenant_id = v_stay.tenant_id and store_id = v_stay.store_id
  for update;
  if not found then
    raise exception 'NEW_CAGE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_new_cage.id = v_old_cage.id then
    raise exception 'SAME_CAGE' using errcode = 'P0003';
  end if;
  if v_new_cage.status <> 'available' then
    raise exception 'NEW_CAGE_NOT_AVAILABLE' using errcode = 'P0003';
  end if;

  v_was_checked_in := v_stay.status in ('checked_in', 'in_service', 'checkout_pending');

  -- ===== 换笼位分段计费(新增,仅已入住寄养单) =====
  if v_was_checked_in then
    -- 1) 生成截至今日的房费(此时 stay.cage_id 仍为旧笼,按旧笼费率/规则)
    perform public.run_daily_billing(current_date);
    -- 2) 截断当前开放周期 + 为新笼开启新开放周期
    perform public.billing_close_and_open_period(
      v_stay.tenant_id, v_stay.store_id, 'boarding', p_stay_id, p_new_cage_id, now()
    );
  end if;

  -- 更新寄养单笼位
  update public.boarding_stays
  set cage_id = p_new_cage_id, updated_at = now()
  where id = p_stay_id;

  -- 释放旧笼(仅当旧笼确实被该寄养单占用)
  if v_old_cage.current_boarding_stay_id = v_stay.id then
    update public.cages
    set status = 'available',
        current_boarding_stay_id = null,
        updated_at = now()
    where id = v_old_cage.id;
  end if;

  -- 已入住的寄养单占用新笼
  if v_was_checked_in then
    update public.cages
    set status = 'occupied',
        current_boarding_stay_id = p_stay_id,
        updated_at = now()
    where id = p_new_cage_id;
  end if;

  -- 记录幂等结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (v_stay.tenant_id, p_idempotency_key, 'boarding_change_cage', 'boarding_stay', p_stay_id, jsonb_build_object(
      'stayId', p_stay_id,
      'fromCageId', v_old_cage.id,
      'toCageId', p_new_cage_id
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'stayId', p_stay_id,
    'boardingNo', v_stay.boarding_no,
    'fromCageId', v_old_cage.id,
    'toCageId', p_new_cage_id
  );
end;
$$;

-- ===== 11. boarding_prepare_checkout 复用 periods 汇总(覆盖 migration 73 版本) =====
-- 寄养基础房费已由 run_daily_billing 逐日入账,此处先补齐当日再按 is_base_rate 汇总
create or replace function public.boarding_prepare_checkout(
  p_stay_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stay public.boarding_stays;
  v_daily_amount numeric(12,2) := 0;
  v_service_amount numeric(12,2) := 0;
  v_total numeric(12,2) := 0;
  v_days integer := 0;
begin
  select * into v_stay from public.boarding_stays
  where id = p_stay_id
  for update;
  if not found then
    raise exception 'BOARDING_STAY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_stay.status not in ('checked_in', 'in_service', 'checkout_pending') then
    raise exception 'BOARDING_NOT_CHECKOUT_ABLE' using errcode = 'P0003';
  end if;

  -- 1) 补齐截至今日的逐日房费(run_daily_billing 幂等,重复调用不会重复计费)
  perform public.run_daily_billing(current_date);

  -- 2) 汇总:基础房费(is_base_rate=true) + 额外服务费(is_base_rate=false)
  select coalesce(sum(amount), 0), count(distinct charge_date)
    into v_daily_amount, v_days
  from public.boarding_service_charges
  where boarding_stay_id = p_stay_id and is_base_rate = true;

  select coalesce(sum(amount), 0) into v_service_amount
  from public.boarding_service_charges
  where boarding_stay_id = p_stay_id and is_base_rate = false;

  v_total := v_daily_amount + v_service_amount;

  update public.boarding_stays
  set status = 'checkout_pending', updated_at = now()
  where id = p_stay_id
  returning * into v_stay;

  return jsonb_build_object(
    'stayId', v_stay.id,
    'boardingNo', v_stay.boarding_no,
    'stayDays', v_days,
    'dailyAmount', v_daily_amount,
    'serviceAmount', v_service_amount,
    'totalCharge', v_total,
    'status', v_stay.status
  );
end;
$$;

-- ===== 12. boarding_checkout 复用 periods 汇总(覆盖 migration 91 版本) =====
-- 在 migration 91(Invoice 原子集成)基础上,日费汇总改为逐日入账的 boarding_service_charges
create or replace function public.boarding_checkout(
  p_stay_id uuid,
  p_operator_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stay public.boarding_stays;
  v_cage public.cages;
  v_daily_amount numeric(12,2) := 0;
  v_service_amount numeric(12,2) := 0;
  v_total numeric(12,2) := 0;
  v_days integer := 0;
  v_existing jsonb;
  v_items jsonb := '[]'::jsonb;
  v_item jsonb;
  v_invoice jsonb;
  v_invoice_id uuid;
begin
  -- 幂等检查(先于发票创建,避免重试重复计费)
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where idempotency_key = p_idempotency_key
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  select * into v_stay from public.boarding_stays
  where id = p_stay_id
  for update;
  if not found then
    raise exception 'BOARDING_STAY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_stay.status not in ('checked_in', 'in_service', 'checkout_pending') then
    raise exception 'BOARDING_NOT_CHECKOUT_ABLE' using errcode = 'P0003';
  end if;

  select * into v_cage from public.cages
  where id = v_stay.cage_id
  for update;

  -- 1) 补齐截至今日的逐日房费
  perform public.run_daily_billing(current_date);

  -- 2) 汇总:基础房费 + 额外服务费(复用 periods/charges,不再按 cage.daily_rate 一次性补算)
  select coalesce(sum(amount), 0), count(distinct charge_date)
    into v_daily_amount, v_days
  from public.boarding_service_charges
  where boarding_stay_id = p_stay_id and is_base_rate = true;

  select coalesce(sum(amount), 0) into v_service_amount
  from public.boarding_service_charges
  where boarding_stay_id = p_stay_id and is_base_rate = false;

  v_total := v_daily_amount + v_service_amount;

  -- 集成点:同一事务内创建 Billing Invoice(失败整体回滚)
  if v_total > 0 then
    -- 笼位日费行(手工行,不依赖 catalog 预置)
    if v_daily_amount > 0 then
      v_items := v_items || jsonb_build_object(
        'name', '寄养日费(笼位)',
        'unit_price', v_daily_amount,
        'quantity', 1,
        'amount', v_daily_amount,
        'category', 'service'
      );
    end if;
    -- 额外服务费逐条(amount = unit_price × 1,保证过 create_invoice 金额校验)
    for v_item in select jsonb_build_object(
        'name', coalesce(sc.description, '寄养服务费'),
        'catalog_item_id', sc.catalog_item_id,
        'unit_price', sc.amount,
        'quantity', 1,
        'amount', sc.amount,
        'category', 'service'
      )
      from public.boarding_service_charges sc
      where sc.boarding_stay_id = p_stay_id and sc.is_base_rate = false
      order by sc.created_at
    loop
      v_items := v_items || v_item;
    end loop;

    v_invoice := public.create_invoice(
      v_stay.tenant_id,
      v_stay.store_id,
      v_stay.customer_id,
      v_stay.pet_id,
      null,                       -- p_encounter_id
      v_items,
      0,                          -- p_discount_amount(寄养不参与审批阈值)
      null,                       -- p_discount_reason
      0,                          -- p_tax_amount
      null,                       -- p_payment_method(发票生成,支付另行处理)
      null,                       -- p_due_date
      p_operator_id,
      false                       -- p_apply_membership_discount(寄养不套会员折扣)
    );
    v_invoice_id := (v_invoice->>'invoiceId')::uuid;
    if v_invoice_id is null then
      raise exception 'BOARDING_INVOICE_FAILED' using errcode = 'P0003';
    end if;
  end if;

  update public.boarding_stays
  set status = 'checked_out',
      checked_out_at = now(),
      total_charge = v_total,
      updated_at = now()
  where id = p_stay_id
  returning * into v_stay;

  -- 释放笼位
  if v_cage is not null and v_cage.current_boarding_stay_id = p_stay_id then
    update public.cages
    set status = 'available',
        current_boarding_stay_id = null,
        updated_at = now()
    where id = v_cage.id;
  end if;

  -- 记录幂等结果(含 invoiceId)
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (v_stay.tenant_id, p_idempotency_key, 'boarding_checkout', 'boarding_stay', p_stay_id, jsonb_build_object(
      'stayId', p_stay_id,
      'boardingNo', v_stay.boarding_no,
      'status', v_stay.status,
      'totalCharge', v_total,
      'invoiceId', v_invoice_id,
      'checkedOutAt', v_stay.checked_out_at
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'stayId', p_stay_id,
    'boardingNo', v_stay.boarding_no,
    'stayDays', v_days,
    'dailyAmount', v_daily_amount,
    'serviceAmount', v_service_amount,
    'totalCharge', v_total,
    'invoiceId', v_invoice_id,
    'status', v_stay.status,
    'checkedOutAt', v_stay.checked_out_at
  );
end;
$$;

-- ===== 13. pg_cron 每日日切调度(可用时注册;不可用静默跳过,由 Hono API 手动触发兜底) =====
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- 每日 00:10 执行日切计费(幂等:cron.job 按 jobname 唯一)
    if not exists (select 1 from cron.job where jobname = 'run-daily-billing') then
      -- 注意:外层 do 块内嵌套字符串须用其他定界符,避免提前闭合
      perform cron.schedule('run-daily-billing', '10 0 * * *', $cron$select public.run_daily_billing(null)$cron$);
    end if;
  end if;
exception when others then
  -- 平台未启用 pg_cron 或无 cron schema 权限:静默跳过,不影响迁移
  null;
end;
$$;

-- ===== 14. RPC 权限收紧(自包含,幂等;与 migration 92 service-role-only 模式一致) =====
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    'run_daily_billing', 'generate_daily_charges', 'resolve_charge_rule',
    'billing_close_and_open_period', 'transfer_cage', 'boarding_change_cage',
    'boarding_prepare_checkout', 'boarding_checkout'
  ]
  loop
    for v_sig in
      select p.oid::regprocedure::text
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = v_fn
        and p.prokind = 'f'
    loop
      execute format('revoke all on function %s from public', v_sig);
      execute format('revoke all on function %s from anon', v_sig);
      execute format('revoke all on function %s from authenticated', v_sig);
      execute format('grant execute on function %s to service_role', v_sig);
    end loop;
  end loop;
end;
$$;

-- ===== 15. 结束 =====
