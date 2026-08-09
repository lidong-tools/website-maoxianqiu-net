-- ============================================================
-- 20260810000223_marketing_campaign_referral.sql
-- Agent-05 CRM Growth & Marketing: Campaign + Referral 基础
--   - marketing_campaigns            活动定义(谁/何时/什么 Offer/哪个 Channel)
--   - marketing_campaign_audiences   发布时 Audience Snapshot(可审计)
--   - marketing_campaign_runs        发布运行记录(幂等发布)
--   - referral_codes / referral_events  推荐关系 + 奖励资格
--   - publish_campaign()             计算 Audience + Snapshot + 建 Run
--   - generate_referral_code()       生成/获取推荐码
--   - register_referral()            登记推荐关系(奖励资格)
-- 原则:
--   - Audience 复用 Segment/Risk 物化,禁止第二套 filter 引擎
--   - 发布时 Snapshot customer ids + rule_version,历史可审计
--   - Marketing 不直接发送消息/写 message_deliveries(走 Agent-08 Messaging Contract)
-- 权限:
--   marketing.publish(发布,高于 manage)
-- ============================================================
set search_path = public;

-- ===== 1. marketing_campaigns 表 =====
create table if not exists public.marketing_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  name text not null,
  description text,
  type text not null default 'manual',              -- manual / segment / birthday / churn / referral
  segment_id uuid,                                  -- type=segment 时引用 customer_segment_definitions
  store_id uuid references public.stores(id) on delete set null, -- null=全门店
  offer_type text,                                  -- coupon / package / none
  offer_id uuid,                                    -- coupon_id / package_id
  channel text not null default 'wechat',           -- sms / email / wechat / work_wechat
  message_template_id uuid,                         -- 引用 message_templates(Agent-08 contract 使用)
  starts_at timestamptz,
  ends_at timestamptz,
  status text not null default 'draft',             -- draft / scheduled / published / completed / cancelled
  published_at timestamptz,
  published_by uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaigns_type_check check (type in ('manual', 'segment', 'birthday', 'churn', 'referral')),
  constraint campaigns_offer_check check (offer_type is null or offer_type in ('coupon', 'package', 'none')),
  constraint campaigns_channel_check check (channel in ('sms', 'email', 'wechat', 'work_wechat')),
  constraint campaigns_status_check check (status in ('draft', 'scheduled', 'published', 'completed', 'cancelled')),
  -- segment 类型必须带 segment_id
  constraint campaigns_segment_required check (type <> 'segment' or segment_id is not null)
);

create unique index if not exists idx_campaigns_tenant_code on public.marketing_campaigns (tenant_id, code);
create index if not exists idx_campaigns_tenant_status on public.marketing_campaigns (tenant_id, status);

drop trigger if exists trg_campaigns_updated_at on public.marketing_campaigns;
create trigger trg_campaigns_updated_at
  before update on public.marketing_campaigns
  for each row execute procedure public.touch_updated_at();

-- ===== 2. marketing_campaign_audiences 表(Audience Snapshot) =====
create table if not exists public.marketing_campaign_audiences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  campaign_id uuid not null references public.marketing_campaigns(id) on delete cascade,
  customer_id uuid not null,
  rule_version text not null,                       -- segment 版本 / 内置规则版本
  matched_at timestamptz not null default now(),
  snapshot jsonb not null default '{}'::jsonb,      -- 命中时快照(可审计)
  created_at timestamptz not null default now()
);

create unique index if not exists idx_campaign_audiences_campaign_cust
  on public.marketing_campaign_audiences (campaign_id, customer_id);
create index if not exists idx_campaign_audiences_tenant_campaign
  on public.marketing_campaign_audiences (tenant_id, campaign_id);

-- ===== 3. marketing_campaign_runs 表(发布运行记录) =====
create table if not exists public.marketing_campaign_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  campaign_id uuid not null references public.marketing_campaigns(id) on delete cascade,
  run_no integer not null default 1,
  status text not null default 'completed',         -- pending / running / completed / failed
  audience_count integer not null default 0,
  dispatch_count integer not null default 0,        -- 实际投递数(Agent-08 消费后回填)
  error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint campaign_runs_status_check check (status in ('pending', 'running', 'completed', 'failed'))
);

create index if not exists idx_campaign_runs_tenant_campaign on public.marketing_campaign_runs (tenant_id, campaign_id, run_no desc);

