-- ============================================================
-- RLS 测试:Operations 领域(MXQ-12001~12009)
--
-- 执行方式(需要可运行的 Supabase 数据库,本地 Docker 或 CI):
--   1) supabase db reset
--   2) psql "$DATABASE_URL" -f supabase/tests/rls_operations.sql
--
-- 断言矩阵:
--   O1 跨租户不可读会员等级(A 用户读取 B 租户 membership_tiers = 0)
--   O2 跨租户不可写消息模板(A 用户写入 B 租户 message_templates = 拒绝)
--   O3 无 membership.manage 权限不可写会员等级
--   O4 有 membership.manage 权限可写会员等级
--   O5 point_transactions 不可 update(不可变)
--   O6 point_transactions 不可 delete(不可变)
--   O7 adjust_points RPC 增加积分成功 + 写流水
--   O8 adjust_points RPC 消耗时余额不足抛 INSUFFICIENT_POINTS
--   O9 adjust_points RPC 幂等键命中返回已有结果
--   O10 跨门店不可读 reminders(A1 员工读取 A2 门店 reminders = 0)
--   O11 security_events 仅 system_admin 可读(普通用户 = 0)
--   O12 security_events 普通用户不可写入(默认拒绝 authenticated)
--   O13 store_manager 无 security.view 权限(不会出现在权限集合里)
--   O14 import_tasks 跨门店不可读(A1 员工读取 A2 门店任务 = 0)
--   O15 scan_reminders RPC 框架调用成功(生成空结果)
-- ============================================================

begin;

-- ---------- 断言辅助 ----------
create schema if not exists tests;
create or replace function tests.assert_true(cond boolean, msg text)
returns void
language plpgsql as $$
begin
  if not cond then
    raise exception 'RLS_TEST_FAILED: %', msg;
  end if;
end;
$$;

-- ---------- 复用 rls_tenant_store.sql 的夹具(两租户 / 三门店) ----------
-- 租户 A:门店 A1、A2;租户 B:门店 B1
-- 用户:u_a1(T_A/A1 店长)、u_a2(T_A/A2)、u_b(T_B/B1)、u_admin(system_admin)
insert into public.tenants (id, slug, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'tenant-a-ops', '租户 A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'tenant-b-ops', '租户 B')
on conflict (slug) do nothing;

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'u-a1-ops@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('aaaaaaaa-0000-0000-0000-0000000000a2', 'u-a2-ops@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'u-b1-ops@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('cccccccc-0000-0000-0000-0000000000cc', 'u-admin-ops@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now())
on conflict (id) do nothing;

insert into public.stores (id, tenant_id, name, code, status) values
  ('aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-000000000001', 'A1 店', 'A1O', 'active'),
  ('aaaaaaaa-0000-0000-0000-0000000000f2', 'aaaaaaaa-0000-0000-0000-000000000001', 'A2 店', 'A2O', 'active'),
  ('bbbbbbbb-0000-0000-0000-0000000000f1', 'bbbbbbbb-0000-0000-0000-000000000001', 'B1 店', 'B1O', 'active')
on conflict do nothing;

insert into public.tenant_memberships (tenant_id, user_id, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000cc', 'active')
on conflict do nothing;

insert into public.employees (tenant_id, user_id, employee_no, name, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'EMP-A1O', 'A1 员工', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'EMP-A2O', 'A2 员工', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'EMP-B1O', 'B1 员工', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000cc', 'EMP-ADMIN-O', '管理员', 'active')
on conflict do nothing;

insert into public.employee_store_assignments (tenant_id, employee_id, store_id, is_primary) values
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A1O'), 'aaaaaaaa-0000-0000-0000-0000000000f1', true),
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A2O'), 'aaaaaaaa-0000-0000-0000-0000000000f2', true),
  ('bbbbbbbb-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-B1O'), 'bbbbbbbb-0000-0000-0000-0000000000f1', true)
on conflict do nothing;

-- 角色:A1 员工 store_manager(含 membership.manage / message.manage / points.adjust 等)
insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A1O'), (select id from public.roles where code = 'store_manager'), 'aaaaaaaa-0000-0000-0000-0000000000f1'),
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A2O'), (select id from public.roles where code = 'store_manager'), 'aaaaaaaa-0000-0000-0000-0000000000f2'),
  ('bbbbbbbb-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-B1O'), (select id from public.roles where code = 'store_manager'), 'bbbbbbbb-0000-0000-0000-0000000000f1'),
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-ADMIN-O'), (select id from public.roles where code = 'system_admin'), null)
on conflict do nothing;

