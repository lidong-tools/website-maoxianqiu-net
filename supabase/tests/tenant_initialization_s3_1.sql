-- ============================================================
-- 租户初始化测试:S3.1 并发任务 A(tenant_initialization)
--
-- 验证 migration 35~38 的初始化闭环:
--   T1 全新租户初始化成功(状态机 running→completed,首店/owner/仓库/支付/字典/打印全部产出)
--   T2 重复初始化幂等(同 idempotency_key 返回首次结果,不重复创建资源)
--   T3 失败自动恢复(failed 状态可重试,attempts+1)
--   T4 tenant_owner 约束(role.scope=tenant、ERA.store_id IS NULL、非 system_admin)
--   T5 默认仓库(WH-DEFAULT,is_default=true)
--   T6 支付上下文(5 种,cash 默认)
--   T7 打印设置(3 种,58mm 默认)
--   T8 租户 A/B 数据隔离(资源绑定各自 tenant_id)
--
-- 本文件独立可执行(psql "$DATABASE_URL" -f supabase/tests/tenant_initialization_s3_1.sql):
--   - 自建 tests.assert_* 断言函数,不依赖其他测试文件;
--   - 单一事务 begin/rollback,无任何残留;
--   - 使用固定 UUID 前缀 a1000000 保证与其他测试文件隔离。
-- ============================================================

begin;

create schema if not exists tests;
grant usage on schema tests to authenticated, anon, service_role;

create or replace function tests.assert_true(cond boolean, msg text)
returns void
language plpgsql as $$
begin
  if not cond then
    raise exception 'TENANT_INIT_TEST_FAILED: %', msg;
  end if;
end;
$$;

-- ============================================================
-- 夹具:租户 A(全新待初始化) / 租户 B(对照隔离) / 两个用户
-- ============================================================
insert into public.tenants (id, slug, name, timezone) values
  ('a1000000-0000-0000-0000-000000000001', 'init-tenant-a', '初始化租户 A', 'Asia/Shanghai'),
  ('a1000000-0000-0000-0000-000000000002', 'init-tenant-b', '初始化租户 B', 'Asia/Shanghai');

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
values
  ('a1000000-0000-0000-0000-000000000101', 'init-owner-a@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('a1000000-0000-0000-0000-000000000102', 'init-owner-b@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now());

-- ============================================================
-- T1:全新租户初始化成功
-- ============================================================
do $$
declare
  v_result jsonb;
  v_init public.tenant_initializations;
  v_cnt integer;
begin
  select public.initialize_tenant(
    p_tenant_id => 'a1000000-0000-0000-0000-000000000001',
    p_store_name => '租户A首店',
    p_store_code => 'TINIT-A1',
    p_owner_user_id => 'a1000000-0000-0000-0000-000000000101',
    p_owner_name => '租户A所有者',
    p_owner_phone => '13800000001',
    p_timezone => 'Asia/Shanghai',
    p_operator_id => 'a1000000-0000-0000-0000-000000000101',
    p_idempotency_key => 'tidem-a-1'
  ) into v_result;

  perform tests.assert_true(v_result->>'status' = 'completed',
    'T1: 初始化应返回 completed,实际=' || coalesce(v_result->>'status', 'null'));

  -- 初始化记录状态机
  select * into v_init
  from public.tenant_initializations
  where tenant_id = 'a1000000-0000-0000-0000-000000000001'
    and idempotency_key = 'tidem-a-1'
  order by created_at desc limit 1;
  perform tests.assert_true(v_init.status = 'completed', 'T1: 状态应为 completed');
  perform tests.assert_true(v_init.attempts = 1, 'T1: 首次 attempts 应为 1');
  perform tests.assert_true(v_init.store_id is not null, 'T1: 应回填 store_id');

  -- 首店产出
  select count(*) into v_cnt from public.stores
  where tenant_id = 'a1000000-0000-0000-0000-000000000001' and code = 'TINIT-A1';
  perform tests.assert_true(v_cnt = 1, 'T1: 应创建 1 个首店');
end;
$$;

-- ============================================================
-- T4:tenant_owner 约束(scope=tenant + ERA.store_id IS NULL + 非 system_admin)
-- ============================================================
do $$
declare
  v_era_cnt integer;
  v_role_scope text;
  v_sysadmin_era_cnt integer;
