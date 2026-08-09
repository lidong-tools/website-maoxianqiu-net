-- ============================================================
-- 20260810000211_medication_safety_rpc.sql
-- Agent-04 用药安全(Stage-04 S3.2)规则引擎 RPC + 处方门禁
--
-- 依赖: 20260810000210_medication_safety_base.sql(表/权限/种子)
--
-- 目标:
--   * evaluate_medication_safety —— 确定性规则引擎,按 check_stage
--     (draft/issue/dispense)执行,将结果 upsert 到 medication_safety_checks;
--   * override_medication_safety_check —— 阻断豁免(reason 必填 + 审计);
--   * 重定义 issue_prescription / dispense_prescription(保持原签名),
--     在 DB 层强制门禁:未豁免的阻断检查必须拒绝开具/发药,
--     前端不调用 evaluate 直接 issue/dispense 也会被服务端阻止;
--   * 规则/药品档案/交互禁忌 CRUD RPC(service-role-only);
--   * 全部新增 RPC 显式 revoke public/anon/authenticated + grant service_role。
--
-- 非目标:
--   * 不重建第二套 Prescription,不修改已交付 migration 01~121;
--   * 无法自动校验剂量时不默认 PASS,而是写 warning 级"无法自动校验剂量";
--   * 本引擎只做"医院可配置 + 系统基础规则",不替代兽医判断。
-- ============================================================

-- ============================================================
-- 1. ms_parse_dose_mg_per_kg 剂量文本解析辅助(仅内部调用)
--    从自由文本 dosage 中提取 mg/kg(或 mg + 体重换算)。
--    返回 null = 无法可靠解析(调用方必须按"无法自动校验剂量"处理)。
--    支持:10mg/kg、5 毫克/千克、0.5g、10mg(需体重换算)、200 毫克 等。
-- ============================================================
create or replace function public.ms_parse_dose_mg_per_kg(p_dosage text, p_weight_kg numeric)
returns numeric
language plpgsql
immutable
set search_path = public
as $$
declare
  v_text text;
  v_num numeric;
  v_unit text;
  v_per_kg text;
  v_mg numeric;
begin
  if p_dosage is null or btrim(p_dosage) = '' then
    return null;
  end if;
  v_text := lower(btrim(p_dosage));
  select m[1], m[2], m[3]
  into v_num, v_unit, v_per_kg
  from regexp_matches(
    v_text,
    '([0-9]+(?:\.[0-9]+)?)\s*(mg|毫克|g|克|ml|毫升|iu|国际单位|u|单位)?\s*(?:/\s*(kg|千克|公斤))?'
  ) as m
  limit 1;

  if v_num is null then
    return null;
  end if;

  -- 统一换算为 mg;体积/国际单位无法换算为 mg,返回 null
  if v_unit is null then
    return null;
  elsif v_unit in ('mg', '毫克') then
    v_mg := v_num;
  elsif v_unit in ('g', '克') then
    v_mg := v_num * 1000;
  else
    return null;
  end if;

  if v_per_kg is not null then
    return v_mg;                                     -- 直接 mg/kg
  end if;
  if p_weight_kg is not null and p_weight_kg > 0 then
    return v_mg / p_weight_kg;                       -- mg + 体重换算 mg/kg
  end if;
  return null;
end;
$$;

