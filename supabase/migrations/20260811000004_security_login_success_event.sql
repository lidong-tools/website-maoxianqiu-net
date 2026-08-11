-- ============================================================
-- 20260811000004_security_login_success_event.sql
-- R-C3(3.4.2.3-08):security_events 支持 login_success 事件
-- 原约束(20260806000018_operations.sql L288)仅允许
-- login_failed/permission_denied/suspicious/data_export;
-- 登录提醒需要"登录成功(新设备/异地)"事件,扩展枚举。
-- ============================================================
alter table public.security_events
  drop constraint if exists security_events_type_check;

alter table public.security_events
  add constraint security_events_type_check
  check (event_type in ('login_failed', 'login_success', 'permission_denied', 'suspicious', 'data_export'));
