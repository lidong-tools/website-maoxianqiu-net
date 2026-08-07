-- ============================================================
-- RLS 测试:高危 Command RPC 直连安全(S30-F02 / S30-F03)
--
-- 验证 migration 27 的权限收紧(默认拒绝):
--   - 全部 Hono Command RPC:revoke public / revoke anon / revoke authenticated
--   - grant service_role(仅 Hono 服务端可调用)
--   - 不得依赖 SECURITY DEFINER + RLS 作为权限边界
--
-- 本文件独立可执行:
--   - 自建 tests.assert_* 断言函数,不依赖其他测试文件;
--   - 整个文件处于单一事务(begin/rollback),无任何残留;
--   - 每个 DO 块以 execute 'reset role' 强制回到连接角色,
--     规避 SET LOCAL 在同一事务内跨 DO 块持久化的影响。
--
-- 执行方式(需要可运行的 Supabase 数据库):
--   1) supabase db reset
--   2) psql "$DATABASE_URL" -f supabase/tests/rpc_security.sql
--
-- 断言矩阵:
--   Part 1:21 个 RPC 在 authenticated 直连下必须 permission denied
--     11 个新增遗漏 + 3 个审计结论 + 7 个原有
--   Part 2:16 个 RPC 在 service_role 下必须正常进入业务函数(非 permission denied)
--   Part 3:平台管理员升级负向测试(S30-F01)
--     P1 tenant admin(authenticated)不能向 platform_user_roles 授平台角色(RLS 拒绝)
--     P2 系统角色(scope='system')禁止通过 employee_role_assignments 分配
--        (SYSTEM_ROLE_FORBIDDEN_ERA)
--     P3 无平台授权的租户管理员 is_system_admin() 必须为 false
--     P4 正向对照:service_role 授予 platform_admin 后 is_system_admin() = true
--     P5 legacy store_members 中的 system_admin 不自动升级为平台管理员
-- ============================================================

begin;

-- ---------- 断言辅助(独立可执行,自建) ----------
create schema if not exists tests;
grant usage on schema tests to authenticated, anon, service_role;

create or replace function tests.assert_true(cond boolean, msg text)
returns void
language plpgsql as $$
begin
  if not cond then
    raise exception 'RPC_SECURITY_TEST_FAILED: %', msg;
  end if;
end;
$$;

-- 期望:SQL 执行被拒绝(permission denied);调用成功/其他异常均判失败
create or replace function tests.assert_rpc_denied(p_sql text, p_name text)
returns void
language plpgsql as $$
declare
  v_denied boolean := false;
  v_msg text;
begin
  begin
    execute p_sql;
  exception when insufficient_privilege then
    v_denied := true;
  when undefined_function then
    raise exception 'RPC_SECURITY_TEST_FAILED: % 函数不存在(签名不匹配,误判)', p_name;
  when others then
    v_msg := sqlerrm;
  end;
  if not v_denied then
    raise exception 'RPC_SECURITY_TEST_FAILED: % 应被拒绝(permission denied),实际: %',
      p_name, coalesce(v_msg, '调用成功');
  end if;
end;
$$;

-- 期望:SQL 执行被授权(进入业务函数);仅 permission denied 判失败,业务错误放行
create or replace function tests.assert_rpc_authorized(p_sql text, p_name text)
returns void
language plpgsql as $$
declare
  v_auth_fail boolean := false;
  v_msg text;
begin
  begin
    execute p_sql;
  exception when insufficient_privilege then
    v_auth_fail := true;
    v_msg := 'permission denied';
  when undefined_function then
    raise exception 'RPC_SECURITY_TEST_FAILED: % 函数不存在(签名不匹配)', p_name;
  when others then
    v_msg := sqlerrm; -- 业务错误(记录不存在/FK 等)属于已授权路径,放行
  end;
  if v_auth_fail then
    raise exception 'RPC_SECURITY_TEST_FAILED: % service_role 应被授权进入业务函数,但: %',
      p_name, v_msg;
  end if;
end;
$$;