-- ============================================================
-- 2. ms_record_check 检查结果 upsert 辅助(仅内部调用)
--    幂等键 (prescription_id, check_stage, rule_id, item_index);
--    返回键 "rule_id:item_index",供 evaluate 判定"已消失的触发"。
-- ============================================================
create or replace function public.ms_record_check(
  p_tenant_id uuid,
  p_store_id uuid,
  p_prescription_id uuid,
  p_encounter_id uuid,
  p_pet_id uuid,
  p_stage text,
  p_rule_id uuid,
  p_rule_version integer,
  p_rule_code text,
  p_rule_type text,
  p_severity text,
  p_blocking boolean,
  p_item_index integer,
  p_message text,
  p_recommendation text,
  p_context jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.medication_safety_checks (
    tenant_id, store_id, prescription_id, encounter_id, pet_id, check_stage,
    rule_id, rule_version, rule_code, rule_type, severity, blocking, status,
    item_index, message_snapshot, recommendation_snapshot, context_snapshot
  )
  values (
    p_tenant_id, p_store_id, p_prescription_id, p_encounter_id, p_pet_id, p_stage,
    p_rule_id, p_rule_version, p_rule_code, p_rule_type, p_severity, p_blocking, 'triggered',
    p_item_index, p_message, p_recommendation, p_context
  )
  on conflict (prescription_id, check_stage, rule_id, item_index)
  do update set
    rule_version = excluded.rule_version,
    rule_code = excluded.rule_code,
    rule_type = excluded.rule_type,
    severity = excluded.severity,
    blocking = excluded.blocking,
    status = 'triggered',
    message_snapshot = excluded.message_snapshot,
    recommendation_snapshot = excluded.recommendation_snapshot,
    context_snapshot = excluded.context_snapshot,
    updated_at = now();

  return coalesce(p_rule_id::text, '') || ':' || p_item_index::text;
end;
$$;

-- ============================================================
-- 3. evaluate_medication_safety 确定性规则引擎
--    p_stage: draft(草稿提示)/issue(开具门禁)/dispense(发药快速重检)
--
--    规则执行(与 medication_safety_rules.rule_type 一一对应):
--      duplicate_drug           同一处方 catalog_item_id 或归一化药名重复
--      duplicate_ingredient     不同药品命中同一 active_ingredient(阻断)
--      dose_range               按 mg/kg 范围校验;无法解析 → "无法自动校验剂量"
--      duration_limit           疗程上限(规则全局值,档案 max_duration_days 可收紧)
--      frequency_limit          每日频次上限
--      species_contraindication 档案物种禁忌(阻断)
--      age_constraint           年龄(月)上下限
--      weight_constraint        体重上下限
--      antimicrobial_notice     抗菌药提示(记录指征)
--      drug_interaction         命中相互作用禁忌(阻断)
--
--    返回 jsonb:
--      prescription_id / stage / total / blocking_unresolved /
--      unable_to_evaluate / checks(触发且未豁免的检查明细)
-- ============================================================
create or replace function public.evaluate_medication_safety(
  p_prescription_id uuid,
  p_stage text default 'draft'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rx public.prescriptions;
  v_pet public.pets;
  v_age_months numeric;
  v_keys text[] := '{}';
  v_key text;
  v_total integer;
  v_blocking_unresolved integer;
  v_unable integer := 0;
  v_rule record;
  v_item record;
  v_profile record;
  v_dup record;
  v_pair record;
  v_mg_per_kg numeric;
  v_freq numeric;
  v_freq_text text;
  v_limit numeric;
  v_ctx jsonb;
begin
  if p_stage not in ('draft', 'issue', 'dispense') then
    raise exception 'INVALID_CHECK_STAGE' using errcode = 'P0003';
  end if;

  select * into v_rx from public.prescriptions where id = p_prescription_id;
  if not found then
    raise exception 'PRESCRIPTION_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 惰性种子默认规则(幂等),保证任何租户进入处方流程即有安全基线
  perform public.ensure_medication_safety_rules(v_rx.tenant_id);

  select * into v_pet from public.pets where id = v_rx.pet_id;
  if found and v_pet.birth_date is not null then
    v_age_months := date_part('epoch', now() - v_pet.birth_date) / (30.44 * 86400);
  end if;

  for v_rule in
    select r.id, r.code, r.rule_type, r.severity, r.is_blocking, r.species,
           r.current_version, rv.condition, rv.message, rv.recommendation
    from public.medication_safety_rules r
    join public.medication_safety_rule_versions rv
      on rv.rule_id = r.id and rv.version = r.current_version
    where r.tenant_id = v_rx.tenant_id and r.active = true
    order by r.rule_type
  loop
    -- 物种限定:规则 species 非空且不含当前宠物物种 → 跳过该规则
    if v_rule.species is not null and array_length(v_rule.species, 1) > 0
       and (v_pet.species is null or not (v_pet.species = any(v_rule.species))) then
      continue;
    end if;

    -- ---------- 处方级规则 ----------
    -- duplicate_drug:同一药品(catalog 或归一化药名)重复
    if v_rule.rule_type = 'duplicate_drug' then
      for v_dup in
        select coalesce(pi.catalog_item_id::text, lower(btrim(pi.drug_name))) as k,
               count(*) as cnt,
               array_agg(pi.drug_name order by pi.sort_order) as names
        from public.prescription_items pi
        where pi.prescription_id = p_prescription_id
        group by coalesce(pi.catalog_item_id::text, lower(btrim(pi.drug_name)))
        having count(*) > 1
      loop
        v_ctx := jsonb_build_object('drugs', to_jsonb(v_dup.names), 'count', v_dup.cnt);
        v_key := public.ms_record_check(
          v_rx.tenant_id, v_rx.store_id, p_prescription_id, v_rx.encounter_id, v_rx.pet_id,
          p_stage, v_rule.id, v_rule.current_version, v_rule.code, v_rule.rule_type,
          v_rule.severity, v_rule.is_blocking, 0,
          coalesce(v_rule.message, '同一处方内重复开具相同药品'),
          v_rule.recommendation, v_ctx);
        v_keys := v_keys || v_key;
      end loop;
      continue;
    end if;

    -- duplicate_ingredient:不同药品命中同一活性成分
    if v_rule.rule_type = 'duplicate_ingredient' then
      for v_dup in
        select lower(btrim(dp.active_ingredient)) as ing,
               count(distinct pi.catalog_item_id) as drug_cnt,
               array_agg(distinct pi.drug_name) as names
        from public.prescription_items pi
        join public.drug_profiles dp
          on dp.catalog_item_id = pi.catalog_item_id and dp.tenant_id = v_rx.tenant_id
        where pi.prescription_id = p_prescription_id
          and pi.catalog_item_id is not null
          and dp.active_ingredient is not null and btrim(dp.active_ingredient) <> ''
        group by lower(btrim(dp.active_ingredient))
        having count(distinct pi.catalog_item_id) > 1
      loop
        v_ctx := jsonb_build_object('ingredient', v_dup.ing, 'drugs', to_jsonb(v_dup.names));
        v_key := public.ms_record_check(
          v_rx.tenant_id, v_rx.store_id, p_prescription_id, v_rx.encounter_id, v_rx.pet_id,
          p_stage, v_rule.id, v_rule.current_version, v_rule.code, v_rule.rule_type,
          v_rule.severity, v_rule.is_blocking, 0,
          coalesce(v_rule.message, '同一处方内存在相同活性成分的药品'),
          v_rule.recommendation, v_ctx);
        v_keys := v_keys || v_key;
      end loop;
      continue;
    end if;

    -- drug_interaction:处方内药品成分命中相互作用禁忌
    if v_rule.rule_type = 'drug_interaction' then
      for v_pair in
        select distinct least(a.ing, b.ing) as ia, greatest(a.ing, b.ing) as ib
        from (
          select pi.id as item_id, lower(btrim(dp.active_ingredient)) as ing
          from public.prescription_items pi
          join public.drug_profiles dp
            on dp.catalog_item_id = pi.catalog_item_id and dp.tenant_id = v_rx.tenant_id
          where pi.prescription_id = p_prescription_id
            and pi.catalog_item_id is not null
            and dp.active_ingredient is not null and btrim(dp.active_ingredient) <> ''
        ) a
        join (
          select pi.id as item_id, lower(btrim(dp.active_ingredient)) as ing
          from public.prescription_items pi
          join public.drug_profiles dp
            on dp.catalog_item_id = pi.catalog_item_id and dp.tenant_id = v_rx.tenant_id
          where pi.prescription_id = p_prescription_id
            and pi.catalog_item_id is not null
            and dp.active_ingredient is not null and btrim(dp.active_ingredient) <> ''
        ) b on a.item_id < b.item_id and a.ing <> b.ing
        join public.medication_drug_interactions mdi
          on mdi.tenant_id = v_rx.tenant_id and mdi.active = true
         and lower(btrim(mdi.ingredient_a)) = least(a.ing, b.ing)
         and lower(btrim(mdi.ingredient_b)) = greatest(a.ing, b.ing)
      loop
        v_ctx := jsonb_build_object('ingredient_a', v_pair.ia, 'ingredient_b', v_pair.ib);
        v_key := public.ms_record_check(
          v_rx.tenant_id, v_rx.store_id, p_prescription_id, v_rx.encounter_id, v_rx.pet_id,
          p_stage, v_rule.id, v_rule.current_version, v_rule.code, v_rule.rule_type,
          v_rule.severity, v_rule.is_blocking, 0,
          coalesce(v_rule.message, '处方内药品之间存在已知相互作用'),
          v_rule.recommendation, v_ctx);
        v_keys := v_keys || v_key;
      end loop;
      continue;
    end if;

    -- ---------- 逐项规则(item 级,item_index = sort_order + 1) ----------
    for v_item in
      select pi.id, pi.catalog_item_id, pi.drug_name, pi.dosage, pi.frequency,
             pi.duration_days, pi.quantity, pi.unit, pi.sort_order
      from public.prescription_items pi
      where pi.prescription_id = p_prescription_id
      order by pi.sort_order, pi.id
    loop
      v_profile := null;
      if v_item.catalog_item_id is not null then
        select * into v_profile from public.drug_profiles
        where tenant_id = v_rx.tenant_id and catalog_item_id = v_item.catalog_item_id;
      end if;

      -- dose_range:档案有 mg/kg 范围才检查;无法解析 → warning 级"无法自动校验剂量"
      if v_rule.rule_type = 'dose_range'
         and v_profile.id is not null
         and (v_profile.min_dose_mg_kg is not null or v_profile.max_dose_mg_kg is not null) then
        v_mg_per_kg := public.ms_parse_dose_mg_per_kg(v_item.dosage, v_pet.weight);
        v_ctx := jsonb_build_object(
          'drug', v_item.drug_name,
          'dosage', v_item.dosage,
          'weight_kg', v_pet.weight,
          'min_dose_mg_kg', v_profile.min_dose_mg_kg,
          'max_dose_mg_kg', v_profile.max_dose_mg_kg,
          'parsed_mg_per_kg', v_mg_per_kg);
        if v_mg_per_kg is null then
          -- 关键策略:无法可靠解析剂量 → 不默认 PASS,提示人工核对(§9)
          v_key := public.ms_record_check(
            v_rx.tenant_id, v_rx.store_id, p_prescription_id, v_rx.encounter_id, v_rx.pet_id,
            p_stage, v_rule.id, v_rule.current_version, v_rule.code, v_rule.rule_type,
            'warning', false, v_item.sort_order + 1,
            '无法自动校验剂量,请人工核对',
            coalesce(v_rule.recommendation, '按体重核对剂量后确认'), v_ctx);
          v_keys := v_keys || v_key;
          v_unable := v_unable + 1;
        elsif (v_profile.min_dose_mg_kg is not null and v_mg_per_kg < v_profile.min_dose_mg_kg)
           or (v_profile.max_dose_mg_kg is not null and v_mg_per_kg > v_profile.max_dose_mg_kg) then
          v_key := public.ms_record_check(
            v_rx.tenant_id, v_rx.store_id, p_prescription_id, v_rx.encounter_id, v_rx.pet_id,
            p_stage, v_rule.id, v_rule.current_version, v_rule.code, v_rule.rule_type,
            v_rule.severity, v_rule.is_blocking, v_item.sort_order + 1,
            coalesce(v_rule.message, '药品剂量超出参考范围'),
            v_rule.recommendation, v_ctx);
          v_keys := v_keys || v_key;
        end if;
      end if;

      -- duration_limit:全局上限(规则 condition),档案 max_duration_days 可收紧
      if v_rule.rule_type = 'duration_limit' then
        v_limit := nullif(v_rule.condition->>'max_duration_days', '')::numeric;
        if v_profile.id is not null and v_profile.max_duration_days is not null then
          v_limit := least(v_limit, v_profile.max_duration_days);
        end if;
        if v_limit is not null and v_item.duration_days is not null
           and v_item.duration_days > v_limit then
          v_ctx := jsonb_build_object(
            'drug', v_item.drug_name,
            'duration_days', v_item.duration_days,
            'max_duration_days', v_limit);
          v_key := public.ms_record_check(
            v_rx.tenant_id, v_rx.store_id, p_prescription_id, v_rx.encounter_id, v_rx.pet_id,
            p_stage, v_rule.id, v_rule.current_version, v_rule.code, v_rule.rule_type,
            v_rule.severity, v_rule.is_blocking, v_item.sort_order + 1,
            coalesce(v_rule.message, '用药疗程超过上限'),
            v_rule.recommendation, v_ctx);
          v_keys := v_keys || v_key;
        end if;
      end if;

      -- frequency_limit:每日频次上限(规则 condition)
      if v_rule.rule_type = 'frequency_limit' then
        v_limit := nullif(v_rule.condition->>'max_daily_frequency', '')::numeric;
        v_freq := null;
        if v_limit is not null and v_item.frequency is not null then
          v_freq_text := lower(btrim(v_item.frequency));
          if v_freq_text in ('qid', 'q6h', '每日4次', '一天4次', '每天4次', '日4次') then
            v_freq := 4;
          elsif v_freq_text in ('tid', 'q8h', '每日3次', '一天3次', '每天3次', '日3次') then
            v_freq := 3;
          elsif v_freq_text in ('bid', 'q12h', '每日2次', '一天2次', '每天2次', '日2次') then
            v_freq := 2;
          elsif v_freq_text in ('sid', 'qd', 'q24h', '每日1次', '一天1次', '每天1次', '日1次') then
            v_freq := 1;
          else
            select m[1]::numeric into v_freq
            from regexp_matches(v_freq_text, '([0-9]+)\s*次') as m
            limit 1;
            if v_freq is not null and (v_freq < 1 or v_freq > 12) then
              v_freq := null;
            end if;
          end if;
        end if;
        if v_freq is not null and v_freq > v_limit then
          v_ctx := jsonb_build_object(
            'drug', v_item.drug_name,
            'frequency', v_item.frequency,
            'parsed_daily_frequency', v_freq,
            'max_daily_frequency', v_limit);
          v_key := public.ms_record_check(
            v_rx.tenant_id, v_rx.store_id, p_prescription_id, v_rx.encounter_id, v_rx.pet_id,
            p_stage, v_rule.id, v_rule.current_version, v_rule.code, v_rule.rule_type,
            v_rule.severity, v_rule.is_blocking, v_item.sort_order + 1,
            coalesce(v_rule.message, '用药频次超过每日上限'),
            v_rule.recommendation, v_ctx);
          v_keys := v_keys || v_key;
        end if;
      end if;

      -- species_contraindication:档案物种禁忌
      if v_rule.rule_type = 'species_contraindication'
         and v_profile.id is not null
         and v_pet.species is not null
         and v_pet.species = any(v_profile.species_contraindications) then
        v_ctx := jsonb_build_object(
          'drug', v_item.drug_name,
          'species', v_pet.species,
          'contraindicated_species', v_profile.species_contraindications);
        v_key := public.ms_record_check(
          v_rx.tenant_id, v_rx.store_id, p_prescription_id, v_rx.encounter_id, v_rx.pet_id,
          p_stage, v_rule.id, v_rule.current_version, v_rule.code, v_rule.rule_type,
          v_rule.severity, v_rule.is_blocking, v_item.sort_order + 1,
          coalesce(v_rule.message, '该药品对该物种存在禁忌'),
          v_rule.recommendation, v_ctx);
        v_keys := v_keys || v_key;
      end if;

      -- age_constraint:年龄(月)上下限
      if v_rule.rule_type = 'age_constraint'
         and v_profile.id is not null
         and v_age_months is not null
         and ((v_profile.min_age_months is not null and v_age_months < v_profile.min_age_months)
           or (v_profile.max_age_months is not null and v_age_months > v_profile.max_age_months)) then
        v_ctx := jsonb_build_object(
          'drug', v_item.drug_name,
          'age_months', v_age_months,
          'min_age_months', v_profile.min_age_months,
          'max_age_months', v_profile.max_age_months);
        v_key := public.ms_record_check(
          v_rx.tenant_id, v_rx.store_id, p_prescription_id, v_rx.encounter_id, v_rx.pet_id,
          p_stage, v_rule.id, v_rule.current_version, v_rule.code, v_rule.rule_type,
          v_rule.severity, v_rule.is_blocking, v_item.sort_order + 1,
          coalesce(v_rule.message, '该药品不适用于当前年龄的宠物'),
          v_rule.recommendation, v_ctx);
        v_keys := v_keys || v_key;
      end if;

      -- weight_constraint:体重上下限
      if v_rule.rule_type = 'weight_constraint'
         and v_profile.id is not null
         and v_pet.weight is not null
         and ((v_profile.min_weight_kg is not null and v_pet.weight < v_profile.min_weight_kg)
           or (v_profile.max_weight_kg is not null and v_pet.weight > v_profile.max_weight_kg)) then
        v_ctx := jsonb_build_object(
          'drug', v_item.drug_name,
          'weight_kg', v_pet.weight,
          'min_weight_kg', v_profile.min_weight_kg,
          'max_weight_kg', v_profile.max_weight_kg);
        v_key := public.ms_record_check(
          v_rx.tenant_id, v_rx.store_id, p_prescription_id, v_rx.encounter_id, v_rx.pet_id,
          p_stage, v_rule.id, v_rule.current_version, v_rule.code, v_rule.rule_type,
          v_rule.severity, v_rule.is_blocking, v_item.sort_order + 1,
          coalesce(v_rule.message, '该药品不适用于当前体重的宠物'),
          v_rule.recommendation, v_ctx);
        v_keys := v_keys || v_key;
      end if;

      -- antimicrobial_notice:抗菌药物提示(默认 info,记录用药指征)
      if v_rule.rule_type = 'antimicrobial_notice'
         and v_profile.id is not null
         and v_profile.antimicrobial_class is not null
         and btrim(v_profile.antimicrobial_class) <> '' then
        v_ctx := jsonb_build_object(
          'drug', v_item.drug_name,
          'antimicrobial_class', v_profile.antimicrobial_class);
        v_key := public.ms_record_check(
          v_rx.tenant_id, v_rx.store_id, p_prescription_id, v_rx.encounter_id, v_rx.pet_id,
          p_stage, v_rule.id, v_rule.current_version, v_rule.code, v_rule.rule_type,
          v_rule.severity, v_rule.is_blocking, v_item.sort_order + 1,
          coalesce(v_rule.message, '开具抗菌药物,请在病历中记录用药指征'),
          v_rule.recommendation, v_ctx);
        v_keys := v_keys || v_key;
      end if;
    end loop;
  end loop;

  -- 已消失的 triggered 检查 → resolved(overridden 历史保留)
  update public.medication_safety_checks c
  set status = 'resolved', updated_at = now()
  where c.prescription_id = p_prescription_id
    and c.check_stage = p_stage
    and c.status = 'triggered'
    and not (coalesce(c.rule_id::text, '') || ':' || c.item_index::text = any(v_keys));

  -- 统计触发且未豁免的阻断检查(门禁依据)
  select count(*), count(*) filter (where blocking)
  into v_total, v_blocking_unresolved
  from public.medication_safety_checks
  where prescription_id = p_prescription_id
    and check_stage = p_stage
    and status = 'triggered';

  return jsonb_build_object(
    'prescription_id', p_prescription_id,
    'stage', p_stage,
    'total', v_total,
    'blocking_unresolved', v_blocking_unresolved,
    'unable_to_evaluate', v_unable,
    'checks', (
      select coalesce(jsonb_agg(to_jsonb(c) order by c.item_index, c.rule_code), '[]'::jsonb)
      from public.medication_safety_checks c
      where c.prescription_id = p_prescription_id
        and c.check_stage = p_stage
        and c.status = 'triggered'
    )
  );
end;
$$;

-- ============================================================
-- 4. override_medication_safety_check 阻断豁免
--    前置:reason 必填;仅 triggered 状态可豁免;同一 check 仅一次。
--    权限(medication_safety.override)在 Hono 层校验。
-- ============================================================
create or replace function public.override_medication_safety_check(
  p_check_id uuid,
  p_operator_user_id uuid,
  p_reason text
)
returns public.medication_safety_checks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_check public.medication_safety_checks;
  v_emp_id uuid;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'OVERRIDE_REASON_REQUIRED' using errcode = 'P0003';
  end if;

  select * into v_check from public.medication_safety_checks where id = p_check_id for update;
  if not found then
    raise exception 'CHECK_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_check.status <> 'triggered' then
    raise exception 'CHECK_NOT_TRIGGERED' using errcode = 'P0003';
  end if;

  -- 豁免人:由登录用户反查在职员工(服务端推导,禁止前端指定)
  select e.id into v_emp_id from public.employees e
  where e.user_id = p_operator_user_id and e.tenant_id = v_check.tenant_id and e.status = 'active'
  limit 1;

  update public.medication_safety_checks
  set status = 'overridden', updated_at = now()
  where id = p_check_id
  returning * into v_check;

  insert into public.medication_safety_overrides (
    tenant_id, check_id, override_by, override_by_employee_id, reason
  )
  values (v_check.tenant_id, p_check_id, p_operator_user_id, v_emp_id, btrim(p_reason));

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_check.tenant_id, v_check.store_id, p_operator_user_id, 'medication_safety.override',
          'medication_safety_check', p_check_id,
          jsonb_build_object('rule_code', v_check.rule_code, 'rule_type', v_check.rule_type,
                             'blocking', v_check.blocking,
                             'reason', btrim(p_reason),
                             'override_by_employee_id', v_emp_id));

  return v_check;
end;
$$;

-- ============================================================
-- 5. 重定义 issue_prescription(保持原签名)
--    新增门禁:issue 阶段未豁免的阻断检查必须拒绝开具。
--    其余逻辑(有效兽医备案/受控药/有效期/保存期)与 migration 29 完全一致。
-- ============================================================
create or replace function public.issue_prescription(
  p_prescription_id uuid,
  p_prescriber_employee_id uuid,
  p_prescriber_user_id uuid,
  p_valid_until timestamptz default null
)
returns public.prescriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.prescriptions;
  v_emp_exists boolean;
  v_reg public.veterinarian_registrations;
  v_has_controlled boolean;
  v_controlled_classes text[];
  v_non_controlled_count integer;
  v_narcotic_count integer;
  v_item record;
  v_retention_until timestamptz;
  v_ms_result jsonb;
begin
  select * into v_row from public.prescriptions where id = p_prescription_id for update;
  if not found then
    raise exception 'PRESCRIPTION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.status <> 'draft' then
    raise exception 'PRESCRIPTION_NOT_DRAFT' using errcode = 'P0003';
  end if;

  -- 开方人必须属于该租户且为在职员工
  select exists(
    select 1 from public.employees
    where id = p_prescriber_employee_id and tenant_id = v_row.tenant_id and status = 'active'
  ) into v_emp_exists;
  if not v_emp_exists then
    raise exception 'PRESCRIBER_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 有效执业兽医备案(必须;不得仅凭 role='doctor')
  select * into v_reg from public.veterinarian_registrations
  where tenant_id = v_row.tenant_id and employee_id = p_prescriber_employee_id
    and status = 'active'
    and valid_from <= (now() at time zone 'Asia/Shanghai')::date
    and (valid_until is null or valid_until >= (now() at time zone 'Asia/Shanghai')::date)
  limit 1;
  if not found then
    raise exception 'PRESCRIBER_NOT_REGISTERED' using errcode = 'P0003';
  end if;

  -- 受控药品规则:单独处方 / 麻醉一日量
  v_has_controlled := false;
  v_narcotic_count := 0;
  select
    bool_or(cde.controlled_class is not null and cde.controlled_class <> 'none') into v_has_controlled
  from public.prescription_items pi
  join public.catalog_items ci on ci.id = pi.catalog_item_id
  left join public.catalog_drug_extensions cde on cde.catalog_item_id = ci.id
  where pi.prescription_id = p_prescription_id;

  if v_has_controlled then
    select array_agg(distinct cde.controlled_class order by cde.controlled_class) into v_controlled_classes
    from public.prescription_items pi
    join public.catalog_items ci on ci.id = pi.catalog_item_id
    join public.catalog_drug_extensions cde on cde.catalog_item_id = ci.id
    where pi.prescription_id = p_prescription_id
      and cde.controlled_class is not null and cde.controlled_class <> 'none';

    if array_length(v_controlled_classes, 1) > 1 then
      raise exception 'CONTROLLED_MIX_CLASS' using errcode = 'P0003';
    end if;

    select count(*) into v_non_controlled_count
    from public.prescription_items pi
    join public.catalog_items ci on ci.id = pi.catalog_item_id
    left join public.catalog_drug_extensions cde on cde.catalog_item_id = ci.id
    where pi.prescription_id = p_prescription_id
      and (cde.controlled_class is null or cde.controlled_class = 'none');
    if v_non_controlled_count > 0 then
      raise exception 'CONTROLLED_MIX_REGULAR' using errcode = 'P0003';
    end if;

    if 'narcotic' = any(v_controlled_classes) then
      select count(*) into v_narcotic_count
      from public.prescription_items
      where prescription_id = p_prescription_id
        and (duration_days is null or duration_days > 1);
      if v_narcotic_count > 0 then
        raise exception 'NARCOTIC_DAILY_LIMIT' using errcode = 'P0003';
      end if;
    end if;
  end if;

  -- 有效期规则(F03:默认当日结束/72h 硬上限/过去时间拒绝)
  if p_valid_until is not null and p_valid_until <= now() then
    raise exception 'PRESCRIPTION_VALIDITY_IN_PAST' using errcode = 'P0003';
  end if;
  if p_valid_until is not null and p_valid_until > now() + interval '3 days' then
    raise exception 'VALIDITY_EXCEEDS_MAX' using errcode = 'P0003';
  end if;

  -- Agent-04 用药安全门禁:issue 阶段未豁免的阻断检查必须拒绝开具
  -- (即使前端不调用 evaluate 直接 issue,服务端也会在此阻止)
  v_ms_result := public.evaluate_medication_safety(p_prescription_id, 'issue');
  if (v_ms_result->>'blocking_unresolved')::int > 0 then
    raise exception 'MEDICATION_SAFETY_BLOCKED: 存在未豁免的阻断性用药安全检查,请处理后再开具'
      using errcode = 'P0003';
  end if;

  -- 保存期:受控 5 年,普通 3 年
  v_retention_until := now() + case when v_has_controlled then interval '5 years' else interval '3 years' end;

  update public.prescriptions
  set status = 'issued',
      issued_at = now(),
      valid_until = coalesce(
        p_valid_until,
        (date_trunc('day', now() at time zone 'Asia/Shanghai') + interval '1 day' - interval '1 second')
          at time zone 'Asia/Shanghai'
      ),
      prescriber_employee_id = p_prescriber_employee_id,
      prescriber_user_id = p_prescriber_user_id,
      prescriber_veterinarian_registration_id = v_reg.id,
      signed_at = now(),
      signature_method = 'manual',
      retention_until = v_retention_until,
      retention_status = 'active',
      updated_at = now()
  where id = p_prescription_id
  returning * into v_row;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_row.tenant_id, v_row.store_id, p_prescriber_user_id, 'prescription.issue', 'prescription', p_prescription_id,
          jsonb_build_object('prescriber_employee_id', p_prescriber_employee_id,
                             'veterinarian_registration_id', v_reg.id,
                             'valid_until', v_row.valid_until,
                             'controlled', v_has_controlled,
                             'retention_until', v_retention_until,
                             'medication_safety', v_ms_result));

  return v_row;