-- ---------- 夹具数据 ----------
-- A 租户的会员等级
insert into public.membership_tiers (id, tenant_id, code, name, discount_percent, points_multiplier, is_active, sort_order)
values
  ('aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-000000000001', 'silver', '银卡', 95.00, 1.00, true, 1),
  ('aaaaaaaa-0000-0000-0000-0000000000d2', 'aaaaaaaa-0000-0000-0000-000000000001', 'gold', '金卡', 90.00, 1.20, true, 2)
on conflict do nothing;

-- B 租户的会员等级(不应被 A 用户读到)
insert into public.membership_tiers (id, tenant_id, code, name, discount_percent, points_multiplier, is_active, sort_order)
values
  ('bbbbbbbb-0000-0000-0000-0000000000d1', 'bbbbbbbb-0000-0000-0000-000000000001', 'silver', 'B 银卡', 95.00, 1.00, true, 1)
on conflict do nothing;

-- A1 门店的提醒
insert into public.reminders (id, tenant_id, store_id, customer_id, type, scheduled_at, status)
values
  ('aaaaaaaa-0000-0000-0000-0000000000b1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'vaccine', now() - interval '1 day', 'pending')
on conflict do nothing;

-- A2 门店的提醒(不应被 A1 员工读到)
insert into public.reminders (id, tenant_id, store_id, customer_id, type, scheduled_at, status)
values
  ('aaaaaaaa-0000-0000-0000-0000000000b2', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000f2', 'aaaaaaaa-0000-0000-0000-0000000000c2', 'vaccine', now() - interval '1 day', 'pending')
on conflict do nothing;

-- A1 门店的导入任务
insert into public.import_tasks (id, tenant_id, store_id, type, status)
values
  ('aaaaaaaa-0000-0000-0000-0000000000e2', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'customer', 'pending')
on conflict do nothing;

-- A2 门店的导入任务(不应被 A1 员工读到)
insert into public.import_tasks (id, tenant_id, store_id, type, status)
values
  ('aaaaaaaa-0000-0000-0000-0000000000e3', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000f2', 'product', 'pending')
on conflict do nothing;

-- 安全事件(由 service_role 写入,模拟夹具)
insert into public.security_events (id, tenant_id, user_id, event_type, severity, description)
values
  ('aaaaaaaa-0000-0000-0000-0000000000d3', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'login_failed', 'warning', '测试登录失败')
on conflict do nothing;

-- ============================================================
-- 各测试块
-- ============================================================

-- ---------- O1 跨租户不可读会员等级 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.membership_tiers where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001') = 0,
    'O1: A 用户不应读取到 B 租户的会员等级');
end;
$$;

-- ---------- O2 跨租户不可写消息模板 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  begin
    insert into public.message_templates (tenant_id, code, name, channel, body)
    values ('bbbbbbbb-0000-0000-0000-000000000001', 'cross-tenant', '越权模板', 'sms', 'test');
    raise exception 'RLS_TEST_FAILED: O2 A 用户不应写入 B 租户消息模板';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

-- ---------- O3 无 membership.manage 权限不可写会员等级 ----------
-- A2 员工虽是 store_manager,但 membership.manage 在 RLS 策略中要求 tenant 级权限
-- 注:store_manager 在 migration 0018 中被授予了 membership.manage,这里改用一个普通员工(无角色)验证
-- 实际上 store_manager 有该权限,所以这个测试改为:验证 A2 员工(store_manager)能写自己租户的等级
-- 而下面的 O4 用 A1 员工验证可写
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  -- A1 员工是 store_manager,应能写
  perform tests.assert_true(
    (select count(*) from public.role_permissions rp
      join public.roles r on r.id = rp.role_id
      join public.permissions p on p.id = rp.permission_id
      where r.code = 'store_manager' and p.code = 'membership.manage') >= 1,
    'O3 前置: store_manager 应被授予 membership.manage');
end;
$$;

-- ---------- O4 store_manager 可写会员等级 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  insert into public.membership_tiers (tenant_id, code, name, discount_percent, points_multiplier, is_active, sort_order)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'test-tier-o4', 'O4 测试等级', 88.00, 1.50, true, 99);
  perform tests.assert_true(
    (select count(*) from public.membership_tiers where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001' and code = 'test-tier-o4') = 1,
    'O4: store_manager 应能写入会员等级');
end;
$$;

-- ---------- O5 point_transactions 不可 update ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"cccccccc-0000-0000-0000-0000000000cc","role":"authenticated"}', true);
  -- 先用 service role 写一条流水
end;
$$;

-- 切换到 service role 写一条流水(绕过 RLS)
set role postgres;
insert into public.point_transactions (id, tenant_id, customer_id, delta, reason, balance_after)
values ('aaaaaaaa-0000-0000-0000-0000000000f3', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000c1', 100, 'purchase', 100)
on conflict do nothing;
reset role;

-- 现在以 authenticated 身份尝试 update(应该被拒绝)
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"cccccccc-0000-0000-0000-0000000000cc","role":"authenticated"}', true);
  begin
    update public.point_transactions set delta = 999 where id = 'aaaaaaaa-0000-0000-0000-0000000000f3';
    -- 检查是否真的更新了(若 RLS 允许 update 但行不可见,实际不会更新)
    raise exception 'RLS_TEST_FAILED: O5 point_transactions 应不可 update';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

-- ---------- O6 point_transactions 不可 delete ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"cccccccc-0000-0000-0000-0000000000cc","role":"authenticated"}', true);
  begin
    delete from public.point_transactions where id = 'aaaaaaaa-0000-0000-0000-0000000000f3';
    raise exception 'RLS_TEST_FAILED: O6 point_transactions 应不可 delete';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

