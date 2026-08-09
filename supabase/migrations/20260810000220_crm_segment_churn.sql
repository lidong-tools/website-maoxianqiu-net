-- ============================================================
-- 20260810000220_crm_segment_churn.sql
-- Agent-05 CRM Growth & Marketing: 客户分层 + 流失预警
--   - customer_segment_definitions    分层规则定义(rule_json 可解释规则)
--   - customer_segment_memberships    物化成员(Snapshot,可定期重算)
--   - customer_risk_scores            流失风险评分(规则 + Score,可解释)
--   - customer_profile_snapshot()     客户维度快照(单一计算源)
--   - evaluate_customer_segments()    单客户实时评估 Segment + explanation
--   - compute_customer_churn()        单客户流失评分 + explanation
--   - refresh_segment_memberships()   批量重算 Segment 成员
--   - refresh_churn_scores()          批量重算流失评分
-- 原则:
--   - 规则可解释,禁止黑盒
--   - Churn 默认 Tenant-wide(客户是 Tenant 级关系,不因当前门店误判)
--   - 只读聚合现有业务表,不新建 customer_behavior_events
-- 权限:
--   crm.segment.view / crm.segment.manage / crm.churn.view
-- ============================================================
set search_path = public;

-- ===== 1. customer_segment_definitions 表 =====
create table if not exists public.customer_segment_definitions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  name text not null,
  description text,
  rule_json jsonb not null default '{"logic":"and","conditions":[]}'::jsonb,
  priority integer not null default 100,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_segment_defs_tenant_code
  on public.customer_segment_definitions (tenant_id, code);
create index if not exists idx_segment_defs_tenant_active
  on public.customer_segment_definitions (tenant_id, active, priority);

drop trigger if exists trg_segment_defs_updated_at on public.customer_segment_definitions;
create trigger trg_segment_defs_updated_at
  before update on public.customer_segment_definitions
  for each row execute procedure public.touch_updated_at();

-- ===== 2. customer_segment_memberships 表(物化 Snapshot) =====
create table if not exists public.customer_segment_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  segment_id uuid not null,
  customer_id uuid not null,
  score integer not null default 100,
  matched_at timestamptz not null default now(),
  expires_at timestamptz,
  explanation jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_segment_memberships_seg_cust
  on public.customer_segment_memberships (segment_id, customer_id);
create index if not exists idx_segment_memberships_tenant_customer
  on public.customer_segment_memberships (tenant_id, customer_id);
create index if not exists idx_segment_memberships_tenant_segment
  on public.customer_segment_memberships (tenant_id, segment_id);

drop trigger if exists trg_segment_memberships_updated_at on public.customer_segment_memberships;
create trigger trg_segment_memberships_updated_at
  before update on public.customer_segment_memberships
  for each row execute procedure public.touch_updated_at();

-- ===== 3. customer_risk_scores 表(流失风险,可解释) =====
create table if not exists public.customer_risk_scores (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null,
  risk_type text not null default 'churn',
  score integer not null default 0,
  level text not null default 'low',               -- low / medium / high
  explanation jsonb not null default '[]'::jsonb, -- [{text, points}]
  calculated_at timestamptz not null default now(),
  model_version text not null default 'rule-v1',
  created_at timestamptz not null default now()
);

create unique index if not exists idx_risk_scores_tenant_cust_type
  on public.customer_risk_scores (tenant_id, customer_id, risk_type);
create index if not exists idx_risk_scores_tenant_level
  on public.customer_risk_scores (tenant_id, level);

-- ===== 4. 客户维度快照(单一计算源) =====
-- 返回 jsonb 维度,供 Segment 规则与 Churn 评分共用,保证解释一致
create or replace function public.customer_profile_snapshot(
  p_tenant_id uuid,
  p_customer_id uuid,
  p_as_of timestamptz default now()
) returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_snap jsonb;
  v_days_since_created integer;
  v_days_since_last_visit integer;
  v_last_visit timestamptz;
  v_has_completed_followup boolean;