end;
$$;

-- ============================================================
-- 6. 重定义 dispense_prescription(保持原签名)
--    新增门禁:发药快速重检,未豁免的阻断检查必须拒绝发药。
--    其余逻辑(仅 issued/未过期/仓库/单事务库存扣减)与 migration 29 一致。
-- ============================================================
create or replace function public.dispense_prescription(
  p_prescription_id uuid,
  p_operator_id uuid default null
)
returns public.prescriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.prescriptions;
  v_dispenser_employee_id uuid;
  v_item record;
  v_wh public.warehouses;
  v_reserve uuid;
  v_result jsonb;
  v_dispensed_items integer := 0;
  v_skipped_items integer := 0;
  v_ms_result jsonb;
begin
  -- 锁定处方(整单单事务:状态 + 库存扣减原子提交/回滚)
  select * into v_row from public.prescriptions where id = p_prescription_id for update;
  if not found then
    raise exception 'PRESCRIPTION_NOT_FOUND' using errcode = 'P0002';
  end if;
  -- R04:仅 issued 处方可发药(draft 必须先开具,禁止直接发药)
  if v_row.status <> 'issued' then
    raise exception 'PRESCRIPTION_NOT_DISPENSABLE' using errcode = 'P0003';
  end if;
  -- 已开具处方必须未过期
  if v_row.valid_until is null then
    raise exception 'PRESCRIPTION_EXPIRED' using errcode = 'P0003';
  end if;
  if v_row.valid_until < now() then
    raise exception 'PRESCRIPTION_EXPIRED' using errcode = 'P0003';
  end if;

  -- Agent-04 用药安全门禁:发药快速重检(基于最新规则/药品档案),
  -- 未豁免的阻断检查必须拒绝发药(即使前端绕过 evaluate 直接 dispense)
  v_ms_result := public.evaluate_medication_safety(p_prescription_id, 'dispense');
  if (v_ms_result->>'blocking_unresolved')::int > 0 then
    raise exception 'MEDICATION_SAFETY_BLOCKED: 存在未豁免的阻断性用药安全检查,请处理后再发药'
      using errcode = 'P0003';
  end if;

  -- 发药员工:由登录用户(p_operator_id)反查在职员工,服务端推导
  select e.id into v_dispenser_employee_id from public.employees e
  where e.user_id = p_operator_id and e.tenant_id = v_row.tenant_id and e.status = 'active'
  limit 1;

  -- 发药仓库:优先门店仓库,其次租户下任意启用仓库(与既有 API 行为一致)
  select * into v_wh from public.warehouses
  where tenant_id = v_row.tenant_id and is_active = true
    and (v_row.store_id is null or store_id = v_row.store_id)
  order by case when v_row.store_id is not null and store_id = v_row.store_id then 0 else 1 end,
           is_default desc, created_at
  limit 1;

  -- 单事务库存扣减:逐项确认预留或即时发药(带 catalog_item_id 的药品条目)
  for v_item in
    select pi.id as item_id, pi.catalog_item_id, pi.quantity, pi.drug_name
    from public.prescription_items pi
    where pi.prescription_id = p_prescription_id
    order by pi.sort_order
  loop
    -- 纯手工药名条目(无 catalog_item_id)按产品规则允许不扣库存
    if v_item.catalog_item_id is null then
      v_skipped_items := v_skipped_items + 1;
      continue;
    end if;
    -- F02:库存商品若无可用仓库必须失败,禁止"无出库但标记 dispensed"
    if v_wh.id is null then
      raise exception 'DISPENSE_WAREHOUSE_NOT_FOUND' using errcode = 'P0003';
    end if;

    -- 优先确认该处方的预留流水(预留转正式扣减,FEFO 批次)
    select m.id into v_reserve
    from public.inventory_movements m
    where m.tenant_id = v_row.tenant_id
      and m.movement_type = 'reserve'
      and m.reference_type = 'prescription'
      and m.reference_id = p_prescription_id::text
      and m.catalog_item_id = v_item.catalog_item_id
    order by m.created_at
    limit 1;

    if v_reserve is not null then
      v_result := public.confirm_inventory_reservation(
        v_row.tenant_id, v_reserve, p_operator_id, null);
    else
      v_result := public.dispense_inventory(
        v_row.tenant_id, v_wh.id, v_item.catalog_item_id, v_item.quantity,
        'prescription', p_prescription_id::text, p_operator_id, null);
    end if;
    v_dispensed_items := v_dispensed_items + 1;
  end loop;

  -- 状态转换 + 发药信息(与库存扣减同事务)
  update public.prescriptions
  set status = 'dispensed',
      dispensed_by_employee_id = coalesce(v_dispenser_employee_id, dispensed_by_employee_id),
      dispensed_at = now(),
      updated_at = now()
  where id = p_prescription_id
  returning * into v_row;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_row.tenant_id, v_row.store_id, p_operator_id, 'prescription.dispense', 'prescription', p_prescription_id,
          jsonb_build_object('status', 'dispensed', 'valid_until', v_row.valid_until,
                             'dispensed_by_employee_id', v_row.dispensed_by_employee_id,
                             'dispensed_items', v_dispensed_items, 'skipped_items', v_skipped_items,
                             'medication_safety', v_ms_result));

  return v_row;