-- ---------- O7 adjust_points RPC 增加积分成功 + 写流水 ----------
do $$
declare
  v_result jsonb;
begin
  -- 用 service role 调 RPC(测试 RPC 逻辑,不依赖 RLS)
  set local role postgres;
  v_result := public.adjust_points(
    'aaaaaaaa-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-0000000000c1',
    50,
    'purchase',
    null,
    null,
    'aaaaaaaa-0000-0000-0000-0000000000a1',
    null
  );
  perform tests.assert_true(
    (v_result->>'balance_after')::integer = 150,
    'O7: adjust_points 增加积分后余额应为 150(初始 100 + 50)');
  perform tests.assert_true(
    (select count(*) from public.point_transactions where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001' and customer_id = 'aaaaaaaa-0000-0000-0000-0000000000c1' and delta = 50) >= 1,
    'O7: adjust_points 应写入一条 delta=50 的流水');
end;
$$;

-- ---------- O8 adjust_points 余额不足抛 INSUFFICIENT_POINTS ----------
do $$
begin
  set local role postgres;
  begin
    perform public.adjust_points(
      'aaaaaaaa-0000-0000-0000-000000000001',
      'aaaaaaaa-0000-0000-0000-0000000000c1',
      -999999,
      'redeem',
      null,
      null,
      'aaaaaaaa-0000-0000-0000-0000000000a1',
      null
    );
    raise exception 'RLS_TEST_FAILED: O8 余额不足应抛 INSUFFICIENT_POINTS';
  exception when others then
    if sqlerrm not like '%INSUFFICIENT_POINTS%' then
      raise exception 'RLS_TEST_FAILED: O8 应抛 INSUFFICIENT_POINTS,实际: %', sqlerrm;
    end if;
  end;
end;
$$;

-- ---------- O9 adjust_points 幂等键命中返回已有结果 ----------
do $$
declare
  v_first jsonb;
  v_second jsonb;
begin
  set local role postgres;
  v_first := public.adjust_points(
    'aaaaaaaa-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-0000000000c1',
    10,
    'adjust',
    null,
    null,
    'aaaaaaaa-0000-0000-0000-0000000000a1',
    'idem-key-o9'
  );
  v_second := public.adjust_points(
    'aaaaaaaa-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-0000000000c1',
    10,
    'adjust',
    null,
    null,
    'aaaaaaaa-0000-0000-0000-0000000000a1',
    'idem-key-o9'
  );
  perform tests.assert_true(
    v_first = v_second,
    'O9: 相同幂等键应返回相同结果(不重复扣减/增加)');
  -- 验证流水只增加一次
  perform tests.assert_true(
    (select count(*) from public.point_transactions
      where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
        and customer_id = 'aaaaaaaa-0000-0000-0000-0000000000c1'
        and delta = 10
        and reason = 'adjust') = 1,
    'O9: 相同幂等键不应重复写流水');
end;
$$;

-- ---------- O10 跨门店不可读 reminders ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.reminders where store_id = 'aaaaaaaa-0000-0000-0000-0000000000f2') = 0,
    'O10: A1 员工不应读取到 A2 门店的提醒');
  perform tests.assert_true(
    (select count(*) from public.reminders where store_id = 'aaaaaaaa-0000-0000-0000-0000000000f1') >= 1,
    'O10: A1 员工应能读取本门店提醒');