-- ===== 4. referral_codes 表(推荐码) =====
create table if not exists public.referral_codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null,                        -- 推荐人
  code text not null,
  is_active boolean not null default true,
  used_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_referral_codes_tenant_code on public.referral_codes (tenant_id, code);
create unique index if not exists idx_referral_codes_tenant_customer on public.referral_codes (tenant_id, customer_id);

drop trigger if exists trg_referral_codes_updated_at on public.referral_codes;
create trigger trg_referral_codes_updated_at
  before update on public.referral_codes
  for each row execute procedure public.touch_updated_at();

-- ===== 5. referral_events 表(推荐事件,基础关系 + 奖励资格) =====
create table if not exists public.referral_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  referral_code_id uuid not null,
  referrer_customer_id uuid not null,
  referee_customer_id uuid not null,
  status text not null default 'pending',           -- pending / qualified / rewarded / voided
  reward_type text,                                 -- points / coupon / none
  reward_ref text,                                  -- 奖励凭证引用(如 coupon_issue_id)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint referral_events_status_check check (status in ('pending', 'qualified', 'rewarded', 'voided')),
  constraint referral_events_reward_check check (reward_type is null or reward_type in ('points', 'coupon', 'none'))
);

-- 同一被推荐人只能归属一个推荐关系
create unique index if not exists idx_referral_events_referee on public.referral_events (tenant_id, referee_customer_id);
create index if not exists idx_referral_events_referrer on public.referral_events (tenant_id, referrer_customer_id);

drop trigger if exists trg_referral_events_updated_at on public.referral_events;
create trigger trg_referral_events_updated_at
  before update on public.referral_events
  for each row execute procedure public.touch_updated_at();