end;
$$;

-- ============================================================
-- 7. 规则管理 CRUD RPC(service-role-only,权限在 Hono 层校验)
-- ============================================================

-- 7.1 upsert_medication_safety_rule 创建/更新规则
--     更新时 current_version + 1 并 append 新版本(append-only 可追溯)
create or replace function public.upsert_medication_safety_rule(
  p_tenant_id uuid,
  p_rule_id uuid default null,
  p_code text default null,
  p_name text default null,
  p_rule_type text default null,
  p_severity text default 'warning',
  p_is_blocking boolean default false,
  p_species text[] default '{}',
  p_active boolean default true,
  p_condition jsonb default '{}'::jsonb,
  p_message text default null,
  p_recommendation text default null,
  p_operator_user_id uuid default null
)
returns public.medication_safety_rules
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rule public.medication_safety_rules;
  v_type_ok boolean;
begin
  if p_rule_id is null and (p_code is null or btrim(p_code) = '') then
    raise exception 'RULE_CODE_REQUIRED' using errcode = 'P0003';
  end if;
  select exists (
    select 1 from unnest(array[
      'duplicate_ingredient', 'duplicate_drug', 'dose_range', 'duration_limit',
      'frequency_limit', 'species_contraindication', 'age_constraint',
      'weight_constraint', 'antimicrobial_notice', 'drug_interaction'
    ]) as t(v) where t.v = p_rule_type
  ) into v_type_ok;
  if not v_type_ok then
    raise exception 'INVALID_RULE_TYPE' using errcode = 'P0003';
  end if;
  if p_severity not in ('info', 'warning', 'error') then
    raise exception 'INVALID_SEVERITY' using errcode = 'P0003';
  end if;

  -- 更新已有规则:版本 +1 并 append 新版本
  if p_rule_id is not null then
    select * into v_rule from public.medication_safety_rules
    where id = p_rule_id and tenant_id = p_tenant_id for update;
    if not found then
      raise exception 'RULE_NOT_FOUND' using errcode = 'P0002';
    end if;

    update public.medication_safety_rules
    set name = coalesce(p_name, name),
        severity = p_severity,
        is_blocking = p_is_blocking,
        species = p_species,
        active = p_active,
        current_version = current_version + 1,
        updated_at = now()
    where id = p_rule_id
    returning * into v_rule;

    insert into public.medication_safety_rule_versions (
      rule_id, version, condition, message, recommendation, effective_from, created_by
    )
    values (v_rule.id, v_rule.current_version, coalesce(p_condition, '{}'::jsonb),
            coalesce(p_message, v_rule.name), p_recommendation, now(), p_operator_user_id);
  else
    -- 新建:code 在租户内唯一
    if exists (
      select 1 from public.medication_safety_rules
      where tenant_id = p_tenant_id and code = btrim(p_code)
    ) then
      raise exception 'RULE_CODE_EXISTS' using errcode = 'P0003';
    end if;

    insert into public.medication_safety_rules (
      tenant_id, code, name, rule_type, severity, is_blocking, species, active,
      current_version, created_by
    )
    values (p_tenant_id, btrim(p_code), coalesce(p_name, p_code), p_rule_type,
            p_severity, p_is_blocking, p_species, p_active, 1, p_operator_user_id)
    returning * into v_rule;

    insert into public.medication_safety_rule_versions (
      rule_id, version, condition, message, recommendation, effective_from, created_by
    )
    values (v_rule.id, 1, coalesce(p_condition, '{}'::jsonb),
            coalesce(p_message, p_name), p_recommendation, now(), p_operator_user_id);
  end if;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (p_tenant_id, null, p_operator_user_id, 'medication_safety.rule.upsert',
          'medication_safety_rule', v_rule.id,
          jsonb_build_object('code', v_rule.code, 'rule_type', v_rule.rule_type,
                             'is_blocking', v_rule.is_blocking, 'version', v_rule.current_version));

  return v_rule;