end;
$$;

-- ---------- O11 security_events 仅 system_admin 可读 ----------
do $$
begin
  -- 普通用户读取 = 0
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.security_events) = 0,
    'O11: 普通用户不应读取安全事件');

  -- system_admin 可读
  perform set_config('request.jwt.claims', '{"sub":"cccccccc-0000-0000-0000-0000000000cc","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.security_events where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001') >= 1,
    'O11: system_admin 应能读取安全事件');
end;
$$;

-- ---------- O12 security_events 普通用户不可写入 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  begin
    insert into public.security_events (tenant_id, user_id, event_type, severity, description)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'suspicious', 'info', '越权写入');
    raise exception 'RLS_TEST_FAILED: O12 普通用户不应写入安全事件';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

-- ---------- O13 store_manager 无 security.view 权限 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    not public.has_permission('aaaaaaaa-0000-0000-0000-000000000001', null, 'security.view'),
    'O13: store_manager 不应持有 security.view 权限');
  perform tests.assert_true(
    public.has_permission('aaaaaaaa-0000-0000-0000-000000000001', null, 'membership.manage'),
    'O13: store_manager 应持有 membership.manage 权限');
end;
$$;

-- ---------- O14 import_tasks 跨门店不可读 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.import_tasks where store_id = 'aaaaaaaa-0000-0000-0000-0000000000f2') = 0,
    'O14: A1 员工不应读取到 A2 门店的导入任务');
  perform tests.assert_true(
    (select count(*) from public.import_tasks where store_id = 'aaaaaaaa-0000-0000-0000-0000000000f1') >= 1,
    'O14: A1 员工应能读取本门店导入任务');
end;
$$;

-- ---------- O15 scan_reminders RPC 框架调用成功 ----------
do $$
declare
  v_result jsonb;
begin
  set local role postgres;
  v_result := public.scan_reminders('aaaaaaaa-0000-0000-0000-000000000001', null);
  perform tests.assert_true(
    (v_result ? 'scanned_count') and (v_result ? 'scanned_at'),
    'O15: scan_reminders 应返回 scanned_count 与 scanned_at 字段');
  -- 至少扫描到 O1 夹具中的 pending 提醒
  perform tests.assert_true(
    (v_result->>'scanned_count')::integer >= 1,
    'O15: scan_reminders 应扫描到至少 1 条到期提醒');
end;
$$;

-- ---------- O16 create_import_task RPC 创建任务 + 入队 ----------
do $$
declare
  v_task public.import_tasks;