begin
  -- 客户创建天数
  select greatest(0, floor(extract(epoch from (p_as_of - created_at)) / 86400)::int)
    into v_days_since_created
  from public.customers
  where id = p_customer_id and tenant_id = p_tenant_id;

  -- 最近就诊时间(Tenant-wide,不区分门店)
  select max(started_at) into v_last_visit
  from public.encounters
  where customer_id = p_customer_id and tenant_id = p_tenant_id
    and status in ('in_progress', 'completed', 'signed');

  v_days_since_last_visit := case
    when v_last_visit is null then coalesce(v_days_since_created, 9999)
    else greatest(0, floor(extract(epoch from (p_as_of - v_last_visit)) / 86400)::int)
  end;

  select exists (
    select 1 from public.followup_tasks
    where customer_id = p_customer_id and tenant_id = p_tenant_id
      and status = 'completed'
  ) into v_has_completed_followup;

  select jsonb_build_object(
    'recency_days', v_days_since_last_visit,
    'days_since_created', coalesce(v_days_since_created, 9999),
    'visits_total', (
      select count(*)::int from public.encounters
      where customer_id = p_customer_id and tenant_id = p_tenant_id
        and status in ('in_progress', 'completed', 'signed')
    ),
    'visits_last_365', (
      select count(*)::int from public.encounters
      where customer_id = p_customer_id and tenant_id = p_tenant_id
        and status in ('in_progress', 'completed', 'signed')
        and started_at >= p_as_of - interval '365 days'
    ),
    'visits_prev_year', (
      select count(*)::int from public.encounters
      where customer_id = p_customer_id and tenant_id = p_tenant_id
        and status in ('in_progress', 'completed', 'signed')
        and started_at >= p_as_of - interval '730 days'
        and started_at < p_as_of - interval '365 days'
    ),
    'spend_total', (
      select coalesce(sum(total), 0)::numeric(12,2) from public.invoices
      where customer_id = p_customer_id and tenant_id = p_tenant_id
        and status in ('paid', 'partially_paid')
    ),
    'spend_last_365', (
      select coalesce(sum(total), 0)::numeric(12,2) from public.invoices
      where customer_id = p_customer_id and tenant_id = p_tenant_id
        and status in ('paid', 'partially_paid')
        and created_at >= p_as_of - interval '365 days'
    ),
    'pet_count', (
      select count(*)::int from public.pets
      where customer_id = p_customer_id and tenant_id = p_tenant_id
        and status = 'active'
    ),
    'member_tier_code', (
      select mt.code
      from public.customer_memberships cm
      join public.membership_tiers mt on mt.id = cm.tier_id
      where cm.customer_id = p_customer_id and cm.tenant_id = p_tenant_id
      limit 1
    ),
    'member_points', (
      select coalesce(points_balance, 0)::int
      from public.customer_memberships
      where customer_id = p_customer_id and tenant_id = p_tenant_id
      limit 1
    ),
    'vaccination_due', (
      select exists (
        select 1 from public.vaccinations
        where customer_id = p_customer_id and tenant_id = p_tenant_id
          and next_due_date is not null and next_due_date < p_as_of
          and status in ('scheduled', 'overdue')
      )
    ),
    'deworming_due', (
      select exists (
        select 1 from public.deworming_records
        where customer_id = p_customer_id and tenant_id = p_tenant_id
          and next_due_date is not null and next_due_date < p_as_of
          and status = 'scheduled'
      )
    ),
    'no_show_count', (
      select count(*)::int from public.appointments
      where customer_id = p_customer_id and tenant_id = p_tenant_id
        and status = 'no_show'
    ),
    'followup_overdue', (
      select count(*)::int from public.followup_tasks
      where customer_id = p_customer_id and tenant_id = p_tenant_id
        and status = 'pending' and scheduled_at < p_as_of
    ),
    'has_completed_followup', coalesce(v_has_completed_followup, false)
  ) into v_snap;

  return v_snap;
end;
$$;

-- ===== 5. Segment 规则匹配(单条件求值) =====
-- 返回 text(explanation 文案);未命中返回 null
create or replace function public.segment_condition_hit(
  p_snap jsonb,
  p_dim text,
  p_op text,
  p_value jsonb
) returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_num numeric;
  v_str text;
  v_bool boolean;
  v_actual_num numeric;
  v_actual_str text;
  v_label text;