begin
  -- 租户 A owner 的 ERA 必须存在且 store_id IS NULL,角色为 tenant_owner(scope=tenant)
  select count(*) into v_era_cnt
  from public.employee_role_assignments era
  join public.employees e on e.id = era.employee_id
  join public.roles r on r.id = era.role_id
  where e.tenant_id = 'a1000000-0000-0000-0000-000000000001'
    and e.user_id = 'a1000000-0000-0000-0000-000000000101'
    and era.store_id is null
    and r.code = 'tenant_owner';
  perform tests.assert_true(v_era_cnt = 1, 'T4: tenant_owner 分配应为 1 条且 store_id IS NULL');

  -- 角色 scope 必须是 tenant(不允许 store scope 冒充租户级权限)
  select scope into v_role_scope
  from public.roles
  where code = 'tenant_owner' and is_system = true
  limit 1;
  perform tests.assert_true(v_role_scope = 'tenant', 'T4: tenant_owner scope 应为 tenant,实际=' || coalesce(v_role_scope, 'null'));

  -- 不允许用 system_admin 代替(租户内不应出现 system_admin 的 ERA 分配)
  select count(*) into v_sysadmin_era_cnt
  from public.employee_role_assignments era
  join public.roles r on r.id = era.role_id
  where r.code = 'system_admin' and era.tenant_id = 'a1000000-0000-0000-0000-000000000001';
  perform tests.assert_true(v_sysadmin_era_cnt = 0, 'T4: 租户初始化不得分配 system_admin 角色');
end;
$$;

-- ============================================================
-- T5:默认仓库(WH-DEFAULT,is_default=true)
-- ============================================================
do $$
declare
  v_cnt integer;
  v_def_cnt integer;
begin
  select count(*) into v_cnt
  from public.warehouses
  where tenant_id = 'a1000000-0000-0000-0000-000000000001' and code = 'WH-DEFAULT' and is_active = true;
  perform tests.assert_true(v_cnt = 1, 'T5: 应创建默认仓库 WH-DEFAULT');

  select count(*) into v_def_cnt
  from public.warehouses
  where tenant_id = 'a1000000-0000-0000-0000-000000000001' and is_default = true;
  perform tests.assert_true(v_def_cnt = 1, 'T5: 租户 A 应仅 1 个默认仓库');
end;
$$;

-- ============================================================
-- T6:支付上下文(5 种 + cash 默认)
-- ============================================================
do $$
declare
  v_store_id uuid;
  v_total integer;
  v_default_cnt integer;
  v_cash_default boolean;
begin
  select id into v_store_id from public.stores
  where tenant_id = 'a1000000-0000-0000-0000-000000000001' and code = 'TINIT-A1';

  select count(*) into v_total
  from public.payment_contexts
  where tenant_id = 'a1000000-0000-0000-0000-000000000001' and store_id = v_store_id and is_active = true;
  perform tests.assert_true(v_total = 5, 'T6: 应有 5 种支付方式,实际=' || v_total);

  select count(*) into v_default_cnt
  from public.payment_contexts
  where tenant_id = 'a1000000-0000-0000-0000-000000000001' and store_id = v_store_id and is_default = true;
  perform tests.assert_true(v_default_cnt = 1, 'T6: 应仅 1 个默认支付方式');

  select is_default into v_cash_default
  from public.payment_contexts
  where tenant_id = 'a1000000-0000-0000-0000-000000000001' and store_id = v_store_id and method = 'cash';
  perform tests.assert_true(v_cash_default, 'T6: 默认支付方式应为 cash');
end;
$$;

-- ============================================================
-- T7:打印设置(3 种 + 58mm 默认)
-- ============================================================
do $$
declare
  v_store_id uuid;
  v_total integer;
  v_default_cnt integer;
  v_58_default boolean;
begin
  select id into v_store_id from public.stores
  where tenant_id = 'a1000000-0000-0000-0000-000000000001' and code = 'TINIT-A1';

  select count(*) into v_total
  from public.print_settings
  where tenant_id = 'a1000000-0000-0000-0000-000000000001' and store_id = v_store_id and is_active = true;
  perform tests.assert_true(v_total = 3, 'T7: 应有 3 套打印规格,实际=' || v_total);

  select count(*) into v_default_cnt
  from public.print_settings
  where tenant_id = 'a1000000-0000-0000-0000-000000000001' and store_id = v_store_id and is_default = true;
  perform tests.assert_true(v_default_cnt = 1, 'T7: 应仅 1 个默认打印规格');

  select is_default into v_58_default
  from public.print_settings
  where tenant_id = 'a1000000-0000-0000-0000-000000000001' and store_id = v_store_id and paper_size = '58mm';
  perform tests.assert_true(v_58_default, 'T7: 默认打印规格应为 58mm');
end;
$$;

-- ============================================================
-- T2:重复初始化幂等(同 idempotency_key 返回首次结果,不重复创建)
-- ============================================================
do $$
declare
  v_result jsonb;
  v_store_cnt integer;
  v_wh_cnt integer;
