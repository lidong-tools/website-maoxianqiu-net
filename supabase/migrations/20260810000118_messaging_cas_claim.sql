-- ============================================================
-- S32-D FIX v2: Messaging CAS Claim(S3.2-Fix-Reaudit-v2 §21~§23/§25)
-- ------------------------------------------------------------
-- 审计问题:
--   1. Initial Send 并发同键:createDeliveryRecord 冲突回查后 A/B 都继续
--      dispatch,同一 delivery 可能调用 Provider 两次(§21);
--   2. Retry 并发:attempts+1 在 JS 侧计算,UPDATE WHERE 未含 attempts 期望值,
--      两个并发请求可同时 claim 并重复发送(§22);
--   3. Attempt 只读权限过宽(租户成员即可),可能泄露 recipient/variables/
--      provider error(§25)。
--
-- 修复:
--   1. message_deliveries.status 引入 'sending' 中间态(claim 成功、
--      Provider 副作用执行前),配合应用层 attempts CAS 保证单执行者;
--   2. 应用层 Compare-And-Swap:UPDATE ... WHERE attempts = 期望值
--      SET attempts = attempts + 1, status = 'sending' RETURNING *;
--      仅返回行的请求允许调用 Provider(§23);
--   3. message_delivery_attempts SELECT 收紧为要求 messaging.view 或
--      message.manage,避免租户成员无差别读取敏感快照(§25)。
-- 自包含幂等,可重复应用。
-- ============================================================
set search_path = public;

-- ===== 1. 状态机加入 sending 中间态(claim 后、副作用前) =====
alter table public.message_deliveries
  drop constraint if exists deliveries_status_check;
alter table public.message_deliveries
  add constraint deliveries_status_check
  check (status in ('queued', 'sending', 'sent', 'delivered', 'failed', 'retry'));

comment on column public.message_deliveries.status is
  '投递状态:queued=待发送, sending=已抢占(唯一执行者,Provider 副作用执行中), sent/delivered=成功, failed=失败, retry=待重试';

-- ===== 2. Attempt 只读权限收紧(审计 #25) =====
-- attempts 含 recipient/variables/provider error/请求快照,要求 messaging.view 或 message.manage。
drop policy if exists "message_delivery_attempts_select" on public.message_delivery_attempts;
create policy "message_delivery_attempts_select" on public.message_delivery_attempts
  for select to authenticated
  using (
    exists (
      select 1 from public.message_deliveries d
      where d.id = message_delivery_attempts.delivery_id
        and (
          public.has_permission(d.tenant_id, d.store_id, 'messaging.view')
          or public.has_permission(d.tenant_id, d.store_id, 'message.manage')
        )
    )
  );