begin
  -- 维度名 → 中文文案
  v_label := case p_dim
    when 'recency_days' then '距最近到院'
    when 'visits_total' then '累计到院次数'
    when 'visits_last_365' then '近一年到院次数'
    when 'spend_total' then '累计消费'
    when 'spend_last_365' then '近一年消费'
    when 'pet_count' then '宠物数量'
    when 'member_tier_code' then '会员等级'
    when 'member_points' then '会员积分'
    when 'vaccination_due' then '疫苗逾期'
    when 'deworming_due' then '驱虫逾期'
    when 'no_show_count' then '爽约次数'
    when 'followup_overdue' then '逾期回访'
    else p_dim
  end;

  v_actual_num := case p_dim
    when 'recency_days' then coalesce((p_snap->>'recency_days')::numeric, -1)
    when 'visits_total' then coalesce((p_snap->>'visits_total')::numeric, 0)
    when 'visits_last_365' then coalesce((p_snap->>'visits_last_365')::numeric, 0)
    when 'spend_total' then coalesce((p_snap->>'spend_total')::numeric, 0)
    when 'spend_last_365' then coalesce((p_snap->>'spend_last_365')::numeric, 0)
    when 'pet_count' then coalesce((p_snap->>'pet_count')::numeric, 0)
    when 'member_points' then coalesce((p_snap->>'member_points')::numeric, 0)
    when 'no_show_count' then coalesce((p_snap->>'no_show_count')::numeric, 0)
    when 'followup_overdue' then coalesce((p_snap->>'followup_overdue')::numeric, 0)
    else null
  end;
  v_actual_str := p_snap->>p_dim;

  if p_dim in ('recency_days', 'visits_total', 'visits_last_365', 'spend_total',
               'spend_last_365', 'pet_count', 'member_points', 'no_show_count', 'followup_overdue') then
    v_num := (p_value::text)::numeric;
    if p_op = 'eq' then
      if v_actual_num = v_num then return v_label || ' = ' || v_num; end if;
    elsif p_op = 'neq' then
      if v_actual_num <> v_num then return v_label || ' ≠ ' || v_num; end if;
    elsif p_op = 'gt' then
      if v_actual_num > v_num then return v_label || ' > ' || v_num; end if;
    elsif p_op = 'gte' then
      if v_actual_num >= v_num then return v_label || ' ≥ ' || v_num; end if;
    elsif p_op = 'lt' then
      if v_actual_num < v_num then return v_label || ' < ' || v_num; end if;
    elsif p_op = 'lte' then
      if v_actual_num <= v_num then return v_label || ' ≤ ' || v_num; end if;
    end if;
    return null;
  elsif p_dim = 'member_tier_code' then
    v_str := p_value ->> 0;
    if v_str is null then
      v_str := btrim(p_value::text, '"');
    end if;
    if p_op = 'eq' then
      if coalesce(v_actual_str, '') = v_str then return v_label || ' = ' || v_str; end if;
    elsif p_op = 'neq' then
      if coalesce(v_actual_str, '') <> v_str then return v_label || ' ≠ ' || v_str; end if;
    end if;
    return null;
  elsif p_dim in ('vaccination_due', 'deworming_due') then
    v_bool := (p_value::text)::boolean;
    if v_actual_str = p_value::text then
      if v_bool then return v_label || '已逾期'; end if;
      return null;
    end if;
    return null;
  end if;

  return null;
end;
$$;

