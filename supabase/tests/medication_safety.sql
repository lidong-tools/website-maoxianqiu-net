-- ============================================================
-- 用药安全测试:Medication Safety 规则引擎(Stage-04 Agent-04)
--
-- 验证 migration 210(base)+ 211(rpc):
--   - 规则种子:10 种 rule_type 默认规则(幂等)
--   - evaluate_medication_safety:确定性规则计算 + checks upsert
--   - 阻断门禁:issue/dispense 直接调用时服务端强制阻止
--     (前端不调用 evaluate 直接 issue 也会被阻止 = 关键安全用例)
--   - duplicate_ingredient 同成分阻断
--   - species_contraindication 物种禁忌阻断
--   - 无体重/无法解析剂量 → unable_to_evaluate(不默认 PASS)
--   - 体重/疗程边界(边界内不触发,越界触发)
--   - override:无理由拒绝 / 有理由成功并审计
--   - 规则版本追溯(update → current_version + 1)
--   - 禁用规则不参与计算
--   - 跨租户隔离
--   - dispense 快速重检门禁
--
-- 本文件独立可执行(psql "$DATABASE_URL" -f supabase/tests/medication_safety.sql):
--   - 自建 tests.assert_* 断言函数;
--   - 单一事务 begin/rollback,无任何残留;
--   - 以连接角色(postgres)执行,RPC 的 service-role 约束不影响超级用户。
-- ============================================================

begin;

create schema if not exists tests;
grant usage on schema tests to authenticated, anon, service_role;

create or replace function tests.assert_true(cond boolean, msg text)
returns void
language plpgsql as $$
begin
  if not cond then
    raise exception 'MEDICATION_SAFETY_TEST_FAILED: %', msg;
  end if;
end;
$$;

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
    raise exception 'MEDICATION_SAFETY_TEST_FAILED: % 应抛出含 % 的错误,实际: %',
      p_name, p_expected, coalesce(v_msg, '无异常(调用成功)');
  end if;
end;
$$;

