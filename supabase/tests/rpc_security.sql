-- ============================================================
-- RLS 测试:高危 Command RPC 直连安全(S30-R03)
--
-- 验证 migration 26 的权限收紧:
--   - revoke public / anon / authenticated
--   - grant service_role(仅 Hono 服务端可调用)
--
-- 安全边界声明:不得依赖 SECURITY DEFINER + RLS 作为权限边界;
-- RPC 只对 service_role 开放,普通 authenticated 用户直连必须失败。
--
-- 执行方式(需要可运行的 Supabase 数据库):
--   1) supabase db reset
--   2) psql "$DATABASE_URL" -f supabase/tests/rpc_security.sql
--
-- 断言矩阵:
--   R1  process_payment                    → permission denied
--   R2  process_refund                     → permission denied
--   R3  reserve_inventory                  → permission denied
--   R4  confirm_inventory_reservation      → permission denied
--   R5  sign_encounter                     → permission denied
--   R6  admit_patient                      → permission denied
--   R7  publish_lab_results                → permission denied
--   R8  service_role 可正常调用(放行,证明 revoke 未误伤服务端)
-- ============================================================

begin;

-- ---------- 断言辅助 ----------
create schema if not exists tests;
create or replace function tests.assert_rpc_denied(
  p_sql text,
  p_name text
) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    raise exception 'RPC_SECURITY_TEST_FAILED: % 应被拒绝(permission denied),但调用成功', p_name;
  exception when insufficient_privilege then
    null; -- 期望行为:无执行权限
  when undefined_function then
    raise exception 'RPC_SECURITY_TEST_FAILED: % 函数不存在', p_name;
  end;
end;
$$;

-- ============================================================
-- R1~R7 普通 authenticated 用户直连高危 Command RPC 必须失败
-- 通过 request.jwt.claims 模拟已登录用户(sub=固定值)
-- ============================================================
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);

  -- R1 billing:收款 process_payment(p_invoice_id uuid, p_amount numeric, p_method text, ...)
  perform tests.assert_rpc_denied(
    'select public.process_payment(''00000000-0000-0000-0000-000000000001''::uuid, 100::numeric, ''cash'')',
    'process_payment');

  -- R2 billing:退款 process_refund(p_invoice_id uuid, p_amount numeric, p_reason text, ...)
  perform tests.assert_rpc_denied(
    'select public.process_refund(''00000000-0000-0000-0000-000000000001''::uuid, 50::numeric, ''测试'')',
    'process_refund');

  -- R3 inventory:商品预留 reserve_inventory(p_tenant_id, p_warehouse_id, p_catalog_item_id, p_quantity, ...)
  perform tests.assert_rpc_denied(
    'select public.reserve_inventory(''00000000-0000-0000-0000-000000000001''::uuid, ''00000000-0000-0000-0000-000000000002''::uuid, ''00000000-0000-0000-0000-000000000003''::uuid, 2::numeric)',
    'reserve_inventory');

  -- R4 inventory:确认预留 confirm_inventory_reservation(p_tenant_id, p_reservation_id, ...)
  perform tests.assert_rpc_denied(
    'select public.confirm_inventory_reservation(''00000000-0000-0000-0000-000000000001''::uuid, ''00000000-0000-0000-0000-000000000004''::uuid)',
    'confirm_inventory_reservation');

  -- R5 clinical:签署病历 sign_encounter(p_encounter_id uuid, p_doctor_id uuid)
  perform tests.assert_rpc_denied(
    'select public.sign_encounter(''00000000-0000-0000-0000-000000000001''::uuid, ''00000000-0000-0000-0000-000000000005''::uuid)',
    'sign_encounter');

  -- R6 inpatient:办理住院 admit_patient(p_tenant_id, p_store_id, p_customer_id, p_pet_id, p_cage_id, ...)
  perform tests.assert_rpc_denied(
    'select public.admit_patient(''00000000-0000-0000-0000-000000000001''::uuid, ''00000000-0000-0000-0000-000000000002''::uuid, ''00000000-0000-0000-0000-000000000006''::uuid, ''00000000-0000-0000-0000-000000000007''::uuid, ''00000000-0000-0000-0000-000000000008''::uuid)',
    'admit_patient');

  -- R7 diagnostics:发布检验结果 publish_lab_results(p_lab_order_id uuid, p_results_json jsonb, ...)
  perform tests.assert_rpc_denied(
    'select public.publish_lab_results(''00000000-0000-0000-0000-000000000001''::uuid, ''[]''::jsonb)',
    'publish_lab_results');
end;
$$;

-- ============================================================
-- R8 service_role 直连放行(证明 revoke 未误伤 Hono 服务端)
-- 仅验证函数可执行权限链,函数体内业务校验(记录不存在)会抛业务错误,
-- 这里只关心"不是 permission denied",即调用被授权。
-- ============================================================
do $$
declare
  v_denied boolean := false;
begin
  set local role service_role;
  begin
    perform public.process_payment('00000000-0000-0000-0000-000000000001'::uuid, 100, 'cash', null);
  exception when others then
    if sqlerrm like '%permission denied%' then
      v_denied := true;
    end if;
    -- 业务错误(如发票不存在)属于正常授权路径,不算失败
  end;
  perform tests.assert_true(not v_denied, 'R8: service_role 应被授权调用 process_payment');
end;
$$;

-- 全部断言通过(事务 rollback,无残留)
select 'RPC_SECURITY_PASSED' as result;

rollback;