-- ===== 6. evaluate_customer_segments RPC =====
-- 单客户实时评估全部 active Segment,并 upsert 物化成员
-- 返回 {customer_id, segments: [{segment_id, code, name, score, explanation}]}
create or replace function public.evaluate_customer_segments(
  p_tenant_id uuid,
  p_customer_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_snap jsonb;
  v_seg record;
  v_rule jsonb;
  v_cond jsonb;
  v_logic text;
  v_hits text[];
  v_ok boolean;
  v_result jsonb;
begin
  if not exists (
    select 1 from public.customers where id = p_customer_id and tenant_id = p_tenant_id and status = 'active'
  ) then
    raise exception 'CUSTOMER_NOT_FOUND';
  end if;

  v_snap := public.customer_profile_snapshot(p_tenant_id, p_customer_id);
  v_result := jsonb_build_array();

  for v_seg in
    select * from public.customer_segment_definitions
    where tenant_id = p_tenant_id and active = true
    order by priority asc, created_at asc
  loop
    v_rule := v_seg.rule_json;
    v_logic := coalesce(v_rule->>'logic', 'and');
    v_hits := '{}'::text[];
    -- and:默认命中,任一条件不满足即淘汰;or:默认未命中,任一条件满足即入选
    v_ok := (v_logic <> 'or');

    for v_cond in select * from jsonb_array_elements(coalesce(v_rule->'conditions', '[]'::jsonb))
    loop
      declare
        v_text text;
      begin
        v_text := public.segment_condition_hit(
          v_snap,
          coalesce(v_cond->>'dim', ''),
          coalesce(v_cond->>'op', 'eq'),
          coalesce(v_cond->'value', 'null'::jsonb)
        );
        if v_text is not null then
          v_hits := array_append(v_hits, v_text);
          if v_logic = 'or' then
            v_ok := true;
          end if;
        elsif v_logic = 'and' then
          v_ok := false;
        end if;
      end;
    end loop;

    if v_ok then
      -- upsert 物化成员(同一 segment + customer 幂等)
      insert into public.customer_segment_memberships
        (tenant_id, segment_id, customer_id, score, matched_at, explanation)
      values
        (p_tenant_id, v_seg.id, p_customer_id, 100, now(),
         to_jsonb(v_hits))
      on conflict (segment_id, customer_id)
      do update set
        score = 100,
        matched_at = now(),
        explanation = excluded.explanation,
        updated_at = now();

      v_result := v_result || jsonb_build_object(
        'segment_id', v_seg.id,
        'code', v_seg.code,
        'name', v_seg.name,
        'score', 100,
        'explanation', to_jsonb(v_hits)
      );
    else
      -- 未命中则清除旧物化记录
      delete from public.customer_segment_memberships
      where segment_id = v_seg.id and customer_id = p_customer_id;
    end if;
  end loop;

  return jsonb_build_object(
    'customer_id', p_customer_id,
    'segments', v_result
  );
end;
$$;

-- ===== 7. compute_customer_churn RPC =====
-- 单客户流失风险评分(规则 + Score,可解释),upsert 到 customer_risk_scores
-- 规则(Tenant-wide):
--   1. 距最近到院 >60 天 +20;每超 90 天再 +5,封顶 +40
--   2. 近一年 0 次但上一年有就诊 +25
--   3. 累计消费 <300 +10
--   4. 疫苗或驱虫逾期 +15
--   5. 有逾期回访任务 +7
--   6. 爽约 >=2 次 +8
--   7. 新客户(<60 天)且无完成回访 +5
-- level: >=60 high / >=35 medium / else low
create or replace function public.compute_customer_churn(
  p_tenant_id uuid,
  p_customer_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_snap jsonb;
  v_score integer := 0;
  v_expl jsonb := '[]'::jsonb;
  v_level text;
  v_recency integer;
  v_visits_last integer;
  v_visits_prev integer;
  v_spend numeric;
  v_vac_due boolean;
  v_dew_due boolean;
  v_fu_overdue integer;
  v_no_show integer;
  v_days_since_created integer;
  v_has_fu boolean;
begin
  if not exists (
    select 1 from public.customers where id = p_customer_id and tenant_id = p_tenant_id and status = 'active'
  ) then
    raise exception 'CUSTOMER_NOT_FOUND';
  end if;

  v_snap := public.customer_profile_snapshot(p_tenant_id, p_customer_id);
  v_recency := coalesce((v_snap->>'recency_days')::int, 9999);
  v_visits_last := coalesce((v_snap->>'visits_last_365')::int, 0);
  v_visits_prev := coalesce((v_snap->>'visits_prev_year')::int, 0);
  v_spend := coalesce((v_snap->>'spend_total')::numeric, 0);
  v_vac_due := coalesce((v_snap->>'vaccination_due')::boolean, false);
  v_dew_due := coalesce((v_snap->>'deworming_due')::boolean, false);
  v_fu_overdue := coalesce((v_snap->>'followup_overdue')::int, 0);
  v_no_show := coalesce((v_snap->>'no_show_count')::int, 0);
  v_days_since_created := coalesce((v_snap->>'days_since_created')::int, 9999);
  v_has_fu := coalesce((v_snap->>'has_completed_followup')::boolean, false);

  -- 1. Recency
  if v_recency > 60 then
    declare
      v_p integer;
    begin
      v_p := 20 + greatest(0, (v_recency - 90) / 30) * 5;
      if v_p > 40 then v_p := 40; end if;
      v_score := v_score + v_p;
      v_expl := v_expl || jsonb_build_object('text', v_recency || ' 天未到院', 'points', v_p);
    end;
  end if;

  -- 2. 近一年无就诊,上一年有
  if v_visits_last = 0 and v_visits_prev > 0 then
    v_score := v_score + 25;
    v_expl := v_expl || jsonb_build_object('text', '上一年 ' || v_visits_prev || ' 次就诊,近一年 0 次', 'points', 25);
  end if;

  -- 3. 低消费
  if v_spend < 300 then
    v_score := v_score + 10;
    v_expl := v_expl || jsonb_build_object('text', '累计消费仅 ' || v_spend || ' 元', 'points', 10);
  end if;

  -- 4. 疫苗/驱虫逾期
  if v_vac_due then
    v_score := v_score + 15;
    v_expl := v_expl || jsonb_build_object('text', '疫苗已逾期', 'points', 15);
  end if;
  if v_dew_due then
    v_score := v_score + 10;
    v_expl := v_expl || jsonb_build_object('text', '驱虫已逾期', 'points', 10);
  end if;

  -- 5. 逾期回访
  if v_fu_overdue > 0 then
    v_score := v_score + 7;
    v_expl := v_expl || jsonb_build_object('text', '有 ' || v_fu_overdue || ' 条逾期回访未处理', 'points', 7);
  end if;

  -- 6. 爽约
  if v_no_show >= 2 then
    v_score := v_score + 8;
    v_expl := v_expl || jsonb_build_object('text', '爽约 ' || v_no_show || ' 次', 'points', 8);
  end if;

  -- 7. 新客户无回访
  if v_days_since_created < 60 and not v_has_fu then
    v_score := v_score + 5;
    v_expl := v_expl || jsonb_build_object('text', '新客户尚未完成回访', 'points', 5);
  end if;

  if v_score >= 60 then v_level := 'high';
  elsif v_score >= 35 then v_level := 'medium';
  else v_level := 'low';
  end if;

  insert into public.customer_risk_scores
    (tenant_id, customer_id, risk_type, score, level, explanation, calculated_at, model_version)
  values
    (p_tenant_id, p_customer_id, 'churn', v_score, v_level, v_expl, now(), 'rule-v1')
  on conflict (tenant_id, customer_id, risk_type)
  do update set
    score = excluded.score,
    level = excluded.level,
    explanation = excluded.explanation,
    calculated_at = excluded.calculated_at,
    model_version = excluded.model_version;

  return jsonb_build_object(
    'customer_id', p_customer_id,
    'risk_type', 'churn',
    'score', v_score,
    'level', v_level,
    'explanation', v_expl,
    'calculated_at', now(),
    'model_version', 'rule-v1'
  );
end;
$$;

-- ===== 8. refresh_segment_memberships RPC(批量重算) =====
create or replace function public.refresh_segment_memberships(
  p_tenant_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cust record;
  v_count integer := 0;
begin
  for v_cust in
    select id from public.customers
    where tenant_id = p_tenant_id and status = 'active'
  loop
    perform public.evaluate_customer_segments(p_tenant_id, v_cust.id);
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('tenant_id', p_tenant_id, 'evaluated', v_count);
end;
$$;

-- ===== 9. refresh_churn_scores RPC(批量重算) =====
create or replace function public.refresh_churn_scores(
  p_tenant_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cust record;
  v_count integer := 0;
begin
  for v_cust in
    select id from public.customers
    where tenant_id = p_tenant_id and status = 'active'
  loop
    perform public.compute_customer_churn(p_tenant_id, v_cust.id);
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('tenant_id', p_tenant_id, 'evaluated', v_count);
end;
$$;

-- ===== 10. RLS =====
alter table public.customer_segment_definitions enable row level security;
alter table public.customer_segment_memberships enable row level security;
alter table public.customer_risk_scores enable row level security;

-- 读:租户成员
drop policy if exists "segment_defs_select" on public.customer_segment_definitions;
create policy "segment_defs_select" on public.customer_segment_definitions
  for select to authenticated using (public.is_tenant_member(tenant_id));

drop policy if exists "segment_memberships_select" on public.customer_segment_memberships;
create policy "segment_memberships_select" on public.customer_segment_memberships
  for select to authenticated using (public.is_tenant_member(tenant_id));

drop policy if exists "risk_scores_select" on public.customer_risk_scores;
create policy "risk_scores_select" on public.customer_risk_scores
  for select to authenticated using (public.is_tenant_member(tenant_id));

-- 写:服务端 RPC 为准(security definer),直连需 crm.segment.manage
drop policy if exists "segment_defs_insert" on public.customer_segment_definitions;
create policy "segment_defs_insert" on public.customer_segment_definitions
  for insert to authenticated
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'crm.segment.manage'));

drop policy if exists "segment_defs_update" on public.customer_segment_definitions;
create policy "segment_defs_update" on public.customer_segment_definitions
  for update to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'crm.segment.manage'))
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'crm.segment.manage'));