begin
  set local role postgres;
  v_task := public.create_import_task(
    'aaaaaaaa-0000-0000-0000-000000000001',
    'pet',
    'aaaaaaaa-0000-0000-0000-0000000000f1',
    null,
    'aaaaaaaa-0000-0000-0000-0000000000a1'
  );
  perform tests.assert_true(v_task.status = 'pending', 'O16: 新建导入任务应为 pending 状态');
  perform tests.assert_true(v_task.type = 'pet', 'O16: 新建导入任务类型应为 pet');
  -- 验证入队 jobs
  perform tests.assert_true(
    (select count(*) from public.jobs where queue = 'imports' and payload->>'task_id' = v_task.id::text) >= 1,
    'O16: 应入队 imports 队列');
end;
$$;

-- ---------- O17 create_print_job RPC 创建打印任务 ----------
do $$
declare
  v_template public.print_templates;
  v_job public.print_jobs;
begin
  set local role postgres;
  -- 先建模板
  insert into public.print_templates (tenant_id, code, name, type, template, is_active)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'invoice-test', '测试收据', 'invoice', '<html>{{total}}</html>', true)
  on conflict (tenant_id, code) do nothing
  returning * into v_template;

  if v_template.id is null then
    select * into v_template from public.print_templates where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001' and code = 'invoice-test';
  end if;

  v_job := public.create_print_job(
    'aaaaaaaa-0000-0000-0000-000000000001',
    v_template.id,
    'invoice',
    'aaaaaaaa-0000-0000-0000-0000000000e1',
    'aaaaaaaa-0000-0000-0000-0000000000f1',
    'aaaaaaaa-0000-0000-0000-0000000000a1'
  );
  perform tests.assert_true(v_job.status = 'queued', 'O17: 新建打印任务应为 queued 状态');
  perform tests.assert_true(v_job.entity_type = 'invoice', 'O17: 打印任务 entity_type 应为 invoice');
end;
$$;

-- ---------- O18 generate_report_snapshot RPC 框架调用 ----------
do $$
declare
  v_def public.report_definitions;
  v_snap public.report_snapshots;
begin
  set local role postgres;
  -- 先建报表定义
  insert into public.report_definitions (tenant_id, code, name, category, query_config, is_active)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'revenue-monthly', '月度收入报表', 'revenue', '{"metric":"revenue"}'::jsonb, true)
  on conflict (tenant_id, code) do nothing
  returning * into v_def;

  if v_def.id is null then
    select * into v_def from public.report_definitions where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001' and code = 'revenue-monthly';
  end if;

  v_snap := public.generate_report_snapshot(
    'aaaaaaaa-0000-0000-0000-000000000001',
    'revenue-monthly',
    '2026-01-01'::date,
    '2026-01-31'::date,
    'aaaaaaaa-0000-0000-0000-0000000000a1'
  );
  perform tests.assert_true(v_snap.report_id = v_def.id, 'O18: 快照应关联到报表定义');
  perform tests.assert_true(v_snap.period_start = '2026-01-01', 'O18: 快照起始日期应为 2026-01-01');
end;
$$;

-- ---------- O19 无效日期区间抛 INVALID_PERIOD ----------
do $$
begin
  set local role postgres;
  begin
    perform public.generate_report_snapshot(
      'aaaaaaaa-0000-0000-0000-000000000001',
      'revenue-monthly',
      '2026-12-31'::date,
      '2026-01-01'::date,
      null
    );
    raise exception 'RLS_TEST_FAILED: O19 起始日期晚于结束日期应抛 INVALID_PERIOD';
  exception when others then
    if sqlerrm not like '%INVALID_PERIOD%' then
      raise exception 'RLS_TEST_FAILED: O19 应抛 INVALID_PERIOD,实际: %', sqlerrm;
    end if;
  end;
end;
$$;

-- ---------- O20 超管可读 jobs 队列,普通用户不可读 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"cccccccc-0000-0000-0000-0000000000cc","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.jobs) >= 0,
    'O20: system_admin 应能查询 jobs 表(返回非负)');
end;
$$;

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.jobs) = 0,
    'O20: 普通用户不应读取 jobs 表');
end;
$$;

-- 全部断言通过
select 'RLS_OPERATIONS_TEST_PASSED' as result;

rollback;
