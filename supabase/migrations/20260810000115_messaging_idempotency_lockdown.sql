-- ============================================================
-- S32-D FIX: 消息幂等与旧表写边界收口(Messaging Idempotency, P0-D)
-- ------------------------------------------------------------
-- 审计问题(S3.2-Final-Full-Code-Audit):
--   1. 初始发送无幂等键:客户端重试/并发可产生重复 delivery 与重复外部发送;
--   2. 人工重试在 DB attempt claim 之前先执行 Provider 副作用,
--      并发重试可能造成重复短信/邮件;
--   3. 旧 message_templates / message_deliveries 对 authenticated 开放
--      INSERT/UPDATE/DELETE,可绕过 Hono 白名单校验/状态机直接改库。
--
-- 修复:
--   1. message_deliveries 新增 idempotency_key(租户内唯一),初始发送幂等;
--   2. 重试改为服务端原子 claim(状态 + attempts 原子递增)后再副作用;
--   3. 收回 message_templates / message_deliveries 的 authenticated 写策略,
--      仅保留 SELECT;写入一律经 Hono(service role)。
-- ============================================================

set search_path = public;

-- ===== 1. message_deliveries:初始发送幂等键 =====
alter table public.message_deliveries add column if not exists idempotency_key text;

comment on column public.message_deliveries.idempotency_key is
  '发送请求幂等键(租户内唯一);相同键的重复发送直接返回既有投递,不重复外部发送';

drop index if exists idx_message_deliveries_tenant_idem;
create unique index idx_message_deliveries_tenant_idem
  on public.message_deliveries (tenant_id, idempotency_key)
  where idempotency_key is not null;

-- ===== 2. message_templates:收回 authenticated 写策略(仅保留 SELECT) =====
-- 模板写入仅允许经 Hono(service role)执行,保证 validateTemplatePlaceholders 不可被绕过。
drop policy if exists "message_templates_insert" on public.message_templates;
drop policy if exists "message_templates_update" on public.message_templates;
drop policy if exists "message_templates_delete" on public.message_templates;

comment on table public.message_templates is
  '消息模板。写入仅允许经 Hono(service role)执行,authenticated 只读,防止绕过占位符白名单校验。';

-- ===== 3. message_deliveries:收回 authenticated 写策略(仅保留 SELECT) =====
-- 投递记录(含状态机)仅允许经 Hono 状态机更新,防止直接改库伪造投递/绕过重试上限。
drop policy if exists "message_deliveries_insert" on public.message_deliveries;
drop policy if exists "message_deliveries_update" on public.message_deliveries;
drop policy if exists "message_deliveries_delete" on public.message_deliveries;

comment on table public.message_deliveries is
  '消息投递记录。写入/状态机更新仅允许经 Hono(service role)执行,authenticated 只读,防止伪造投递或绕过重试限制。';
