-- ============================================================
-- S32-D: 消息通知真实 Provider
--   - message_deliveries 增加 scene / subject_snapshot / variables_snapshot
--   - 状态机扩展 delivered(Provider 回执确认,SendGrid v1 暂不产生,预留)
--   - 新增 message_delivery_attempts(每次发送尝试的请求/响应快照与失败原因)
--
-- 迁移编号锁:S3.2 固定 112–115;禁止抢用 92–99(S3.1)。
-- ============================================================

-- ===== 1) message_deliveries 扩展列(幂等) =====
alter table public.message_deliveries
  add column if not exists scene text,
  add column if not exists subject_snapshot text,
  add column if not exists variables_snapshot jsonb;

-- 状态机统一:queued → sent / delivered / failed(S32-D §14)
-- 手工重建约束以纳入 delivered,保留原值(兼容既有行)。
alter table public.message_deliveries
  drop constraint if exists deliveries_status_check;
alter table public.message_deliveries
  add constraint deliveries_status_check
  check (status in ('queued', 'sent', 'delivered', 'failed', 'retry'));

create index if not exists idx_message_deliveries_tenant_scene
  on public.message_deliveries (tenant_id, scene, created_at);
create index if not exists idx_message_deliveries_tenant_store_status
  on public.message_deliveries (tenant_id, store_id, status, created_at);

-- ===== 2) message_delivery_attempts(S32-D §7) =====
create table if not exists public.message_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.message_deliveries(id) on delete cascade,
  provider text not null,
  attempt_no integer not null,
  request_snapshot jsonb not null default '{}'::jsonb,
  response_snapshot jsonb,
  status text not null,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  constraint attempts_status_check check (status in ('queued', 'sent', 'delivered', 'failed'))
);

create unique index if not exists idx_message_delivery_attempts_delivery_no
  on public.message_delivery_attempts (delivery_id, attempt_no);
create index if not exists idx_message_delivery_attempts_delivery_created
  on public.message_delivery_attempts (delivery_id, created_at);

alter table public.message_delivery_attempts enable row level security;

-- 只读:租户成员可通过投递归属校验查看(服务端 Command 走 service role 写入)
drop policy if exists "message_delivery_attempts_select" on public.message_delivery_attempts;
create policy "message_delivery_attempts_select" on public.message_delivery_attempts
  for select to authenticated
  using (
    exists (
      select 1 from public.message_deliveries d
      where d.id = message_delivery_attempts.delivery_id
        and public.is_tenant_member(d.tenant_id)
    )
  );

-- insert/update/delete 不开放给 authenticated:由 service role(Hono Command)写入
