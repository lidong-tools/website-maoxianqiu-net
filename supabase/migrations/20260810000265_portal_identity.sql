-- ============================================================
-- Agent-08(Stage-04) 客户门户身份与授权基础
-- migration 265: customer_identities + customer_pet_access
--              + customer_consents + notification_subscriptions
--              + verification_challenges(OTP) + OTP RPC + 权限码
-- ------------------------------------------------------------
-- 设计约束(Agent-08 DEEP §2~§7):
--   * C 端身份与员工 IAM 完全分离,禁止复用 employee roles
--   * 数据写仅 service_role(Hono Command / RPC);authenticated 只读且收敛
--   * OTP 验证码:DB 只存 hash,不存明文;过期/次数上限/一次性原子消费
--   * 同 tenant 同 provider subject 只能绑定一个 identity
--   * customers.phone/email 仅用于"验证成功时自动匹配绑定",
--     不构成自动授权(宠物访问需显式 customer_pet_access 或 owner 关系)
-- 全部 RPC 按 §9 RPC ACL:revoke public/anon/authenticated, grant service_role
-- ============================================================
set search_path = public;

create extension if not exists pgcrypto;

-- ===== 1. customer_identities(C 端身份,与 auth.users 无关联) =====
create table if not exists public.customer_identities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  customer_id uuid references public.customers(id) on delete set null,
  provider text not null,                             -- phone / email / wechat
  subject text not null,                              -- 手机号 / 邮箱 / 微信 openid
  status text not null default 'active',              -- active / revoked
  verified_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  revoked_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint customer_identities_provider_check check (
    provider in ('phone', 'email', 'wechat')
  ),
  constraint customer_identities_status_check check (
    status in ('active', 'revoked')
  )
);

comment on table public.customer_identities is
  'C 端客户身份(独立于员工 IAM auth.users)。验证方式:OTP 验证码(verification_challenges)。'
  'customer_id 可为空:验证成功时自动匹配 customers.phone/email 绑定,匹配不到保持未绑定,由 Portal Admin 人工绑定。';

create unique index if not exists idx_customer_identities_tenant_subject
  on public.customer_identities (tenant_id, provider, subject);
create index if not exists idx_customer_identities_customer
  on public.customer_identities (tenant_id, customer_id) where customer_id is not null;
create index if not exists idx_customer_identities_status
  on public.customer_identities (tenant_id, status, created_at desc);

drop trigger if exists trg_customer_identities_updated_at on public.customer_identities;
create trigger trg_customer_identities_updated_at
  before update on public.customer_identities
  for each row execute procedure public.touch_updated_at();

-- ===== 2. customer_pet_access(宠物访问授权,显式授权模型) =====
create table if not exists public.customer_pet_access (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  pet_id uuid not null references public.pets(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  access_type text not null default 'family',         -- owner / family / caregiver
  permissions text[] not null default '{"view"}'::text[],
  status text not null default 'active',              -- active / revoked
  granted_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint customer_pet_access_type_check check (
    access_type in ('owner', 'family', 'caregiver')
  ),
  constraint customer_pet_access_status_check check (
    status in ('active', 'revoked')
  )
);

comment on table public.customer_pet_access is
  '客户对宠物档案的访问授权。owner 关系来自 pets.customer_id(自动视为拥有),
  但"同客户多账号"或"家庭/看护人"必须显式授权,禁止 customer_id 相同即默认全授。';

create unique index if not exists idx_customer_pet_access_pet_customer
  on public.customer_pet_access (tenant_id, pet_id, customer_id);
create index if not exists idx_customer_pet_access_customer
  on public.customer_pet_access (tenant_id, customer_id, status);

drop trigger if exists trg_customer_pet_access_updated_at on public.customer_pet_access;
create trigger trg_customer_pet_access_updated_at
  before update on public.customer_pet_access
  for each row execute procedure public.touch_updated_at();

-- ===== 3. customer_consents(客户授权记录,可多版本历史) =====
create table if not exists public.customer_consents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete cascade,
  consent_type text not null,                         -- privacy / marketing / electronic_report / notification
  version text not null default '1.0',
  accepted_at timestamptz not null default now(),
  revoked_at timestamptz,
  source text not null default 'portal',              -- portal / staff / paper
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint customer_consents_type_check check (
    consent_type in ('privacy', 'marketing', 'electronic_report', 'notification')
  )
);

comment on table public.customer_consents is
  '客户 Consent 记录(版本化)。营销消息必须尊重 marketing consent,
  医疗必要通知与营销通知区分对待。当前生效 = 该 type 下 revoked_at is null 的最新一条。';