-- ===== 6. generate_referral_code RPC(生成/获取推荐码) =====
create or replace function public.generate_referral_code(
  p_tenant_id uuid,
  p_customer_id uuid,
  p_operator_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_id uuid;
begin
  if not exists (
    select 1 from public.customers where id = p_customer_id and tenant_id = p_tenant_id and status = 'active'
  ) then
    raise exception 'CUSTOMER_NOT_FOUND';
  end if;

  -- 已有码直接返回(一人一码)
  select id, code into v_id, v_code
  from public.referral_codes
  where tenant_id = p_tenant_id and customer_id = p_customer_id
  limit 1;
  if found then
    return jsonb_build_object('referral_code_id', v_id, 'code', v_code);
  end if;

  loop
    v_code := 'REF-' || upper(substr(md5(gen_random_uuid()::text), 1, 8));
    exit when not exists (
      select 1 from public.referral_codes where tenant_id = p_tenant_id and code = v_code
    );
  end loop;

  insert into public.referral_codes (tenant_id, customer_id, code)
  values (p_tenant_id, p_customer_id, v_code)
  returning id into v_id;

  return jsonb_build_object('referral_code_id', v_id, 'code', v_code);
end;
$$;

-- ===== 7. register_referral RPC(登记推荐关系) =====
create or replace function public.register_referral(
  p_tenant_id uuid,
  p_code text,
  p_referee_customer_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code record;
begin
  select * into v_code
  from public.referral_codes
  where tenant_id = p_tenant_id and code = p_code and is_active = true;
  if not found then
    raise exception 'REFERRAL_CODE_NOT_FOUND';
  end if;

  -- 自己推荐自己禁止
  if v_code.customer_id = p_referee_customer_id then
    raise exception 'REFERRAL_SELF_REFERENCE';
  end if;

  if not exists (
    select 1 from public.customers where id = p_referee_customer_id and tenant_id = p_tenant_id and status = 'active'
  ) then
    raise exception 'CUSTOMER_NOT_FOUND';
  end if;

  insert into public.referral_events
    (tenant_id, referral_code_id, referrer_customer_id, referee_customer_id, status)
  values
    (p_tenant_id, v_code.id, v_code.customer_id, p_referee_customer_id, 'pending')
  on conflict (tenant_id, referee_customer_id)
  do update set referral_code_id = excluded.referral_code_id,
                referrer_customer_id = excluded.referrer_customer_id;

  update public.referral_codes
  set used_count = (
    select count(*)::int from public.referral_events where referral_code_id = v_code.id
  ), updated_at = now()
  where id = v_code.id;

  return jsonb_build_object('referral_code_id', v_code.id, 'code', p_code, 'status', 'pending');
end;
$$;

-- ===== 8. publish_campaign RPC(计算 Audience + Snapshot + 建 Run) =====
-- audience 来源(复用物化结果,不建第二套 filter 引擎):
--   segment  → customer_segment_memberships
--   birthday → 当月生日 active 客户
--   churn    → customer_risk_scores level in (high, medium)
--   referral → 有 referral_codes 的客户
--   manual   → p_customer_ids 参数
-- 幂等:同一 campaign 重复发布返回最近一次 run,不重复 snapshot
create or replace function public.publish_campaign(
  p_tenant_id uuid,
  p_campaign_id uuid,
  p_customer_ids uuid[] default null,
  p_operator_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign record;
  v_run_id uuid;
  v_run_no integer;
  v_count integer := 0;
  v_rule_version text;
  v_cid uuid;
begin
  select * into v_campaign from public.marketing_campaigns
  where id = p_campaign_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'CAMPAIGN_NOT_FOUND';
  end if;

  if v_campaign.status in ('published', 'completed') then
    -- 已发布不可重复发布(防止重复 Snapshot)
    raise exception 'CAMPAIGN_ALREADY_PUBLISHED';
  end if;

  -- 清空旧 Snapshot(允许草稿后重发布)
  delete from public.marketing_campaign_audiences where campaign_id = p_campaign_id;

  if v_campaign.type = 'segment' then
    v_rule_version := 'segment:' || v_campaign.segment_id::text;
    insert into public.marketing_campaign_audiences
      (tenant_id, campaign_id, customer_id, rule_version, matched_at, snapshot)
    select p_tenant_id, p_campaign_id, m.customer_id, v_rule_version, now(),
           jsonb_build_object('segment_id', m.segment_id, 'explanation', m.explanation)
    from public.customer_segment_memberships m
    where m.tenant_id = p_tenant_id and m.segment_id = v_campaign.segment_id
    on conflict (campaign_id, customer_id) do nothing;
    get diagnostics v_count = row_count;
  elsif v_campaign.type = 'birthday' then
    v_rule_version := 'birthday:month';
    insert into public.marketing_campaign_audiences
      (tenant_id, campaign_id, customer_id, rule_version, matched_at, snapshot)
    select p_tenant_id, p_campaign_id, c.id, v_rule_version, now(),
           jsonb_build_object('birthday', c.birthday)
    from public.customers c
    where c.tenant_id = p_tenant_id and c.status = 'active'
      and c.birthday is not null
      and extract(month from c.birthday) = extract(month from now())
    on conflict (campaign_id, customer_id) do nothing;
    get diagnostics v_count = row_count;
  elsif v_campaign.type = 'churn' then
    v_rule_version := 'churn:rule-v1';
    insert into public.marketing_campaign_audiences
      (tenant_id, campaign_id, customer_id, rule_version, matched_at, snapshot)
    select p_tenant_id, p_campaign_id, r.customer_id, v_rule_version, now(),
           jsonb_build_object('risk_score', r.score, 'risk_level', r.level, 'explanation', r.explanation)
    from public.customer_risk_scores r
    join public.customers c on c.id = r.customer_id and c.tenant_id = p_tenant_id and c.status = 'active'
    where r.tenant_id = p_tenant_id and r.risk_type = 'churn'
      and r.level in ('high', 'medium')
    on conflict (campaign_id, customer_id) do nothing;
    get diagnostics v_count = row_count;
  elsif v_campaign.type = 'referral' then
    v_rule_version := 'referral:has-code';
    insert into public.marketing_campaign_audiences
      (tenant_id, campaign_id, customer_id, rule_version, matched_at, snapshot)
    select p_tenant_id, p_campaign_id, rc.customer_id, v_rule_version, now(), '{}'::jsonb
    from public.referral_codes rc
    where rc.tenant_id = p_tenant_id and rc.is_active = true
    on conflict (campaign_id, customer_id) do nothing;
    get diagnostics v_count = row_count;
  else
    -- manual:显式传入客户列表
    v_rule_version := 'manual';
    if p_customer_ids is null or array_length(p_customer_ids, 1) = 0 then
      raise exception 'MANUAL_CAMPAIGN_REQUIRES_CUSTOMERS';
    end if;
    foreach v_cid in array p_customer_ids loop
      insert into public.marketing_campaign_audiences
        (tenant_id, campaign_id, customer_id, rule_version, matched_at, snapshot)
      values (p_tenant_id, p_campaign_id, v_cid, v_rule_version, now(), '{}'::jsonb)
      on conflict (campaign_id, customer_id) do nothing;
    end loop;
    select count(*)::int into v_count
    from public.marketing_campaign_audiences where campaign_id = p_campaign_id;
  end if;

  -- 建 Run(幂等:按 campaign 最新 run_no)
  select coalesce(max(run_no), 0) + 1 into v_run_no
  from public.marketing_campaign_runs where campaign_id = p_campaign_id;

  insert into public.marketing_campaign_runs
    (tenant_id, campaign_id, run_no, status, audience_count, started_at, completed_at, created_by)
  values
    (p_tenant_id, p_campaign_id, v_run_no, 'completed', v_count, now(), now(), p_operator_id)
  returning id into v_run_id;

  -- 状态流转:→ published
  update public.marketing_campaigns
  set status = 'published',
      published_at = now(),
      published_by = p_operator_id,
      updated_at = now()
  where id = p_campaign_id;

  return jsonb_build_object(
    'run_id', v_run_id,
    'run_no', v_run_no,
    'campaign_id', p_campaign_id,
    'audience_count', v_count,
    'rule_version', v_rule_version
  );
end;
$$;

-- ===== 9. RLS =====
alter table public.marketing_campaigns enable row level security;
alter table public.marketing_campaign_audiences enable row level security;
alter table public.marketing_campaign_runs enable row level security;
alter table public.referral_codes enable row level security;
alter table public.referral_events enable row level security;

drop policy if exists "campaigns_select" on public.marketing_campaigns;
create policy "campaigns_select" on public.marketing_campaigns
  for select to authenticated using (public.is_tenant_member(tenant_id));

drop policy if exists "campaign_audiences_select" on public.marketing_campaign_audiences;
create policy "campaign_audiences_select" on public.marketing_campaign_audiences
  for select to authenticated using (public.is_tenant_member(tenant_id));

drop policy if exists "campaign_runs_select" on public.marketing_campaign_runs;
create policy "campaign_runs_select" on public.marketing_campaign_runs
  for select to authenticated using (public.is_tenant_member(tenant_id));

drop policy if exists "referral_codes_select" on public.referral_codes;
create policy "referral_codes_select" on public.referral_codes
  for select to authenticated using (public.is_tenant_member(tenant_id));

drop policy if exists "referral_events_select" on public.referral_events;
create policy "referral_events_select" on public.referral_events
  for select to authenticated using (public.is_tenant_member(tenant_id));

-- 活动写:marketing.manage;发布走 RPC(marketing.publish 权限由 Hono 层校验)
drop policy if exists "campaigns_insert" on public.marketing_campaigns;
create policy "campaigns_insert" on public.marketing_campaigns
  for insert to authenticated
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'marketing.manage'));

drop policy if exists "campaigns_update" on public.marketing_campaigns;
create policy "campaigns_update" on public.marketing_campaigns
  for update to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'marketing.manage'))
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'marketing.manage'));