-- 期望:SQL 执行抛出包含指定文本的错误(用于触发器负向测试)
create or replace function tests.assert_raises(p_sql text, p_expected text, p_name text)
returns void
language plpgsql as $$
declare
  v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    v_msg := sqlerrm;
  end;
  if v_msg is null or position(p_expected in coalesce(v_msg, '')) = 0 then
    raise exception 'RPC_SECURITY_TEST_FAILED: % 应抛出含 % 的错误,实际: %',
      p_name, p_expected, coalesce(v_msg, '无异常(调用成功)');
  end if;
end;
$$;

-- ---------- 平台升级负向测试夹具(S30-F01) ----------
-- t-admin:租户管理员(仅租户侧授权,无平台授权)
insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
values ('99999999-0000-0000-0000-0000000000aa', 't-admin@test.local', crypt('password', gen_salt('bf')), now(),
        '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now())
on conflict (id) do nothing;

-- P5 夹具:legacy store_members 携带 system_admin 角色(历史遗留,不应自动升级)
-- 使用用户 bb(未在 platform_user_roles 中,避免与 P4 对 t-admin 的授权相互干扰)
-- store_members.user_id references auth.users(id),必须先创建用户 bb 再插入 legacy store_members
insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
values ('99999999-0000-0000-0000-0000000000bb', 'legacy-admin@test.local', crypt('password', gen_salt('bf')), now(),
        '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now())
on conflict (id) do nothing;

insert into public.tenants (id, slug, name)
values ('99999999-0000-0000-0000-000000000001', 'rpc-sec-tenant', '安全测试租户')
on conflict (slug) do nothing;
insert into public.stores (id, tenant_id, name, code, status)
values ('99999999-0000-0000-0000-000000000002', '99999999-0000-0000-0000-000000000001', '安全测试门店', 'SEC001', 'active')
on conflict (id) do nothing;
insert into public.store_members (user_id, store_id, role_id, status)
select '99999999-0000-0000-0000-0000000000bb', '99999999-0000-0000-0000-000000000002', r.id, 'active'
from public.roles r
where r.code = 'system_admin'
limit 1
on conflict (user_id, store_id) do nothing;

-- ============================================================
-- Part 1:authenticated 直连高危 Command RPC 必须 permission denied
-- (21 个 = 11 新增 + 3 审计 + 7 原有)
-- ============================================================
do $$
begin
  execute 'reset role'; -- 回到连接角色,规避 SET LOCAL 跨块持久化
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-0000000000aa","role":"authenticated"}', true);

  -- --- 11 个新增遗漏 RPC(S30-F02) ---
  -- R1 files:归档文件 archive_file(p_file_id uuid)
  perform tests.assert_rpc_denied(
    $sql$select public.archive_file('00000000-0000-0000-0000-000000000001'::uuid)$sql$,
    'R1 archive_file');
  -- R2 stores:归档门店 archive_store(p_tenant_id, p_store_id, p_archived_by)
  perform tests.assert_rpc_denied(
    $sql$select public.archive_store('00000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000000003'::uuid, '00000000-0000-0000-0000-000000000004'::uuid)$sql$,
    'R2 archive_store');
  -- R3 files:完成上传 complete_upload(p_file_id uuid)
  perform tests.assert_rpc_denied(
    $sql$select public.complete_upload('00000000-0000-0000-0000-000000000005'::uuid)$sql$,
    'R3 complete_upload');
  -- R4 crm:创建导入任务 create_import_job(p_tenant_id uuid)
  perform tests.assert_rpc_denied(
    $sql$select public.create_import_job('00000000-0000-0000-0000-000000000006'::uuid)$sql$,
    'R4 create_import_job');
  -- R5 files:创建上传意图 create_upload_intent(p_tenant_id uuid)
  perform tests.assert_rpc_denied(
    $sql$select public.create_upload_intent('00000000-0000-0000-0000-000000000007'::uuid)$sql$,
    'R5 create_upload_intent');
  -- R6 iam:邀请员工 invite_employee(p_tenant_id, p_user_id, p_employee_no, p_name)
  perform tests.assert_rpc_denied(
    $sql$select public.invite_employee('00000000-0000-0000-0000-000000000008'::uuid, '00000000-0000-0000-0000-000000000009'::uuid, 'E-TEST', '测试员工')$sql$,
    'R6 invite_employee');
  -- R7 crm:合并客户 merge_customers(p_source_id, p_target_id)
  perform tests.assert_rpc_denied(
    $sql$select public.merge_customers('00000000-0000-0000-0000-000000000010'::uuid, '00000000-0000-0000-0000-000000000011'::uuid)$sql$,
    'R7 merge_customers');
  -- R8 catalog:目录迁移 migrate_catalog_to_store(p_tenant_id, p_store_id)
  perform tests.assert_rpc_denied(
    $sql$select * from public.migrate_catalog_to_store('00000000-0000-0000-0000-000000000012'::uuid, '00000000-0000-0000-0000-000000000013'::uuid)$sql$,
    'R8 migrate_catalog_to_store');
  -- R9 iam:角色权限替换 replace_role_permissions(p_role_id, p_permission_codes text[])
  perform tests.assert_rpc_denied(
    $sql$select public.replace_role_permissions('00000000-0000-0000-0000-000000000014'::uuid, array['store:view']::text[])$sql$,
    'R9 replace_role_permissions');
  -- R10 stores:恢复门店 restore_store(p_tenant_id, p_store_id, p_restored_by)
  perform tests.assert_rpc_denied(
    $sql$select public.restore_store('00000000-0000-0000-0000-000000000015'::uuid, '00000000-0000-0000-0000-000000000016'::uuid, '00000000-0000-0000-0000-000000000017'::uuid)$sql$,
    'R10 restore_store');
  -- R11 iam:员工状态 set_employee_status(p_employee_id, p_status)
  perform tests.assert_rpc_denied(
    $sql$select public.set_employee_status('00000000-0000-0000-0000-000000000018'::uuid, 'active')$sql$,
    'R11 set_employee_status');

  -- --- 3 个审计结论 RPC(S30-F02) ---
  -- R12 crm:客户号生成 generate_customer_no(p_tenant_id, p_store_id)
  perform tests.assert_rpc_denied(
    $sql$select public.generate_customer_no('00000000-0000-0000-0000-000000000019'::uuid, '00000000-0000-0000-0000-000000000020'::uuid)$sql$,
    'R12 generate_customer_no');
  -- R13 billing:发票号生成 generate_invoice_no(p_tenant_id, p_store_id)
  perform tests.assert_rpc_denied(
    $sql$select public.generate_invoice_no('00000000-0000-0000-0000-000000000021'::uuid, '00000000-0000-0000-0000-000000000022'::uuid)$sql$,
    'R13 generate_invoice_no');
  -- R14 crm:导入任务更新 update_import_job(p_job_id uuid)
  perform tests.assert_rpc_denied(
    $sql$select public.update_import_job('00000000-0000-0000-0000-000000000023'::uuid)$sql$,
    'R14 update_import_job');

  -- --- 7 个原有 RPC(保持既有覆盖) ---
  -- R15 billing:收款 process_payment(p_invoice_id, p_amount, p_method)
  perform tests.assert_rpc_denied(
    $sql$select public.process_payment('00000000-0000-0000-0000-000000000024'::uuid, 100::numeric, 'cash')$sql$,
    'R15 process_payment');
  -- R16 billing:退款 process_refund(p_invoice_id, p_amount, p_reason)
  perform tests.assert_rpc_denied(
    $sql$select public.process_refund('00000000-0000-0000-0000-000000000025'::uuid, 50::numeric, '测试')$sql$,
    'R16 process_refund');
  -- R17 inventory:商品预留 reserve_inventory(p_tenant_id, p_warehouse_id, p_catalog_item_id, p_quantity)
  perform tests.assert_rpc_denied(
    $sql$select public.reserve_inventory('00000000-0000-0000-0000-000000000026'::uuid, '00000000-0000-0000-0000-000000000027'::uuid, '00000000-0000-0000-0000-000000000028'::uuid, 2::numeric)$sql$,
    'R17 reserve_inventory');
  -- R18 inventory:确认预留 confirm_inventory_reservation(p_tenant_id, p_reservation_id)
  perform tests.assert_rpc_denied(
    $sql$select public.confirm_inventory_reservation('00000000-0000-0000-0000-000000000029'::uuid, '00000000-0000-0000-0000-000000000030'::uuid)$sql$,
    'R18 confirm_inventory_reservation');
  -- R19 clinical:签署病历 sign_encounter(p_encounter_id, p_doctor_id)
  perform tests.assert_rpc_denied(
    $sql$select public.sign_encounter('00000000-0000-0000-0000-000000000031'::uuid, '00000000-0000-0000-0000-000000000032'::uuid)$sql$,
    'R19 sign_encounter');
  -- R20 inpatient:办理住院 admit_patient(p_tenant_id, p_store_id, p_customer_id, p_pet_id, p_cage_id)
  perform tests.assert_rpc_denied(
    $sql$select public.admit_patient('00000000-0000-0000-0000-000000000033'::uuid, '00000000-0000-0000-0000-000000000034'::uuid, '00000000-0000-0000-0000-000000000035'::uuid, '00000000-0000-0000-0000-000000000036'::uuid, '00000000-0000-0000-0000-000000000037'::uuid)$sql$,
    'R20 admit_patient');
  -- R21 diagnostics:发布检验结果 publish_lab_results(p_lab_order_id, p_results_json)
  perform tests.assert_rpc_denied(
    $sql$select public.publish_lab_results('00000000-0000-0000-0000-000000000038'::uuid, '[]'::jsonb)$sql$,
    'R21 publish_lab_results');
end;
$$;

-- ============================================================
-- Part 2:service_role 直连放行(证明 revoke 未误伤 Hono 服务端)
-- 仅验证执行权限链;函数体业务校验(记录不存在等)抛业务错误属正常授权路径。
-- ============================================================
do $$
begin
  execute 'reset role';
  set local role service_role;

  -- 11 个新增遗漏 RPC
  perform tests.assert_rpc_authorized(
    $sql$select public.archive_file('00000000-0000-0000-0000-000000000001'::uuid)$sql$, 'S1 archive_file');
  perform tests.assert_rpc_authorized(
    $sql$select public.archive_store('00000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000000003'::uuid, '00000000-0000-0000-0000-000000000004'::uuid)$sql$, 'S2 archive_store');
  perform tests.assert_rpc_authorized(
    $sql$select public.complete_upload('00000000-0000-0000-0000-000000000005'::uuid)$sql$, 'S3 complete_upload');
  perform tests.assert_rpc_authorized(
    $sql$select public.create_import_job('00000000-0000-0000-0000-000000000006'::uuid)$sql$, 'S4 create_import_job');
  perform tests.assert_rpc_authorized(
    $sql$select public.create_upload_intent('00000000-0000-0000-0000-000000000007'::uuid)$sql$, 'S5 create_upload_intent');
  perform tests.assert_rpc_authorized(
    $sql$select public.invite_employee('00000000-0000-0000-0000-000000000008'::uuid, '00000000-0000-0000-0000-000000000009'::uuid, 'E-TEST', '测试员工')$sql$, 'S6 invite_employee');
  perform tests.assert_rpc_authorized(
    $sql$select public.merge_customers('00000000-0000-0000-0000-000000000010'::uuid, '00000000-0000-0000-0000-000000000011'::uuid)$sql$, 'S7 merge_customers');
  perform tests.assert_rpc_authorized(
    $sql$select * from public.migrate_catalog_to_store('00000000-0000-0000-0000-000000000012'::uuid, '00000000-0000-0000-0000-000000000013'::uuid)$sql$, 'S8 migrate_catalog_to_store');
  perform tests.assert_rpc_authorized(
    $sql$select public.replace_role_permissions('00000000-0000-0000-0000-000000000014'::uuid, array['store:view']::text[])$sql$, 'S9 replace_role_permissions');
  perform tests.assert_rpc_authorized(
    $sql$select public.restore_store('00000000-0000-0000-0000-000000000015'::uuid, '00000000-0000-0000-0000-000000000016'::uuid, '00000000-0000-0000-0000-000000000017'::uuid)$sql$, 'S10 restore_store');
  perform tests.assert_rpc_authorized(
    $sql$select public.set_employee_status('00000000-0000-0000-0000-000000000018'::uuid, 'active')$sql$, 'S11 set_employee_status');

  -- 3 个审计结论 RPC
  perform tests.assert_rpc_authorized(
    $sql$select public.generate_customer_no('00000000-0000-0000-0000-000000000019'::uuid, '00000000-0000-0000-0000-000000000020'::uuid)$sql$, 'S12 generate_customer_no');
  perform tests.assert_rpc_authorized(
    $sql$select public.generate_invoice_no('00000000-0000-0000-0000-000000000021'::uuid, '00000000-0000-0000-0000-000000000022'::uuid)$sql$, 'S13 generate_invoice_no');
  perform tests.assert_rpc_authorized(
    $sql$select public.update_import_job('00000000-0000-0000-0000-000000000023'::uuid)$sql$, 'S14 update_import_job');

  -- 2 个原有 RPC 抽查
  perform tests.assert_rpc_authorized(
    $sql$select public.process_payment('00000000-0000-0000-0000-000000000024'::uuid, 100::numeric, 'cash')$sql$, 'S15 process_payment');
  perform tests.assert_rpc_authorized(
    $sql$select public.sign_encounter('00000000-0000-0000-0000-000000000031'::uuid, '00000000-0000-0000-0000-000000000032'::uuid)$sql$, 'S16 sign_encounter');
end;
$$;

-- ============================================================
-- Part 3:平台管理员升级负向测试(S30-F01)
-- ============================================================

-- P1:tenant admin(authenticated)不能向 platform_user_roles 授予平台角色(RLS 默认拒绝)
do $$
begin
  execute 'reset role';
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-0000000000aa","role":"authenticated"}', true);
  perform tests.assert_rpc_denied(
    $sql$insert into public.platform_user_roles (user_id, role) values ('99999999-0000-0000-0000-0000000000aa'::uuid, 'platform_admin')$sql$,
    'P1: tenant admin 不能给自己授予 platform_admin');
  perform tests.assert_rpc_denied(
    $sql$insert into public.platform_user_roles (user_id, role) values ('99999999-0000-0000-0000-0000000000bb'::uuid, 'platform_admin')$sql$,
    'P1: tenant admin 不能给他人授予 platform_admin');
end;
$$;

-- P2:系统角色(scope='system')禁止通过 employee_role_assignments 分配
-- (migration 27 触发器 SYSTEM_ROLE_FORBIDDEN_ERA,纵深防御)
do $$
declare
  v_sys_role_id uuid;
begin
  execute 'reset role';
  set local role service_role;
  select id into v_sys_role_id
  from public.roles
  where code = 'system_admin' and is_system = true
  limit 1;
  perform tests.assert_raises(
    format($sql$insert into public.employee_role_assignments (tenant_id, employee_id, role_id)
           values ('99999999-0000-0000-0000-000000000001'::uuid, '99999999-0000-0000-0000-000000000002'::uuid, %L::uuid)$sql$, v_sys_role_id),
    'SYSTEM_ROLE_FORBIDDEN_ERA',
    'P2: 系统角色禁止通过 ERA 分配给租户员工');
end;
$$;

-- P3:无平台授权的租户管理员 is_system_admin() 必须为 false(不再由 ERA/store_members 推导)
do $$
begin
  execute 'reset role';
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-0000000000aa","role":"authenticated"}', true);
  perform tests.assert_true(
    not public.is_system_admin(),
    'P3: 租户管理员(无 platform_user_roles 授权)不应被判定为平台管理员');
end;
$$;

-- P4:正向对照——service_role 授予 platform_admin 后 is_system_admin() = true
do $$
begin
  execute 'reset role';
  set local role service_role;
  insert into public.platform_user_roles (user_id, role)
  values ('99999999-0000-0000-0000-0000000000aa'::uuid, 'platform_admin')
  on conflict (user_id, role) do nothing;
end;
$$;

do $$
begin
  execute 'reset role';
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-0000000000aa","role":"authenticated"}', true);
  perform tests.assert_true(
    public.is_system_admin(),
    'P4: service_role 授予 platform_admin 后,is_system_admin() 应为 true');
end;
$$;

-- P5:legacy store_members 携带 system_admin 角色不自动升级为平台管理员
-- (is_system_admin() 只读 platform_user_roles,与 store_members / ERA 无关)
do $$
begin
  execute 'reset role';
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-0000000000bb","role":"authenticated"}', true);
  -- 用户 bb 仅有 legacy store_members.system_admin 记录,无 platform_user_roles 授权
  perform tests.assert_true(
    not public.is_system_admin(),
    'P5: legacy store_members 中的 system_admin 不应自动升级为平台管理员');
end;
$$;

-- 全部断言通过(事务 rollback,无残留)
select 'RPC_SECURITY_PASSED' as result;

rollback;