create index if not exists idx_customer_consents_customer_type
  on public.customer_consents (tenant_id, customer_id, consent_type, accepted_at desc);
create index if not exists idx_customer_consents_tenant_time
  on public.customer_consents (tenant_id, created_at desc);

-- ===== 4. notification_subscriptions(通知订阅,按客户+渠道+场景) =====
create table if not exists public.notification_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete cascade,
  channel text not null,                              -- sms / email / wechat
  scene text not null,                                -- appointment / vaccine / deworming / report_published / followup / marketing / billing
  enabled boolean not null default true,
  destination text,                                   -- 覆盖默认联系方式(手机号/邮箱)
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint notification_subscriptions_channel_check check (
    channel in ('sms', 'email', 'wechat')
  ),
  constraint notification_subscriptions_scene_check check (
    scene in ('appointment', 'vaccine', 'deworming', 'report_published', 'followup', 'marketing', 'billing')
  )
);

comment on table public.notification_subscriptions is
  '客户通知订阅(维度:客户+渠道+场景),拒绝只提供总开关。
  营销消息须同时满足 marketing consent 与该订阅 enabled。';

create unique index if not exists idx_notification_subs_customer_channel_scene
  on public.notification_subscriptions (tenant_id, customer_id, channel, scene);
create index if not exists idx_notification_subs_tenant_channel
  on public.notification_subscriptions (tenant_id, channel, scene);

drop trigger if exists trg_notification_subscriptions_updated_at on public.notification_subscriptions;
create trigger trg_notification_subscriptions_updated_at
  before update on public.notification_subscriptions
  for each row execute procedure public.touch_updated_at();

-- ===== 5. verification_challenges(OTP 验证码,只存 hash) =====
create table if not exists public.verification_challenges (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  provider text not null,                             -- phone / email
  recipient text not null,                            -- 手机号 / 邮箱
  purpose text not null default 'login',              -- login / bind
  code_hash text not null,                            -- sha256(salt || code)
  code_salt text not null,                            -- 随机盐(仅服务端)
  masked_recipient text not null,                     -- 掩码展示(138****1234)
  expires_at timestamptz not null,
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  used_at timestamptz,
  status text not null default 'pending',             -- pending / verified / expired / failed
  created_at timestamptz not null default now(),

  constraint verification_challenges_provider_check check (
    provider in ('phone', 'email')
  ),
  constraint verification_challenges_status_check check (
    status in ('pending', 'verified', 'expired', 'failed')
  )
);

comment on table public.verification_challenges is
  'OTP 验证码挑战。DB 只存 sha256 哈希与随机盐,不存明文验证码;
  过期/次数上限/一次性消费在 portal_verify_otp 内原子完成。';

create index if not exists idx_verification_challenges_recipient_time
  on public.verification_challenges (tenant_id, provider, recipient, created_at desc);
create index if not exists idx_verification_challenges_pending
  on public.verification_challenges (status, expires_at) where status = 'pending';

-- ============================================================
-- RLS:全部表 authenticated 只读且按权限收敛;写仅 service role
-- ============================================================
alter table public.customer_identities enable row level security;
alter table public.customer_pet_access enable row level security;
alter table public.customer_consents enable row level security;
alter table public.notification_subscriptions enable row level security;
alter table public.verification_challenges enable row level security;

-- customer_identities 读:需 portal.identity.view(含隐私 phone/email)
drop policy if exists "customer_identities_select" on public.customer_identities;
create policy "customer_identities_select" on public.customer_identities
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'portal.identity.view')
  );

-- customer_pet_access 读:需 portal.pet.access.view
drop policy if exists "customer_pet_access_select" on public.customer_pet_access;
create policy "customer_pet_access_select" on public.customer_pet_access
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'portal.pet.access.view')
  );

-- customer_consents 读:需 portal.consent.view
drop policy if exists "customer_consents_select" on public.customer_consents;
create policy "customer_consents_select" on public.customer_consents
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'portal.consent.view')
  );

-- notification_subscriptions 读:需 portal.subscription.view
drop policy if exists "notification_subscriptions_select" on public.notification_subscriptions;
create policy "notification_subscriptions_select" on public.notification_subscriptions
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'portal.subscription.view')
  );

-- verification_challenges:任何 authenticated 均不可直读(防 hash/掩码侧信道),仅 service role
-- (不创建任何 select 策略 = 默认 deny)