begin
  -- 同 key 重复调用:应直接返回 completed(幂等命中,不重复创建)
  select public.initialize_tenant(
    p_tenant_id => 'a1000000-0000-0000-0000-000000000001',
    p_store_name => '租户A首店(重复)',
    p_store_code => 'TINIT-A1-DUP',
    p_owner_user_id => 'a1000000-0000-0000-0000-000000000101',
    p_owner_name => '租户A所有者',
    p_idempotency_key => 'tidem-a-1'
  ) into v_result;
  perform tests.assert_true(v_result->>'status' = 'completed', 'T2: 重复请求应返回 completed');

  -- 资源不重复创建:仍只有 1 个 store / 1 个默认仓库
  select count(*) into v_store_cnt from public.stores
  where tenant_id = 'a1000000-0000-0000-0000-000000000001';
  perform tests.assert_true(v_store_cnt = 1, 'T2: 幂等不得重复创建门店,实际=' || v_store_cnt);

  select count(*) into v_wh_cnt from public.warehouses
  where tenant_id = 'a1000000-0000-0000-0000-000000000001' and code = 'WH-DEFAULT';
  perform tests.assert_true(v_wh_cnt = 1, 'T2: 幂等不得重复创建仓库');
end;
$$;

-- ============================================================
-- T3:失败自动恢复(store_code 冲突 → failed;修复后重试 → completed,attempts+1)
-- ============================================================
do $$
declare
  v_result jsonb;
  v_init public.tenant_initializations;
  v_attempts_before integer;
begin
  -- 先用已占用 code 触发唯一冲突(模拟失败)
  begin
    perform public.initialize_tenant(
      p_tenant_id => 'a1000000-0000-0000-0000-000000000002',
      p_store_name => '租户B首店',
      p_store_code => 'TINIT-A1',       -- 与租户 A 首店 code 冲突(全局唯一 idx_stores_tenant_code)
      p_owner_user_id => 'a1000000-0000-0000-0000-000000000102',
      p_owner_name => '租户B所有者',
      p_idempotency_key => 'tidem-b-1'
    );
    perform tests.assert_true(false, 'T3: code 冲突应抛出异常');
  exception when others then
    null; -- 预期失败
  end;

  select * into v_init
  from public.tenant_initializations
  where tenant_id = 'a1000000-0000-0000-0000-000000000002'
    and idempotency_key = 'tidem-b-1'
  order by created_at desc limit 1;
  perform tests.assert_true(v_init.status = 'failed', 'T3: 冲突后应标记 failed,实际=' || v_init.status);
  v_attempts_before := v_init.attempts;

  -- 修复 code 后重试:应自动恢复 running→completed,attempts+1
  select public.initialize_tenant(
    p_tenant_id => 'a1000000-0000-0000-0000-000000000002',
    p_store_name => '租户B首店',
    p_store_code => 'TINIT-B1',
    p_owner_user_id => 'a1000000-0000-0000-0000-000000000102',
    p_owner_name => '租户B所有者',
    p_idempotency_key => 'tidem-b-1'
  ) into v_result;
  perform tests.assert_true(v_result->>'status' = 'completed', 'T3: 重试应完成');

  select * into v_init
  from public.tenant_initializations
  where tenant_id = 'a1000000-0000-0000-0000-000000000002'
    and idempotency_key = 'tidem-b-1'
  order by created_at desc limit 1;
  perform tests.assert_true(v_init.status = 'completed', 'T3: 重试后状态应为 completed');
  perform tests.assert_true(v_init.attempts = v_attempts_before + 1,
    'T3: attempts 应 +1,期望=' || (v_attempts_before + 1) || ',实际=' || v_init.attempts);
end;
$$;

-- ============================================================
-- T8:租户 A/B 数据隔离
-- ============================================================
do $$
declare
  v_cnt integer;
begin
  -- 租户 A 的支付上下文/仓库/打印设置不应泄漏到租户 B
  select count(*) into v_cnt from public.payment_contexts
  where tenant_id = 'a1000000-0000-0000-0000-000000000002';
  perform tests.assert_true(v_cnt = 5, 'T8: 租户 B 应有自己的 5 种支付上下文,实际=' || v_cnt);

  select count(*) into v_cnt from public.warehouses
  where tenant_id = 'a1000000-0000-0000-0000-000000000002';
  perform tests.assert_true(v_cnt = 1, 'T8: 租户 B 应有自己的默认仓库');

  select count(*) into v_cnt from public.base_dictionaries
  where tenant_id = 'a1000000-0000-0000-0000-000000000001';
  perform tests.assert_true(v_cnt >= 15, 'T8: 租户 A 基础字典应 ≥15 条,实际=' || v_cnt);

  select count(*) into v_cnt from public.base_dictionaries
  where tenant_id = 'a1000000-0000-0000-0000-000000000002';
  perform tests.assert_true(v_cnt >= 15, 'T8: 租户 B 基础字典应独立初始化,实际=' || v_cnt);
end;
$$;

-- ============================================================
-- get_tenant_initialization 查询验证
-- ============================================================
do $$
declare
  v_result jsonb;
  v_missing jsonb;
begin
  select public.get_tenant_initialization('a1000000-0000-0000-0000-000000000001') into v_result;
  perform tests.assert_true(v_result->>'status' = 'completed', 'G: 租户 A 应为 completed');

  select public.get_tenant_initialization(gen_random_uuid()) into v_missing;
  perform tests.assert_true(v_missing->>'status' = 'not_started', 'G: 未知租户应为 not_started');
end;
$$;

rollback;
