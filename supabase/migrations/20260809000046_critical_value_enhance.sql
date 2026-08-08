-- ============================================================
-- 20260809000046_critical_value_enhance.sql
-- S3.1 并发任务 C 医疗闭环增强:危急值(critical value)闭环
--
-- 角色:开发员工 C(独占 migration 44~49)
--
-- 流程:critical(结果发布自动告警) → notify(通知) → acknowledge(确认) → audit(审计)
--
-- 本文件内容(仅增列/增函数,不修改既有 RPC publish_lab_results / review_lab_results):
--   1. lab_order_analytes 增列 critical_value_code(危急值项目代码,如 'GLU-H')
--   2. critical_value_alerts 增列 critical_value_code / notified_at / notified_by /
--      resolved_at / resolved_by
--   3. 权限码:lab_critical.read / lab_critical.write / lab_critical.execute
--   4. 原子 RPC(全部 service-role-only,Hono 以 service role 调用):
--      notify_critical_value / ack_critical_value
--   5. 审计:各 RPC 事务内写 audit_logs
--
-- 设计要点:
--   - 既有 RLS 策略沿用(20260806000022 已建,使用 lab.critical.acknowledge),
--     权限码与角色分配统一在 migration 49 完成
--   - 状态机保持 pending → acknowledged → resolved(不改 CHECK 约束)
--   - notify 仅标记通知(pending/acknowledged 可通知),不改变状态
--   - ack: pending → acknowledged; acknowledged → resolved;禁止跳级
--   - 普通检验"双人审核"属租户策略,不在此作全国强制(既有 review_lab_results 保持原样)
-- 幂等,可重复应用
-- ============================================================

-- ============================================================
-- 1. lab_order_analytes 增列 critical_value_code
-- ============================================================
alter table public.lab_order_analytes
  add column if not exists critical_value_code text;

-- ============================================================
-- 2. critical_value_alerts 增列(notify / resolve 信息)
-- ============================================================
alter table public.critical_value_alerts
  add column if not exists critical_value_code text,      -- 危急值项目代码(如 'GLU-H'),可空
  add column if not exists notified_at timestamptz,       -- 通知时间
  add column if not exists notified_by uuid,              -- 通知人
  add column if not exists resolved_at timestamptz,       -- 解除/闭环时间
  add column if not exists resolved_by uuid;              -- 解除操作人

create index if not exists idx_critical_alerts_status_pending
  on public.critical_value_alerts (tenant_id, store_id, status)
  where status = 'pending';

-- ============================================================
-- 3. 权限码(lab_critical.read / write / execute)
-- ============================================================
insert into public.permissions (code, name, module) values
  ('lab_critical.read', '查看危急值', 'lab'),
  ('lab_critical.write', '管理危急值', 'lab'),
  ('lab_critical.execute', '通知/确认危急值', 'lab')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- ============================================================
-- 4. notify_critical_value RPC(标记危急值已通知,单事务 + 审计)
--    - 仅 pending/acknowledged 可通知(已解除不可再通知)
--    - 不改变状态,仅记录通知渠道与时间
-- ============================================================
create or replace function public.notify_critical_value(
  p_alert_id uuid,
  p_operator_id uuid default null,
  p_channel text default 'phone'                            -- phone/wechat/inperson/other
)
returns public.critical_value_alerts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alert public.critical_value_alerts;
begin
  if p_channel not in ('phone', 'wechat', 'inperson', 'other') then
    raise exception 'INVALID_NOTIFY_CHANNEL' using errcode = 'P0003';
  end if;

  select * into v_alert from public.critical_value_alerts where id = p_alert_id for update;
  if not found then
    raise exception 'CRITICAL_ALERT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_alert.status = 'resolved' then
    raise exception 'CRITICAL_ALERT_RESOLVED' using errcode = 'P0003';
  end if;

  update public.critical_value_alerts
  set notified_at = coalesce(notified_at, now()),
      notified_by = coalesce(notified_by, p_operator_id)
  where id = p_alert_id
  returning * into v_alert;

  -- 事务内审计
  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_alert.tenant_id, v_alert.store_id, p_operator_id, 'lab_critical.notify', 'critical_value_alert', p_alert_id,
          jsonb_build_object('channel', p_channel, 'criticalValueCode', v_alert.critical_value_code,
                             'labOrderId', v_alert.lab_order_id));

  return v_alert;
end;
$$;

-- ============================================================
-- 5. ack_critical_value RPC(确认/解除危急值,单事务 + 审计)
--    状态机:pending → acknowledged; acknowledged → resolved;禁止跳级
-- ============================================================
create or replace function public.ack_critical_value(
  p_alert_id uuid,
  p_to_status text default 'acknowledged',                  -- acknowledged / resolved
  p_operator_id uuid default null,
  p_note text default null
)
returns public.critical_value_alerts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alert public.critical_value_alerts;
  v_action text;
  v_old_status text;
begin
  if p_to_status not in ('acknowledged', 'resolved') then
    raise exception 'INVALID_ACK_TARGET' using errcode = 'P0003';
  end if;

  select * into v_alert from public.critical_value_alerts where id = p_alert_id for update;
  if not found then
    raise exception 'CRITICAL_ALERT_NOT_FOUND' using errcode = 'P0002';
  end if;
  v_old_status := v_alert.status;

  -- 状态机校验
  if not (
    (v_alert.status = 'pending' and p_to_status = 'acknowledged')
    or (v_alert.status = 'acknowledged' and p_to_status = 'resolved')
  ) then
    raise exception 'INVALID_CRITICAL_TRANSITION' using errcode = 'P0003', detail = v_alert.status || ' 转为 ' || p_to_status;
  end if;

  -- 确认必须已通知(闭环强制:critical → notify → acknowledge)
  if p_to_status = 'acknowledged' and v_alert.notified_at is null then
    raise exception 'CRITICAL_NOT_NOTIFIED' using errcode = 'P0003';
  end if;

  update public.critical_value_alerts
  set status = p_to_status,
      acknowledged_at = case when p_to_status = 'acknowledged' then now() else acknowledged_at end,
      acknowledged_by = case when p_to_status = 'acknowledged' then p_operator_id else acknowledged_by end,
      resolved_at     = case when p_to_status = 'resolved' then now() else resolved_at end,
      resolved_by     = case when p_to_status = 'resolved' then p_operator_id else resolved_by end,
      message         = case when p_note is not null and p_note <> '' then coalesce(message, '') || ' | ' || p_note else message end
  where id = p_alert_id
  returning * into v_alert;

  -- 审计动作区分
  v_action := case when p_to_status = 'acknowledged' then 'lab_critical.acknowledge' else 'lab_critical.resolve' end;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_alert.tenant_id, v_alert.store_id, p_operator_id, v_action, 'critical_value_alert', p_alert_id,
          jsonb_build_object('fromStatus', v_old_status, 'toStatus', p_to_status, 'note', p_note,
                             'criticalValueCode', v_alert.critical_value_code));

  return v_alert;
end;
$$;

-- ============================================================
-- 6. 结束(权限收紧统一放 migration 49 的 revoke DO 块)
-- ============================================================