end;
$$;

-- 7.2 set_medication_safety_rule_active 启停规则
create or replace function public.set_medication_safety_rule_active(
  p_rule_id uuid,
  p_active boolean,
  p_operator_user_id uuid default null
)
returns public.medication_safety_rules
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rule public.medication_safety_rules;
begin
  select * into v_rule from public.medication_safety_rules where id = p_rule_id for update;
  if not found then
    raise exception 'RULE_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.medication_safety_rules
  set active = p_active, updated_at = now()
  where id = p_rule_id
  returning * into v_rule;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_rule.tenant_id, null, p_operator_user_id, 'medication_safety.rule.toggle',
          'medication_safety_rule', p_rule_id,
          jsonb_build_object('code', v_rule.code, 'active', p_active));

  return v_rule;
end;
$$;

-- 7.3 upsert_drug_profile 药品安全档案维护
--     catalog_item_id 需属于该租户且 billing_type = 'drug'
create or replace function public.upsert_drug_profile(
  p_tenant_id uuid,
  p_catalog_item_id uuid,
  p_active_ingredient text default null,
  p_strength text default null,
  p_strength_unit text default null,
  p_route text default null,
  p_antimicrobial_class text default null,
  p_min_dose_mg_kg numeric default null,
  p_max_dose_mg_kg numeric default null,
  p_min_age_months integer default null,
  p_max_age_months integer default null,
  p_min_weight_kg numeric default null,
  p_max_weight_kg numeric default null,
  p_max_duration_days integer default null,
  p_species_contraindications text[] default '{}',
  p_operator_user_id uuid default null
)
returns public.drug_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_catalog_ok boolean;
  v_profile public.drug_profiles;
