-- ============================================================
-- Agent-08(Stage-04) Messaging Webhook 事件与权限细化
-- migration 267: message_provider_events(幂等事件收件)
--              + apply_provider_event RPC(幂等 insert + 状态推进 CAS)
--              + messaging.* 细粒度权限码(兼容 message.manage)
-- ------------------------------------------------------------
-- 设计约束(Agent-08 DEEP §12~§15):
--   * 事件唯一键 provider + provider_event_id,重复回调幂等丢弃
--   * 状态只前进:晚到事件不能把 delivered 降回 sent,也不能让旧事件覆盖新 retry
--   * 状态推进用 CAS(WHERE status IN 可前进集合),仅匹配行才更新
--   * Webhook 验签在 Hono 层完成(messaging-webhook.ts),DB 只做幂等应用
--   * 权限细粒度 messaging.view/send/template.manage/retry/provider.manage,
--     与既有 message.manage 并存兼容
-- RPC ACL:仅 service_role(§9)
-- ============================================================
set search_path = public;

-- ===== 1. message_provider_events(Provider 回调事件,幂等收件) =====
create table if not exists public.message_provider_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,                                     -- 由 delivery 归属推导,可为空(无法归属时)
  provider text not null,                             -- email / sms / wechat / ...
  provider_event_id text not null,                    -- Provider 侧事件 id
  delivery_id uuid references public.message_deliveries(id) on delete set null,
  provider_message_id text,                           -- Provider 消息 id(反查用)
  event_type text not null,                           -- delivered / failed / bounced / unknown
  payload_snapshot jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received',            -- received / processed / ignored
  created_at timestamptz not null default now(),

  constraint message_provider_events_type_check check (
    event_type in ('delivered', 'failed', 'bounced', 'unknown')
  ),
  constraint message_provider_events_status_check check (
    status in ('received', 'processed', 'ignored')
  )
);

comment on table public.message_provider_events is
  '消息 Provider 回调事件收件箱。幂等键 = provider + provider_event_id;
  delivery 状态推进在 apply_provider_event 内 CAS 完成,晚到/乱序事件不会回退状态。';

create unique index if not exists idx_message_provider_events_provider_event
  on public.message_provider_events (provider, provider_event_id);
create index if not exists idx_message_provider_events_delivery_time
  on public.message_provider_events (delivery_id, received_at desc)
  where delivery_id is not null;
create index if not exists idx_message_provider_events_provider_msg
  on public.message_provider_events (provider, provider_message_id)
  where provider_message_id is not null;

alter table public.message_provider_events enable row level security;

-- 读:需 messaging.view 或 message.manage(事件含 payload 快照)
drop policy if exists "message_provider_events_select" on public.message_provider_events;
create policy "message_provider_events_select" on public.message_provider_events
  for select to authenticated
  using (
    (
      public.has_permission(tenant_id, null, 'messaging.view')
      or public.has_permission(tenant_id, null, 'message.manage')
    )
  );

-- 写:仅 service role(Hono / RPC)