-- ============================================================
-- RPC: portal_create_otp_challenge(创建验证码挑战,Node 侧生成 code + 盐并传 hash)
-- ============================================================
create or replace function public.portal_create_otp_challenge(
  p_tenant_id uuid,
  p_provider text,
  p_recipient text,
  p_purpose text default 'login',
  p_code_hash text default null,
  p_code_salt text default null,
  p_masked_recipient text default null,
  p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expires timestamptz := coalesce(p_expires_at, now() + interval '10 minutes');
  v_row public.verification_challenges;
  v_recent boolean;
begin
  if p_provider not in ('phone', 'email') then
    raise exception 'OTP_INVALID_PROVIDER' using errcode = 'P0003';
  end if;
  if p_code_hash is null or p_code_salt is null or length(p_code_hash) < 16 then
    raise exception 'OTP_MISSING_HASH' using errcode = 'P0003';
  end if;

  -- 速率限制:同租户同渠道同接收人 60 秒内已存在 pending 挑战 → 拒绝
  select exists (
    select 1 from public.verification_challenges
    where tenant_id = p_tenant_id
      and provider = p_provider
      and recipient = p_recipient
      and status = 'pending'
      and created_at > now() - interval '60 seconds'
  ) into v_recent;
  if v_recent then
    raise exception 'OTP_RATE_LIMITED' using errcode = 'P0003';
  end if;

  -- 使该接收人旧的 pending 挑战全部失效(一次只允许一个有效挑战)
  update public.verification_challenges
    set status = 'expired', used_at = now()
  where tenant_id = p_tenant_id
    and provider = p_provider
    and recipient = p_recipient
    and status = 'pending';

  insert into public.verification_challenges (
    tenant_id, provider, recipient, purpose,
    code_hash, code_salt, masked_recipient,
    expires_at, max_attempts, status
  )
  values (
    p_tenant_id, p_provider, p_recipient, p_purpose,
    p_code_hash, p_code_salt, coalesce(p_masked_recipient, p_recipient),
    v_expires, 5, 'pending'
  )
  returning * into v_row;

  return jsonb_build_object(
    'challengeId', v_row.id,
    'expiresAt', v_row.expires_at,
    'attemptsLeft', v_row.max_attempts
  );
end;
$$;

-- ============================================================
-- RPC: portal_verify_otp(验证验证码,原子消费;成功后解析/创建 identity)
-- ============================================================
create or replace function public.portal_verify_otp(
  p_challenge_id uuid,
  p_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_challenge public.verification_challenges;
  v_code text := coalesce(p_code, '');
  v_candidate_hash text;
  v_identity public.customer_identities;
  v_customer public.customers;
  v_auto_bind uuid := null;
  v_customer_json jsonb;
begin
  select * into v_challenge
  from public.verification_challenges
  where id = p_challenge_id
  for update;

  if not found then
    raise exception 'OTP_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 状态与过期检查
  if v_challenge.status <> 'pending' then
    raise exception 'OTP_ALREADY_USED' using errcode = 'P0003';
  end if;
  if v_challenge.expires_at < now() then
    update public.verification_challenges
      set status = 'expired', used_at = now()
      where id = p_challenge_id;
    raise exception 'OTP_EXPIRED' using errcode = 'P0003';
  end if;
  if v_challenge.attempt_count >= v_challenge.max_attempts then
    update public.verification_challenges
      set status = 'failed', used_at = now()
      where id = p_challenge_id;
    raise exception 'OTP_TOO_MANY_ATTEMPTS' using errcode = 'P0003';
  end if;

  -- 哈希比对:sha256(salt || code)
  v_candidate_hash := encode(digest(v_challenge.code_salt || v_code, 'sha256'), 'hex');
  if v_candidate_hash <> v_challenge.code_hash then
    update public.verification_challenges
      set attempt_count = attempt_count + 1, used_at = now()
      where id = p_challenge_id;
    raise exception 'OTP_INVALID_CODE' using errcode = 'P0003';
  end if;

  -- 原子消费:标记 verified
  update public.verification_challenges
    set status = 'verified', used_at = now()
    where id = p_challenge_id;

  -- 解析 identity:同租户同 provider subject
  select * into v_identity
  from public.customer_identities
  where tenant_id = v_challenge.tenant_id
    and provider = v_challenge.provider
    and subject = v_challenge.recipient
  limit 1;

  if not found then
    -- 尝试自动匹配既有客户(phone 或 email,仅 active 客户,同租户)
    if v_challenge.provider = 'phone' then
      select * into v_customer
      from public.customers
      where tenant_id = v_challenge.tenant_id
        and phone = v_challenge.recipient
        and status = 'active'
      limit 1;
    else
      select * into v_customer
      from public.customers
      where tenant_id = v_challenge.tenant_id
        and email = v_challenge.recipient
        and status = 'active'
      limit 1;
    end if;
    v_auto_bind := v_customer.id;

    insert into public.customer_identities (
      tenant_id, customer_id, provider, subject, status, verified_at,
      metadata
    )
    values (
      v_challenge.tenant_id, v_auto_bind, v_challenge.provider, v_challenge.recipient,
      'active', now(),
      jsonb_build_object('autoBound', v_auto_bind is not null, 'firstVerifiedAt', now())
    )
    returning * into v_identity;
  else
    -- 已有 identity:刷新 verified_at(重新验证);revoked 状态不可再登录
    if v_identity.status = 'revoked' then
      raise exception 'IDENTITY_REVOKED' using errcode = 'P0003';
    end if;
    update public.customer_identities
      set verified_at = now(), updated_at = now()
      where id = v_identity.id;
  end if;

  -- 组装返回(不返回验证码相关字段)
  if v_identity.customer_id is not null then
    select row_to_json(c)::jsonb into v_customer_json
    from (
      select id, customer_no, name, phone, email, status
      from public.customers where id = v_identity.customer_id
    ) c;
  else
    v_customer_json := null;
  end if;

  return jsonb_build_object(
    'identityId', v_identity.id,
    'tenantId', v_identity.tenant_id,
    'customerId', v_identity.customer_id,
    'customer', v_customer_json,
    'provider', v_identity.provider,
    'subject', v_identity.subject,
    'status', v_identity.status
  );
end;
$$;

-- ============================================================
-- RPC ACL(§9):全部新 RPC 仅 service_role
-- ============================================================
revoke all on function public.portal_create_otp_challenge(uuid, text, text, text, text, text, text, timestamptz) from public;
revoke all on function public.portal_create_otp_challenge(uuid, text, text, text, text, text, text, timestamptz) from anon;
revoke all on function public.portal_create_otp_challenge(uuid, text, text, text, text, text, text, timestamptz) from authenticated;
grant execute on function public.portal_create_otp_challenge(uuid, text, text, text, text, text, text, timestamptz) to service_role;

revoke all on function public.portal_verify_otp(uuid, text) from public;
revoke all on function public.portal_verify_otp(uuid, text) from anon;
revoke all on function public.portal_verify_otp(uuid, text) from authenticated;
grant execute on function public.portal_verify_otp(uuid, text) to service_role;

-- ============================================================
-- 权限码(Agent-08 Portal Admin 管理端)
-- ============================================================
insert into public.permissions (code, name, module) values
  ('portal.identity.view', '查看客户门户身份', 'portal'),
  ('portal.identity.manage', '管理客户门户身份', 'portal'),
  ('portal.pet.access.view', '查看宠物访问授权', 'portal'),
  ('portal.pet.access.manage', '管理宠物访问授权', 'portal'),
  ('portal.consent.view', '查看客户授权记录', 'portal'),
  ('portal.consent.manage', '管理客户授权记录', 'portal'),
  ('portal.subscription.view', '查看通知订阅', 'portal'),
  ('portal.subscription.manage', '管理通知订阅', 'portal'),
  ('portal.webhook.view', '查看消息回调事件', 'portal')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- system_admin 补全部 portal 权限
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'system_admin'
  and p.code in (
    'portal.identity.view', 'portal.identity.manage',
    'portal.pet.access.view', 'portal.pet.access.manage',
    'portal.consent.view', 'portal.consent.manage',
    'portal.subscription.view', 'portal.subscription.manage',
    'portal.webhook.view'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- store_manager 补 portal 权限(不含 webhook.view 之外的全部;webhook 事件查看一并授予,便于排障)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code in (
    'portal.identity.view', 'portal.identity.manage',
    'portal.pet.access.view', 'portal.pet.access.manage',
    'portal.consent.view', 'portal.consent.manage',
    'portal.subscription.view', 'portal.subscription.manage',
    'portal.webhook.view'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容旧读取)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'portal.identity.view', 'portal.identity.manage',
    'portal.pet.access.view', 'portal.pet.access.manage',
    'portal.consent.view', 'portal.consent.manage',
    'portal.subscription.view', 'portal.subscription.manage',
    'portal.webhook.view'
  ])
)
where code in ('system_admin', 'store_manager') and is_system = true;