begin
  select exists (
    select 1 from public.catalog_items
    where id = p_catalog_item_id and tenant_id = p_tenant_id and billing_type = 'drug'
  ) into v_catalog_ok;
  if not v_catalog_ok then
    raise exception 'CATALOG_ITEM_NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_route is not null and p_route not in ('oral', 'injection', 'topical', 'other') then
    raise exception 'INVALID_ROUTE' using errcode = 'P0003';
  end if;
  if p_min_dose_mg_kg is not null and p_max_dose_mg_kg is not null
     and p_min_dose_mg_kg > p_max_dose_mg_kg then
    raise exception 'INVALID_DOSE_RANGE' using errcode = 'P0003';
  end if;

  insert into public.drug_profiles (
    tenant_id, catalog_item_id, active_ingredient, strength, strength_unit, route,
    antimicrobial_class, min_dose_mg_kg, max_dose_mg_kg, min_age_months, max_age_months,
    min_weight_kg, max_weight_kg, max_duration_days, species_contraindications
  )
  values (
    p_tenant_id, p_catalog_item_id,
    nullif(btrim(coalesce(p_active_ingredient, '')), ''),
    p_strength, p_strength_unit, p_route,
    nullif(btrim(coalesce(p_antimicrobial_class, '')), ''),
    p_min_dose_mg_kg, p_max_dose_mg_kg, p_min_age_months, p_max_age_months,
    p_min_weight_kg, p_max_weight_kg, p_max_duration_days,
    coalesce(p_species_contraindications, '{}')
  )
  on conflict (tenant_id, catalog_item_id)
  do update set
    active_ingredient = excluded.active_ingredient,
    strength = excluded.strength,
    strength_unit = excluded.strength_unit,
    route = excluded.route,
    antimicrobial_class = excluded.antimicrobial_class,
    min_dose_mg_kg = excluded.min_dose_mg_kg,
    max_dose_mg_kg = excluded.max_dose_mg_kg,
    min_age_months = excluded.min_age_months,
    max_age_months = excluded.max_age_months,
    min_weight_kg = excluded.min_weight_kg,
    max_weight_kg = excluded.max_weight_kg,
    max_duration_days = excluded.max_duration_days,
    species_contraindications = excluded.species_contraindications,
    updated_at = now()
  returning * into v_profile;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (p_tenant_id, null, p_operator_user_id, 'medication_safety.drug_profile.upsert',
          'drug_profile', v_profile.id,
          jsonb_build_object('catalog_item_id', p_catalog_item_id,
                             'active_ingredient', v_profile.active_ingredient));

  return v_profile;