-- ===== 2. apply_provider_event RPC(幂等 insert + CAS 状态推进) =====
create or replace function public.apply_provider_event(
  p_provider text,
  p_provider_event_id text,
  p_delivery_id uuid default null,
  p_provider_message_id text default null,
  p_event_type text default 'unknown',
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_delivery public.message_deliveries;
  v_event_id uuid;
  v_tenant uuid := null;
  v_processed boolean := false;
  v_delivery_exists boolean := false;
begin
  if p_provider is null or p_provider_event_id is null then
    raise exception 'EVENT_MISSING_KEY' using errcode = 'P0003';
  end if;
  if p_event_type not in ('delivered', 'failed', 'bounced', 'unknown') then
    raise exception 'EVENT_INVALID_TYPE' using errcode = 'P0003';
  end if;

  -- 幂等:同 provider + provider_event_id 已收 → 直接返回 duplicate
  if exists (
    select 1 from public.message_provider_events
    where provider = p_provider and provider_event_id = p_provider_event_id
  ) then
    return jsonb_build_object('status', 'duplicate', 'processed', false);
  end if;

  -- 定位 delivery:优先显式 delivery_id,其次按 provider_message_id 反查
  if p_delivery_id is not null then
    select * into v_delivery
    from public.message_deliveries
    where id = p_delivery_id
    limit 1;
    v_delivery_exists := found;
  elsif p_provider_message_id is not null then
    select * into v_delivery
    from public.message_deliveries
    where provider_message_id = p_provider_message_id
    order by created_at desc
    limit 1;
    v_delivery_exists := found;
  end if;

  -- 事件归属租户(无法归属时允许空,仅记录)
  if v_delivery_exists then
    v_tenant := v_delivery.tenant_id;
  end if;

  -- 插入事件记录
  insert into public.message_provider_events (
    tenant_id, provider, provider_event_id,
    delivery_id, provider_message_id, event_type,
    payload_snapshot, status
  )
  values (
    v_tenant, p_provider, p_provider_event_id,
    v_delivery_exists ? v_delivery.id : null,
    p_provider_message_id, p_event_type,
    coalesce(p_payload, '{}'::jsonb),
    'received'
  )
  returning id into v_event_id;

  -- 未知 delivery / unknown 事件:仅记录,不推进
  if not v_delivery_exists or p_event_type = 'unknown' then
    update public.message_provider_events
      set status = 'ignored', processed_at = now()
      where id = v_event_id;
    return jsonb_build_object(
      'status', 'ignored',
      'processed', false,
      'deliveryFound', v_delivery_exists,
      'eventType', p_event_type
    );
  end if;

  -- CAS 状态推进:状态只前进,永不回退
  --   delivered:从 queued/sending/sent/retry 均可到达(最终态)
  --   failed/bounced:从 queued/sending/sent/retry 到达,禁止覆盖 delivered
  if p_event_type = 'delivered' then
    update public.message_deliveries
      set status = 'delivered',
          error = null,
          updated_at = now()
      where id = v_delivery.id
        and status in ('queued', 'sending', 'sent', 'retry')
      returning * into v_delivery;
    v_processed := found;
  else
    update public.message_deliveries
      set status = 'failed',
          error = case when v_delivery.error is null or v_delivery.error = '' then
                    'Provider 回执: ' || p_event_type
                  else v_delivery.error end,
          updated_at = now()
      where id = v_delivery.id
        and status in ('queued', 'sending', 'sent', 'retry')
      returning * into v_delivery;
    v_processed := found;
  end if;

  -- 落处理结果
  update public.message_provider_events
    set status = case when v_processed then 'processed' else 'ignored' end,
        processed_at = now()
    where id = v_event_id;

  return jsonb_build_object(
    'status', case when v_processed then 'processed' else 'ignored' end,
    'processed', v_processed,
    'deliveryFound', true,
    'eventType', p_event_type,
    'deliveryStatus', v_delivery.status
  );
end;
$$;

-- ============================================================
-- RPC ACL(§9)
-- ============================================================
revoke all on function public.apply_provider_event(text, text, uuid, text, text, jsonb) from public;
revoke all on function public.apply_provider_event(text, text, uuid, text, text, jsonb) from anon;
revoke all on function public.apply_provider_event(text, text, uuid, text, text, jsonb) from authenticated;
grant execute on function public.apply_provider_event(text, text, uuid, text, text, jsonb) to service_role;

-- ============================================================
-- Messaging 细粒度权限码(Agent-08 DEEP §15)
-- ============================================================
insert into public.permissions (code, name, module) values
  ('messaging.view', '查看消息投递', 'messaging'),
  ('messaging.send', '发送消息', 'messaging'),
  ('messaging.template.manage', '管理消息模板', 'messaging'),
  ('messaging.retry', '重试消息', 'messaging'),
  ('messaging.provider.manage', '管理消息供应商', 'messaging')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- 分配给已持有 message.manage 的角色(兼容:两者任一通过即放行)
insert into public.role_permissions (role_id, permission_id)
select rp.role_id, p.id
from public.role_permissions rp
join public.permissions msg on msg.code = 'message.manage'
join public.permissions p on p.code in (
  'messaging.view', 'messaging.send', 'messaging.template.manage',
  'messaging.retry', 'messaging.provider.manage'
)
where rp.permission_id = msg.id
  and not exists (
    select 1 from public.role_permissions rp2
    where rp2.role_id = rp.role_id and rp2.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容旧读取)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'messaging.view', 'messaging.send', 'messaging.template.manage',
    'messaging.retry', 'messaging.provider.manage'
  ])
)
where code in (
  select distinct r.code
  from public.roles r
  join public.role_permissions rp on rp.role_id = r.id
  join public.permissions p on p.id = rp.permission_id
  where p.code = 'message.manage'
)
and is_system = true;