drop policy if exists "segment_defs_delete" on public.customer_segment_definitions;
create policy "segment_defs_delete" on public.customer_segment_definitions
  for delete to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'crm.segment.manage'));

-- ===== 11. 高危 RPC ACL:仅 service_role(前端经 Hono 调用) =====
revoke all on function public.customer_profile_snapshot(uuid, uuid, timestamptz) from public;
revoke all on function public.customer_profile_snapshot(uuid, uuid, timestamptz) from anon;
revoke all on function public.customer_profile_snapshot(uuid, uuid, timestamptz) from authenticated;
grant execute on function public.customer_profile_snapshot(uuid, uuid, timestamptz) to service_role;

revoke all on function public.evaluate_customer_segments(uuid, uuid) from public;
revoke all on function public.evaluate_customer_segments(uuid, uuid) from anon;
revoke all on function public.evaluate_customer_segments(uuid, uuid) from authenticated;
grant execute on function public.evaluate_customer_segments(uuid, uuid) to service_role;

revoke all on function public.compute_customer_churn(uuid, uuid) from public;
revoke all on function public.compute_customer_churn(uuid, uuid) from anon;
revoke all on function public.compute_customer_churn(uuid, uuid) from authenticated;
grant execute on function public.compute_customer_churn(uuid, uuid) to service_role;

revoke all on function public.refresh_segment_memberships(uuid) from public;
revoke all on function public.refresh_segment_memberships(uuid) from anon;
revoke all on function public.refresh_segment_memberships(uuid) from authenticated;
grant execute on function public.refresh_segment_memberships(uuid) to service_role;

revoke all on function public.refresh_churn_scores(uuid) from public;
revoke all on function public.refresh_churn_scores(uuid) from anon;
revoke all on function public.refresh_churn_scores(uuid) from authenticated;
grant execute on function public.refresh_churn_scores(uuid) to service_role;

-- ===== 12. 权限 seed =====
insert into public.permissions (code, name, module) values
  ('crm.segment.view', '查看客户分层', 'crm'),
  ('crm.segment.manage', '管理客户分层', 'crm'),
  ('crm.churn.view', '查看流失预警', 'crm')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code in ('system_admin', 'tenant_owner', 'store_manager')
  and p.code in ('crm.segment.view', 'crm.segment.manage', 'crm.churn.view')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 旧模型兼容:roles.permissions 数组(幂等去重)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array['crm.segment.view', 'crm.segment.manage', 'crm.churn.view'])
)
where code in ('system_admin', 'tenant_owner', 'store_manager') and is_system = true;