-- ============================================================
-- 夹具:租户/门店/用户/员工/客户/宠物/目录/药品档案/兽医备案/病历/处方
-- 固定 UUID 前缀 99999999-0000-0000-0000-00000000004x 保证幂等
-- ============================================================
insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
values ('99999999-0000-0000-0000-000000000042', 'ms-doctor@test.local', crypt('password', gen_salt('bf')), now(),
        '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now())
on conflict (id) do nothing;

insert into public.tenants (id, slug, name)
values ('99999999-0000-0000-0000-000000000040', 'ms-tenant-a', '用药安全测试租户')
on conflict (slug) do nothing;

insert into public.stores (id, tenant_id, name, code, status)
values ('99999999-0000-0000-0000-000000000041', '99999999-0000-0000-0000-000000000040', '用药安全门店', 'MS-A', 'active')
on conflict (id) do nothing;

insert into public.employees (id, tenant_id, user_id, employee_no, name, status)
values ('99999999-0000-0000-0000-000000000043', '99999999-0000-0000-0000-000000000040', '99999999-0000-0000-0000-000000000042', 'MS-DOC', '测试兽医', 'active')
on conflict (id) do nothing;

insert into public.customers (id, tenant_id, store_id, customer_no, name, status)
values ('99999999-0000-0000-0000-000000000044', '99999999-0000-0000-0000-000000000040', '99999999-0000-0000-0000-000000000041', 'MS-CUST', '测试客户', 'active')
on conflict (id) do nothing;

-- 犬宠物(体重 10kg,约 2 岁)
insert into public.pets (id, tenant_id, customer_id, name, species, breed, birth_date, weight, status)
values ('99999999-0000-0000-0000-000000000045', '99999999-0000-0000-0000-000000000040', '99999999-0000-0000-0000-000000000044', '测试犬', 'dog', 'labrador', now() - interval '2 years', 10, 'active')
on conflict (id) do nothing;

-- 目录:三种药品
insert into public.catalog_items (id, tenant_id, code, name, unit, default_price, cost_price, is_active, billing_type)
values ('99999999-0000-0000-0000-000000000046', '99999999-0000-0000-0000-000000000040', 'MS-DRUG-A', '阿莫西林 A', '支', 10, 5, true, 'drug'),
       ('99999999-0000-0000-0000-000000000047', '99999999-0000-0000-0000-000000000040', 'MS-DRUG-B', '阿莫西林 B', '支', 12, 6, true, 'drug'),
       ('99999999-0000-0000-0000-000000000048', '99999999-0000-0000-0000-000000000040', 'MS-DRUG-C', '犬禁忌药 C', '支', 20, 10, true, 'drug')
on conflict (id) do nothing;

insert into public.catalog_drug_extensions (id, catalog_item_id, drug_form, is_controlled, controlled_class)
values ('99999999-0000-0000-0000-000000000049', '99999999-0000-0000-0000-000000000046', 'tablet', false, 'none'),
       ('99999999-0000-0000-0000-00000000004a', '99999999-0000-0000-0000-000000000047', 'tablet', false, 'none'),
       ('99999999-0000-0000-0000-00000000004b', '99999999-0000-0000-0000-000000000048', 'injection', false, 'none')
on conflict (id) do nothing;

-- 兽医备案(issue 前置:有效执业兽医备案)
insert into public.veterinarian_registrations (tenant_id, employee_id, license_no, valid_from, status)
values ('99999999-0000-0000-0000-000000000040', '99999999-0000-0000-0000-000000000043', 'MS-LIC-001',
        (now() at time zone 'Asia/Shanghai')::date, 'active')
on conflict (tenant_id, license_no) do nothing;

-- 病历(载体)
insert into public.encounters (id, tenant_id, store_id, customer_id, pet_id, doctor_id, status, started_at)
values ('99999999-0000-0000-0000-00000000004c', '99999999-0000-0000-0000-000000000040', '99999999-0000-0000-0000-000000000041',
        '99999999-0000-0000-0000-000000000044', '99999999-0000-0000-0000-000000000045',
        '99999999-0000-0000-0000-000000000042', 'in_progress', now() - interval '1 hour')
on conflict (id) do nothing;

-- 处方载体:rx-draft(可修改) / rx-issued(手工条目,无 catalog) / rx-c(物种禁忌场景)
insert into public.prescriptions (id, tenant_id, store_id, encounter_id, customer_id, pet_id, doctor_id, status)
values ('99999999-0000-0000-0000-00000000004d', '99999999-0000-0000-0000-000000000040', '99999999-0000-0000-0000-000000000041',
        '99999999-0000-0000-0000-00000000004c', '99999999-0000-0000-0000-000000000044', '99999999-0000-0000-0000-000000000045',
        '99999999-0000-0000-0000-000000000042', 'draft'),
       ('99999999-0000-0000-0000-00000000004e', '99999999-0000-0000-0000-000000000040', '99999999-0000-0000-0000-000000000041',
        '99999999-0000-0000-0000-00000000004c', '99999999-0000-0000-0000-000000000044', '99999999-0000-0000-0000-000000000045',
        '99999999-0000-0000-0000-000000000042', 'draft')
on conflict (id) do nothing;

-- ============================================================
-- Part 1:药品安全档案(走 RPC;测试以 postgres 执行,等价 service_role)
--   A/B:同成分 amoxicillin,A 剂量 5~10 mg/kg,A 疗程 7 天
--   C:犬禁忌
-- ============================================================
do $$
declare
  v_tenant uuid := '99999999-0000-0000-0000-000000000040';
begin
  execute 'reset role';
  perform public.ensure_medication_safety_rules(v_tenant);

  perform public.upsert_drug_profile(
    v_tenant, '99999999-0000-0000-0000-000000000046',
    'amoxicillin', '250mg', 'mg/片', 'oral', 'penicillin',
    5, 10, null, null, null, null, 7, '{}'::text[], null);

  perform public.upsert_drug_profile(
    v_tenant, '99999999-0000-0000-0000-000000000047',
    'amoxicillin', '500mg', 'mg/片', 'oral', 'penicillin',
    5, 10, null, null, null, null, 7, '{}'::text[], null);

  perform public.upsert_drug_profile(
    v_tenant, '99999999-0000-0000-0000-000000000048',
    'metronidazole', '100mg/ml', 'mg/ml', 'injection', null,
    null, null, null, null, null, null, null, '{dog}'::text[], null);
end;
$$;

-- ============================================================
-- Part 2:默认规则种子校验(10 种 rule_type)
-- ============================================================
do $$
declare
  v_tenant uuid := '99999999-0000-0000-0000-000000000040';
  v_cnt integer;
begin
  execute 'reset role';
  select count(distinct rule_type) into v_cnt
  from public.medication_safety_rules where tenant_id = v_tenant;
  perform tests.assert_true(v_cnt = 10, '默认规则应覆盖 10 种 rule_type,实际 ' || v_cnt);
  -- 阻断基线:duplicate_ingredient / species_contraindication / drug_interaction 默认阻断
  perform tests.assert_true(
    (select is_blocking from public.medication_safety_rules
     where tenant_id = v_tenant and code = 'duplicate_ingredient'),
    'duplicate_ingredient 应默认阻断');
  perform tests.assert_true(
    (select is_blocking from public.medication_safety_rules
     where tenant_id = v_tenant and code = 'species_contraindication'),
    'species_contraindication 应默认阻断');
end;
$$;

-- ============================================================
-- Part 3:P1 duplicate_ingredient 同成分阻断
--   处方 rx-draft 含 A+B(同成分 amoxicillin)→ blocking 触发
--   且"前端不调用 evaluate 直接 issue"也会被服务端阻止(关键安全用例)
-- ============================================================
do $$
declare
  v_rx uuid := '99999999-0000-0000-0000-00000000004d';
  v_result jsonb;
  v_blocking integer;
begin
  execute 'reset role';
  insert into public.prescription_items (prescription_id, catalog_item_id, drug_name, dosage, frequency, duration_days, quantity, unit, sort_order)
  values (v_rx, '99999999-0000-0000-0000-000000000046', '阿莫西林 A', '50mg/kg', 'bid', 3, 10, '支', 0),
         (v_rx, '99999999-0000-0000-0000-000000000047', '阿莫西林 B', '50mg/kg', 'bid', 3, 10, '支', 1);

  -- 显式 evaluate:duplicate_ingredient 触发且阻断
  v_result := public.evaluate_medication_safety(v_rx, 'issue');
  select (v_result->>'blocking_unresolved')::int into v_blocking;
  perform tests.assert_true(v_blocking >= 1, 'P1:同成分处方应触发阻断检查');
  perform tests.assert_true(
    exists (select 1 from jsonb_array_elements(v_result->'checks') c
            where c->>'rule_code' = 'duplicate_ingredient'),
    'P1:阻断检查应来自 duplicate_ingredient 规则');

  -- 关键安全用例:不调用 evaluate,直接 issue → 服务端仍阻止
  perform tests.assert_raises(
    $sql$select public.issue_prescription('99999999-0000-0000-0000-00000000004d'::uuid,
      '99999999-0000-0000-0000-000000000043'::uuid, '99999999-0000-0000-0000-000000000042'::uuid, null)$sql$,
    'MEDICATION_SAFETY_BLOCKED', 'P1:未豁免阻断直接 issue 应被服务端阻止');
end;
$$;

-- ============================================================
-- Part 4:P2 修正处方(A-only)后可 issue
--   同时验证 dose_range:50mg/kg > max 10 → warning 触发(非阻断),issue 放行
-- ============================================================
do $$
declare
  v_rx uuid := '99999999-0000-0000-0000-00000000004d';
  v_result jsonb;
  v_blocking integer;
  v_row public.prescriptions;
begin
  execute 'reset role';
  delete from public.prescription_items where prescription_id = v_rx;
  insert into public.prescription_items (prescription_id, catalog_item_id, drug_name, dosage, frequency, duration_days, quantity, unit, sort_order)
  values (v_rx, '99999999-0000-0000-0000-000000000046', '阿莫西林 A', '50mg/kg', 'bid', 3, 10, '支', 0);

  v_result := public.evaluate_medication_safety(v_rx, 'issue');
  select (v_result->>'blocking_unresolved')::int into v_blocking;
  perform tests.assert_true(v_blocking = 0, 'P2:单一药品不应有阻断检查');
  -- dose_range 越界 → warning 级(非阻断)触发
  perform tests.assert_true(
    exists (select 1 from jsonb_array_elements(v_result->'checks') c
            where c->>'rule_code' = 'dose_range' and (c->>'blocking')::boolean = false),
    'P2:剂量越界应触发非阻断 warning 检查');

  -- issue 放行
  select * into v_row from public.issue_prescription(
    v_rx, '99999999-0000-0000-0000-000000000043', '99999999-0000-0000-0000-000000000042', null);
  perform tests.assert_true(v_row.status = 'issued', 'P2:无阻断处方应可开具');
end;
$$;

-- ============================================================
-- Part 5:P3 species_contraindication 物种禁忌 + override 流程
--   rx-c 含药品 C(犬禁忌)→ issue 被阻 → 无理由豁免拒绝 → 有理由豁免放行
-- ============================================================
do $$
declare
  v_rx uuid := '99999999-0000-0000-0000-00000000004e';
  v_check_id uuid;
  v_result jsonb;
  v_override_row public.medication_safety_checks;
begin
  execute 'reset role';
  insert into public.prescription_items (prescription_id, catalog_item_id, drug_name, dosage, frequency, quantity, unit, sort_order)
  values (v_rx, '99999999-0000-0000-0000-000000000048', '犬禁忌药 C', '5mg/kg', 'sid', 1, '支', 0);

  -- 直接 issue 被物种禁忌阻断(前端不调用 evaluate 也一样)
  perform tests.assert_raises(
    $sql$select public.issue_prescription('99999999-0000-0000-0000-00000000004e'::uuid,
      '99999999-0000-0000-0000-000000000043'::uuid, '99999999-0000-0000-0000-000000000042'::uuid, null)$sql$,
    'MEDICATION_SAFETY_BLOCKED', 'P3:物种禁忌阻断 issue');

  -- 无理由豁免 → 拒绝
  select id into v_check_id from public.medication_safety_checks
  where prescription_id = v_rx and check_stage = 'issue' and rule_code = 'species_contraindication'
    and status = 'triggered' limit 1;
  perform tests.assert_true(v_check_id is not null, 'P3:应存在物种禁忌检查记录');
  perform tests.assert_raises(
    format($sql$select public.override_medication_safety_check('%s'::uuid, '99999999-0000-0000-0000-000000000042'::uuid, '')$sql$, v_check_id),
    'OVERRIDE_REASON_REQUIRED', 'P3:豁免无理由应被拒绝');

  -- 有理由豁免 → 成功 + issue 放行
  select * into v_override_row from public.override_medication_safety_check(
    v_check_id, '99999999-0000-0000-0000-000000000042', '主治兽医评估后确认获益大于风险');
  perform tests.assert_true(v_override_row.status = 'overridden', 'P3:豁免后检查应标记 overridden');
  perform tests.assert_true(
    exists (select 1 from public.medication_safety_overrides where check_id = v_check_id),
    'P3:豁免应写入 override 记录');
  perform tests.assert_true(
    exists (select 1 from public.audit_logs where action = 'medication_safety.override' and entity_id = v_check_id::text),
    'P3:豁免应写审计');

  -- 再次 issue 放行(issue 阶段无未豁免阻断)
  perform tests.assert_true(
    (select status from public.issue_prescription(
      v_rx, '99999999-0000-0000-0000-000000000043', '99999999-0000-0000-0000-000000000042', null)) = 'issued',
    'P3:豁免阻断后应可开具');
end;
$$;

-- ============================================================
-- Part 6:P4 无体重 → unable_to_evaluate(不默认 PASS)
--   将宠物体重置空,剂量无法换算 mg/kg → 写"无法自动校验剂量"
-- ============================================================
do $$
declare
  v_rx uuid := '99999999-0000-0000-0000-00000000004d';
  v_result jsonb;
  v_unable integer;
begin
  execute 'reset role';
  update public.pets set weight = null where id = '99999999-0000-0000-0000-000000000045';

  v_result := public.evaluate_medication_safety(v_rx, 'dispense');
  select (v_result->>'unable_to_evaluate')::int into v_unable;
  perform tests.assert_true(v_unable >= 1, 'P4:无体重且剂量需换算时应产生 unable_to_evaluate');
  perform tests.assert_true(
    exists (select 1 from jsonb_array_elements(v_result->'checks') c
            where c->>'rule_code' = 'dose_range'
              and c->>'message_snapshot' like '%无法自动校验剂量%'),
    'P4:应写入"无法自动校验剂量"提示,而非默认 PASS');

  update public.pets set weight = 10 where id = '99999999-0000-0000-0000-000000000045';
end;
$$;

-- ============================================================
-- Part 7:P5 体重边界(边界内不触发 / 越界触发)
--   A:min 5 max 10 mg/kg;dosage '50mg' + weight 10kg → 5 mg/kg(下界=不触发)
--   dosage '120mg' + weight 10kg → 12 mg/kg(越上界 → 触发)
-- ============================================================
do $$
declare
  v_rx uuid := '99999999-0000-0000-0000-00000000004d';
  v_result jsonb;
begin
  execute 'reset role';
  delete from public.prescription_items where prescription_id = v_rx;
  insert into public.prescription_items (prescription_id, catalog_item_id, drug_name, dosage, frequency, quantity, unit, sort_order)
  values (v_rx, '99999999-0000-0000-0000-000000000046', '阿莫西林 A', '50mg', 'bid', 10, '支', 0);

  -- 5 mg/kg = 下界,不触发
  v_result := public.evaluate_medication_safety(v_rx, 'issue');
  perform tests.assert_true(
    not exists (select 1 from jsonb_array_elements(v_result->'checks') c
                where c->>'rule_code' = 'dose_range'),
    'P5:剂量恰好等于下界不应触发');

  update public.prescription_items set dosage = '120mg' where prescription_id = v_rx;
  v_result := public.evaluate_medication_safety(v_rx, 'issue');
  perform tests.assert_true(
    exists (select 1 from jsonb_array_elements(v_result->'checks') c
            where c->>'rule_code' = 'dose_range'),
    'P5:剂量越上界应触发 dose_range 检查');
end;
$$;

-- ============================================================
-- Part 8:P6 疗程边界(档案收紧:max_duration_days = 7)
--   7 天不触发 / 8 天触发(duration_limit 取 least(规则 30, 档案 7))
-- ============================================================
do $$
declare
  v_rx uuid := '99999999-0000-0000-0000-00000000004d';
  v_result jsonb;
begin
  execute 'reset role';
  delete from public.prescription_items where prescription_id = v_rx;
  insert into public.prescription_items (prescription_id, catalog_item_id, drug_name, dosage, frequency, duration_days, quantity, unit, sort_order)
  values (v_rx, '99999999-0000-0000-0000-000000000046', '阿莫西林 A', '50mg', 'bid', 7, 10, '支', 0);

  v_result := public.evaluate_medication_safety(v_rx, 'issue');
  perform tests.assert_true(
    not exists (select 1 from jsonb_array_elements(v_result->'checks') c
                where c->>'rule_code' = 'duration_limit'),
    'P6:疗程等于档案上限不应触发');

  update public.prescription_items set duration_days = 8 where prescription_id = v_rx;
  v_result := public.evaluate_medication_safety(v_rx, 'issue');
  perform tests.assert_true(
    exists (select 1 from jsonb_array_elements(v_result->'checks') c
            where c->>'rule_code' = 'duration_limit'),
    'P6:疗程超过档案上限应触发 duration_limit 检查');
end;
$$;

-- ============================================================
-- Part 9:P7 规则版本追溯(update 规则 → current_version + 1,
--   历史 checks 保留旧 rule_version)
-- ============================================================
do $$
declare
  v_tenant uuid := '99999999-0000-0000-0000-000000000040';
  v_rule_id uuid;
  v_rule public.medication_safety_rules;
  v_check_version integer;
begin
  execute 'reset role';
  select id into v_rule_id from public.medication_safety_rules
  where tenant_id = v_tenant and code = 'duration_limit';

  select * into v_rule from public.upsert_medication_safety_rule(
    v_tenant, v_rule_id, null, '疗程上限', 'duration_limit', 'warning', false,
    '{}'::text[], true, '{"max_duration_days": 14}'::jsonb, '用药疗程超过上限(14 天)', '确认长疗程必要性', null);
  perform tests.assert_true(v_rule.current_version = 2, 'P7:更新规则后版本应 +1');

  select count(*) into v_check_version from public.medication_safety_rule_versions
  where rule_id = v_rule_id;
  perform tests.assert_true(v_check_version = 2, 'P7:rule_versions 应 append 新版本');

  -- 新版本条件生效:15 天触发(>14)
  delete from public.prescription_items where prescription_id = '99999999-0000-0000-0000-00000000004d';
  insert into public.prescription_items (prescription_id, catalog_item_id, drug_name, dosage, frequency, duration_days, quantity, unit, sort_order)
  values ('99999999-0000-0000-0000-00000000004d', '99999999-0000-0000-0000-000000000046', '阿莫西林 A', '50mg', 'bid', 15, 10, '支', 0);

  perform public.evaluate_medication_safety('99999999-0000-0000-0000-00000000004d', 'issue');
  select rule_version into v_check_version from public.medication_safety_checks
  where prescription_id = '99999999-0000-0000-0000-00000000004d'
    and check_stage = 'issue' and rule_code = 'duration_limit' limit 1;
  perform tests.assert_true(v_check_version = 2, 'P7:检查记录应追溯最新规则版本');
end;
$$;

-- ============================================================
-- Part 10:P8 禁用规则不参与计算
-- ============================================================
do $$
declare
  v_rule_id uuid;
  v_rule public.medication_safety_rules;
begin
  execute 'reset role';
  select id into v_rule_id from public.medication_safety_rules
  where tenant_id = '99999999-0000-0000-0000-000000000040' and code = 'duration_limit';

  select * into v_rule from public.set_medication_safety_rule_active(v_rule_id, false, null);
  perform tests.assert_true(v_rule.active = false, 'P8:规则应可停用');

  delete from public.prescription_items where prescription_id = '99999999-0000-0000-0000-00000000004d';
  insert into public.prescription_items (prescription_id, catalog_item_id, drug_name, dosage, frequency, duration_days, quantity, unit, sort_order)
  values ('99999999-0000-0000-0000-00000000004d', '99999999-0000-0000-0000-000000000046', '阿莫西林 A', '50mg', 'bid', 30, 10, '支', 0);

  perform tests.assert_true(
    not exists (
      select 1 from jsonb_array_elements(
        public.evaluate_medication_safety('99999999-0000-0000-0000-00000000004d', 'issue')->'checks') c
      where c->>'rule_code' = 'duration_limit'
    ),
    'P8:停用规则后不应再触发');

  perform public.set_medication_safety_rule_active(v_rule_id, true, null);
end;
$$;

-- ============================================================
-- Part 11:P9 跨租户隔离(租户 B 的规则/档案不影响租户 A)
-- ============================================================
do $$
declare
  v_tenant_b uuid := '99999999-0000-0000-0000-000000000050';
begin
  execute 'reset role';
  insert into public.tenants (id, slug, name)
  values (v_tenant_b, 'ms-tenant-b', '用药安全测试租户 B')
  on conflict (slug) do nothing;

  -- 租户 B 不 seed、不建档案 → 租户 A 的 evaluate 不应受任何影响
  perform public.ensure_medication_safety_rules(v_tenant_b);
  perform tests.assert_true(
    not exists (select 1 from public.drug_profiles where tenant_id = v_tenant_b),
    'P9:租户 B 不应存在药品档案');
  perform tests.assert_true(
    not exists (select 1 from public.medication_safety_checks c
                join public.prescriptions p on p.id = c.prescription_id
                where p.tenant_id = '99999999-0000-0000-0000-000000000040'
                  and c.rule_id in (select id from public.medication_safety_rules where tenant_id = v_tenant_b)),
    'P9:租户 A 的检查记录不应引用租户 B 的规则');
end;
$$;

-- ============================================================
-- Part 12:P10 dispense 快速重检门禁
--   处方 rx-c 已 issued(物种禁忌在 issue 阶段已豁免);
--   dispense 阶段重新计算,生成 dispense 阶段的物种禁忌阻断 → 发药被阻;
--   豁免 dispense 阶段检查后可继续(无阻断的手工条目处方可正常发药)。
-- ============================================================
do $$
declare
  v_rx_manual uuid := '99999999-0000-0000-0000-00000000004d';
  v_rx_c uuid := '99999999-0000-0000-0000-00000000004e';
  v_check_id uuid;
  v_row public.prescriptions;
begin
  execute 'reset role';
  -- rx_manual 改为纯手工条目(无 catalog)→ 无规则可匹配 → issue + dispense 全通过
  delete from public.prescription_items where prescription_id = v_rx_manual;
  insert into public.prescription_items (prescription_id, drug_name, dosage, frequency, quantity, unit, sort_order)
  values (v_rx_manual, '手工药品', '5mg/kg', 'bid', 10, '支', 0);

  select * into v_row from public.issue_prescription(
    v_rx_manual, '99999999-0000-0000-0000-000000000043', '99999999-0000-0000-0000-000000000042', null);
  perform tests.assert_true(v_row.status = 'issued', 'P10:手工条目处方应可开具');

  select * into v_row from public.dispense_prescription(v_rx_manual, '99999999-0000-0000-0000-000000000042');
  perform tests.assert_true(v_row.status = 'dispensed', 'P10:无阻断处方应可发药');

  -- rx_c:已 issued(物种禁忌在 issue 阶段豁免)→ dispense 阶段快速重检仍阻断
  perform tests.assert_raises(
    $sql$select public.dispense_prescription('99999999-0000-0000-0000-00000000004e'::uuid, '99999999-0000-0000-0000-000000000042'::uuid)$sql$,
    'MEDICATION_SAFETY_BLOCKED', 'P10:发药阶段物种禁忌未豁免应被阻止');

  -- 豁免 dispense 阶段检查 → 发药放行(手工条目场景验证门禁放行路径)
  select id into v_check_id from public.medication_safety_checks
  where prescription_id = v_rx_c and check_stage = 'dispense'
    and rule_code = 'species_contraindication' and status = 'triggered' limit 1;
  perform tests.assert_true(v_check_id is not null, 'P10:应存在 dispense 阶段物种禁忌检查');
  perform public.override_medication_safety_check(v_check_id, '99999999-0000-0000-0000-000000000042', '发药前二次评估,维持原用药方案');
  perform tests.assert_true(
    (select status from public.dispense_prescription(v_rx_c, '99999999-0000-0000-0000-000000000042')) = 'dispensed',
    'P10:豁免 dispense 阻断后应可发药');
end;
$$;

-- ============================================================
-- Part 13:P11 重复豁免拒绝(同一 check 仅一次)
-- ============================================================
do $$
declare
  v_check_id uuid;
begin
  execute 'reset role';
  select c.id into v_check_id
  from public.medication_safety_checks c
  where c.prescription_id = '99999999-0000-0000-0000-00000000004e'
    and c.check_stage = 'issue'
    and c.rule_code = 'species_contraindication'
  limit 1;
  perform tests.assert_raises(
    format($sql$select public.override_medication_safety_check('%s'::uuid, '99999999-0000-0000-0000-000000000042'::uuid, '再次豁免')$sql$, v_check_id),
    'CHECK_NOT_TRIGGERED', 'P11:已豁免检查不可重复豁免');
end;
$$;

-- ============================================================
-- 全部通过(单事务,回滚无残留)
-- ============================================================
raise notice 'MEDICATION_SAFETY_TESTS: ALL PASS';
rollback;