end;
$$;

-- 7.4 upsert_drug_interaction 相互作用禁忌维护(ingredient 归一化,a<=b)
create or replace function public.upsert_drug_interaction(
  p_tenant_id uuid,
  p_ingredient_a text,
  p_ingredient_b text,
  p_severity text default 'warning',
  p_description text default null,
  p_active boolean default true,
  p_operator_user_id uuid default null
)
returns public.medication_drug_interactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_a text;
  v_b text;
  v_tmp text;
  v_row public.medication_drug_interactions;
begin
  v_a := lower(btrim(coalesce(p_ingredient_a, '')));
  v_b := lower(btrim(coalesce(p_ingredient_b, '')));
  if v_a = '' or v_b = '' then
    raise exception 'INGREDIENT_REQUIRED' using errcode = 'P0003';
  end if;
  if v_a = v_b then
    raise exception 'SAME_INGREDIENT' using errcode = 'P0003';
  end if;
  if p_severity not in ('info', 'warning', 'error') then
    raise exception 'INVALID_SEVERITY' using errcode = 'P0003';
  end if;
  -- 归一化存储:小者在前
  if v_a > v_b then
    v_tmp := v_a; v_a := v_b; v_b := v_tmp;
  end if;

  insert into public.medication_drug_interactions (
    tenant_id, ingredient_a, ingredient_b, severity, description, active
  )
  values (p_tenant_id, v_a, v_b, p_severity, p_description, p_active)
  on conflict (tenant_id, ingredient_a, ingredient_b)
  do update set
    severity = excluded.severity,
    description = coalesce(excluded.description, medication_drug_interactions.description),
    active = excluded.active,
    updated_at = now()
  returning * into v_row;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (p_tenant_id, null, p_operator_user_id, 'medication_safety.interaction.upsert',
          'medication_drug_interaction', v_row.id,
          jsonb_build_object('ingredient_a', v_a, 'ingredient_b', v_b, 'severity', p_severity));

  return v_row;
end;
$$;

-- ============================================================
-- 8. RPC 权限收紧:全部新增/重定义 RPC 仅 service_role 可执行
--    (helper 函数一并收紧,禁止浏览器直连)
-- ============================================================
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    -- Agent-04 用药安全引擎
    'evaluate_medication_safety',
    'override_medication_safety_check',
    'upsert_medication_safety_rule',
    'set_medication_safety_rule_active',
    'upsert_drug_profile',
    'upsert_drug_interaction',
    -- 重定义(保持 service-role-only,幂等)
    'issue_prescription',
    'dispense_prescription',
    -- 内部 helper(禁止浏览器直连)
    'ms_record_check',
    'ms_parse_dose_mg_per_kg',
    'ensure_medication_safety_rules'
  ]
  loop
    for v_sig in
      select p.oid::regprocedure::text
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = v_fn
        and p.prokind = 'f'
    loop
      execute format('revoke all on function %s from public', v_sig);
      execute format('revoke all on function %s from anon', v_sig);
      execute format('revoke all on function %s from authenticated', v_sig);
      execute format('grant execute on function %s to service_role', v_sig);
    end loop;
  end loop;
end;
$$;