drop policy if exists "campaigns_delete" on public.marketing_campaigns;
create policy "campaigns_delete" on public.marketing_campaigns
  for delete to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'marketing.manage'));

-- ===== 10. 高危 RPC ACL:仅 service_role =====
revoke all on function public.generate_referral_code(uuid, uuid, uuid) from public;
revoke all on function public.generate_referral_code(uuid, uuid, uuid) from anon;
revoke all on function public.generate_referral_code(uuid, uuid, uuid) from authenticated;
grant execute on function public.generate_referral_code(uuid, uuid, uuid) to service_role;

revoke all on function public.register_referral(uuid, text, uuid) from public;
revoke all on function public.register_referral(uuid, text, uuid) from anon;
revoke all on function public.register_referral(uuid, text, uuid) from authenticated;
grant execute on function public.register_referral(uuid, text, uuid) to service_role;

revoke all on function public.publish_campaign(uuid, uuid, uuid[], uuid) from public;
revoke all on function public.publish_campaign(uuid, uuid, uuid[], uuid) from anon;
revoke all on function public.publish_campaign(uuid, uuid, uuid[], uuid) from authenticated;
grant execute on function public.publish_campaign(uuid, uuid, uuid[], uuid) to service_role;

-- ===== 11. 权限 seed(marketing.publish) =====
insert into public.permissions (code, name, module) values
  ('marketing.publish', '发布营销活动', 'marketing')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code in ('system_admin', 'tenant_owner')
  and p.code = 'marketing.publish'
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

update public.roles
set permissions = array(
  select distinct unnest(permissions || array['marketing.publish'])
)
where code in ('system_admin', 'tenant_owner') and is_system = true;
