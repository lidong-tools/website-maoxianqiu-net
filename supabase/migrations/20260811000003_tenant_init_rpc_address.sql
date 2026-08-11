-- ============================================================
-- 20260811000003_tenant_init_rpc_address.sql
-- R-A1(3.1-04):initialize_tenant 支持医院地址入参
-- 在函数签名末尾追加 p_address / p_detail_address(带默认值,向后兼容既有调用),
-- 初始化时一并写入 tenants 地址,并将地址透传到首店(stores.address)。
-- 注意:旧迁移 20260809000036_tenant_init_rpc.sql 不得修改,此处 CREATE OR REPLACE 覆盖。
-- ============================================================
create or replace function public.initialize_tenant(
  p_tenant_id uuid,
  p_tenant_slug text default null,
  p_tenant_name text default null,
  p_store_name text default null,
  p_store_code text default null,
  p_owner_user_id uuid default null,
  p_owner_name text default null,
  p_owner_phone text default null,
  p_timezone text default 'Asia/Shanghai',
  p_operator_id uuid default null,
  p_idempotency_key text default null,
  p_address text default null,
  p_detail_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing jsonb;
  v_init public.tenant_initializations;
  v_tenant_id uuid;
  v_store_id uuid;
  v_employee_id uuid;
  v_role_id uuid;
  v_owner_user_id uuid;
  v_warehouse_id uuid;
  v_attempts integer;
  v_key text;
  v_advisory bigint;
begin
  -- ===== 0. 参数校验 =====
  if p_tenant_id is null and p_tenant_slug is null then
    raise exception 'TENANT_IDENTIFIER_REQUIRED' using errcode = 'P0003',
      detail = '必须提供 p_tenant_id 或 p_tenant_slug';
  end if;
  if p_store_name is null or trim(p_store_name) = '' then
    raise exception 'STORE_NAME_REQUIRED' using errcode = 'P0003';
  end if;
  if p_owner_user_id is null then
    raise exception 'OWNER_USER_REQUIRED' using errcode = 'P0003';
  end if;

  -- 租户存在性:优先按 id,否则按 slug(新建租户时平台管理员已先创建 tenants 行)
  if p_tenant_id is not null then
    select id into v_tenant_id from public.tenants where id = p_tenant_id;
  else
    select id into v_tenant_id from public.tenants where slug = p_tenant_slug;
  end if;
  if v_tenant_id is null then
    raise exception 'TENANT_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 时区/地址归一:仅在提供有效值时更新(幂等,平台管理员新建租户时传入)
  update public.tenants
  set timezone = coalesce(nullif(p_timezone, ''), timezone),
      address = coalesce(nullif(p_address, ''), address),
      detail_address = coalesce(nullif(p_detail_address, ''), detail_address)
  where id = v_tenant_id;

  -- 幂等键归一
  v_key := coalesce(nullif(p_idempotency_key, ''), 'tenant-init-' || v_tenant_id::text || '-' || gen_random_uuid()::text);

  -- ===== 1. 幂等检查(第一道:idempotency_records 缓存) =====
  select result_json into v_existing
  from public.idempotency_records
  where tenant_id = v_tenant_id
    and idempotency_key = v_key
  limit 1;
  if v_existing is not null then
    return v_existing;
  end if;

  -- ===== 2. 并发控制:同一租户+同一幂等键串行化 =====
  v_advisory := hashtextextended('tenant_init:' || v_tenant_id::text || ':' || v_key, 0);
  perform pg_advisory_xact_lock(v_advisory);

  -- 加锁后二次幂等检查(双检,防并发窗口)
  select result_json into v_existing
  from public.idempotency_records
  where tenant_id = v_tenant_id
    and idempotency_key = v_key
  limit 1;
  if v_existing is not null then
    return v_existing;
  end if;

  -- ===== 3. 初始化记录读取/恢复 =====
  -- 3a. 同幂等键已有记录:直接返回其状态(completed 幂等返回 / running 报进行中)
  select * into v_init
  from public.tenant_initializations
  where tenant_id = v_tenant_id and idempotency_key = v_key
  order by created_at desc
  limit 1;
  if v_init.id is not null then
    if v_init.status = 'completed' then
      return jsonb_build_object(
        'status', 'completed',
        'initializationId', v_init.id,
        'storeId', v_init.store_id,
        'tenantId', v_tenant_id
      );
    elsif v_init.status in ('pending', 'running') then
      raise exception 'TENANT_INIT_IN_PROGRESS' using errcode = 'P0003',
        detail = format('租户初始化进行中(status=%s, attempts=%s)', v_init.status, v_init.attempts);
    else
      -- failed:自动恢复,attempts+1(最多 5 次)
      if v_init.attempts >= 5 then
        raise exception 'TENANT_INIT_MAX_RETRIES' using errcode = 'P0003',
          detail = '初始化失败已达 5 次上限,请人工介入';
      end if;
      update public.tenant_initializations
      set status = 'running',
          attempts = attempts + 1,
          started_at = now(),
          failed_at = null,
          last_error = null
      where id = v_init.id
      returning * into v_init;
      v_attempts := v_init.attempts;
      -- 审计:retry
      insert into public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
      values (v_tenant_id, p_operator_id, 'tenant.init.retry', 'tenant_initialization', v_init.id,
              jsonb_build_object('attempts', v_init.attempts));
    end if;
  else
    -- 3b. 该租户是否已有其他 completed 初始化(幂等:不重复初始化)
    select * into v_init
    from public.tenant_initializations
    where tenant_id = v_tenant_id and status = 'completed'
    order by created_at desc
    limit 1;
    if v_init.id is not null then
      return jsonb_build_object(
        'status', 'completed',
        'initializationId', v_init.id,
        'storeId', v_init.store_id,
        'tenantId', v_tenant_id,
        'note', '租户已初始化完成,未重复创建资源'
      );
    end if;

    -- 3c. 全新初始化:创建记录(pending→running)
    insert into public.tenant_initializations (
      tenant_id, status, idempotency_key, attempts,
      store_name, store_code, owner_user_id, owner_name, owner_phone,
      created_by
    )
    values (
      v_tenant_id, 'running', v_key, 1,
      p_store_name, p_store_code, p_owner_user_id, p_owner_name, p_owner_phone,
      p_operator_id
    )
    returning * into v_init;
    v_attempts := v_init.attempts;
    -- 审计:start
    insert into public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
    values (v_tenant_id, p_operator_id, 'tenant.init.start', 'tenant_initialization', v_init.id,
            jsonb_build_object('storeName', p_store_name, 'attempts', v_init.attempts));
  end if;

  -- ===== 4. 业务执行(单事务;任一步失败整单回滚并置 failed) =====
  begin
    -- 4.1 First Store(地址同步自 tenants)
    insert into public.stores (tenant_id, name, code, status, address)
    values (v_tenant_id, p_store_name, p_store_code, 'active', nullif(p_address, ''))
    returning id into v_store_id;

    -- 4.2 Tenant Owner:employee + tenant_owner role 分配(store_id IS NULL)
    --     tenant_owner role:scope=tenant(migration 28),触发器 trg_era_scope 强制 store_id IS NULL
    select id into v_role_id
    from public.roles
    where code = 'tenant_owner' and is_system = true
    limit 1;
    if v_role_id is null then
      raise exception 'TENANT_OWNER_ROLE_MISSING' using errcode = 'P0003',
        detail = '默认角色 tenant_owner 不存在,请检查 migration 28/seed';
    end if;

    -- 员工档案(employee_no 租户内唯一)
    insert into public.employees (tenant_id, user_id, employee_no, name, phone, status)
    values (
      v_tenant_id, p_owner_user_id,
      'E' || to_char((select count(*) + 1 from public.employees where tenant_id = v_tenant_id), 'FM0000'),
      p_owner_name, p_owner_phone, 'active'
    )
    returning id into v_employee_id;

    -- tenant_owner 角色分配(租户级,store_id IS NULL;触发校验 S30-R02)
    insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
    values (v_tenant_id, v_employee_id, v_role_id, null);

    -- 租户成员关系(授权 is_tenant_member / RLS 依赖)
    insert into public.tenant_memberships (tenant_id, user_id, status)
    values (v_tenant_id, p_owner_user_id, 'active')
    on conflict (tenant_id, user_id) do nothing;

    -- 4.3 默认仓库(active + 默认)
    insert into public.warehouses (tenant_id, store_id, name, code, is_default, is_active)
    values (v_tenant_id, v_store_id, '默认仓库', 'WH-DEFAULT', true, true)
    returning id into v_warehouse_id;

    -- 4.4 支付上下文(cash/card/wechat/alipay/other;cash 默认)
    insert into public.payment_contexts (tenant_id, store_id, method, label, is_default, is_active)
    values
      (v_tenant_id, v_store_id, 'cash',   '现金',   true,  true),
      (v_tenant_id, v_store_id, 'card',   '银行卡', false, true),
      (v_tenant_id, v_store_id, 'wechat', '微信',   false, true),
      (v_tenant_id, v_store_id, 'alipay', '支付宝', false, true),
      (v_tenant_id, v_store_id, 'other',  '其他',   false, true)
    on conflict (tenant_id, store_id, method) do update set
      label = excluded.label, is_active = excluded.is_active;

    -- 4.5 Pilot 基础字典(物种/品种/毛色/性别/体型)
    insert into public.base_dictionaries (tenant_id, category, code, label, sort_order, is_active)
    values
      -- species 物种
      (v_tenant_id, 'species', 'dog',      '犬',     1, true),
      (v_tenant_id, 'species', 'cat',      '猫',     2, true),
      (v_tenant_id, 'species', 'bird',     '鸟',     3, true),
      (v_tenant_id, 'species', 'rabbit',   '兔',     4, true),
      (v_tenant_id, 'species', 'reptile',  '爬宠',   5, true),
      -- breed 常见品种
      (v_tenant_id, 'breed',   'poodle',             '贵宾犬',    1, true),
      (v_tenant_id, 'breed',   'golden_retriever',   '金毛寻回犬', 2, true),
      (v_tenant_id, 'breed',   'british_shorthair',  '英国短毛猫', 3, true),
      (v_tenant_id, 'breed',   'ragdoll',            '布偶猫',    4, true),
      (v_tenant_id, 'breed',   'mixed',              '混血/其他',  5, true),
      -- color 毛色
      (v_tenant_id, 'color',   'white',  '白色', 1, true),
      (v_tenant_id, 'color',   'black',  '黑色', 2, true),
      (v_tenant_id, 'color',   'brown',  '棕色', 3, true),
      (v_tenant_id, 'color',   'mixed',  '花色', 4, true),
      (v_tenant_id, 'color',   'other',  '其他', 5, true),
      -- gender 性别
      (v_tenant_id, 'gender',  'male',   '公', 1, true),
      (v_tenant_id, 'gender',  'female', '母', 2, true),
      -- pet_size 体型
      (v_tenant_id, 'pet_size', 'small',  '小型', 1, true),
      (v_tenant_id, 'pet_size', 'medium', '中型', 2, true),
      (v_tenant_id, 'pet_size', 'large',  '大型', 3, true)
    on conflict (tenant_id, category, code) do update set
      label = excluded.label, sort_order = excluded.sort_order, is_active = excluded.is_active;

    -- 4.6 打印设置(58mm/80mm/a4;58mm 默认)
    insert into public.print_settings (tenant_id, store_id, paper_size, label, is_default, is_active)
    values
      (v_tenant_id, v_store_id, '58mm', '热敏小票 58mm', true,  true),
      (v_tenant_id, v_store_id, '80mm', '标签 80mm',    false, true),
      (v_tenant_id, v_store_id, 'a4',   'A4 报告',      false, true)
    on conflict (tenant_id, store_id, paper_size) do update set
      label = excluded.label, is_active = excluded.is_active;

    -- 4.7 完成:回填产出 + 状态
    update public.tenant_initializations
    set status = 'completed',
        store_id = v_store_id,
        completed_at = now(),
        failed_at = null,
        last_error = null
    where id = v_init.id;

    -- 审计:complete
    insert into public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
    values (v_tenant_id, p_operator_id, 'tenant.init.complete', 'tenant_initialization', v_init.id,
            jsonb_build_object('storeId', v_store_id, 'warehouseId', v_warehouse_id));

  exception when others then
    -- 失败:记录 failed(attempts 已含本次) + 审计 fail + 幂等缓存 + 抛出
    update public.tenant_initializations
    set status = 'failed',
        failed_at = now(),
        failed_reason = left(SQLERRM, 500),
        last_error = left(SQLERRM, 500)
    where id = v_init.id;

    insert into public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
    values (v_tenant_id, p_operator_id, 'tenant.init.fail', 'tenant_initialization', v_init.id,
            jsonb_build_object('error', left(SQLERRM, 500), 'attempts', v_attempts));

    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (v_tenant_id, v_key, 'initialize_tenant', 'tenant_initialization', v_init.id,
            jsonb_build_object(
              'status', 'failed',
              'initializationId', v_init.id,
              'error', left(SQLERRM, 500)
            ))
    on conflict (tenant_id, idempotency_key) do nothing;

    raise exception '%', SQLERRM using errcode = 'P0003';
  end;

  -- ===== 5. 成功:幂等缓存(覆盖 failed 旧记录,保证同 key 最终状态一致) + 返回结果 =====
  insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
  values (v_tenant_id, v_key, 'initialize_tenant', 'tenant_initialization', v_init.id,
          jsonb_build_object(
            'status', 'completed',
            'initializationId', v_init.id,
            'tenantId', v_tenant_id,
            'storeId', v_store_id,
            'warehouseId', v_warehouse_id,
            'ownerEmployeeId', v_employee_id,
            'attempts', v_attempts
          ))
  on conflict (tenant_id, idempotency_key) do update set
    action = excluded.action,
    entity_type = excluded.entity_type,
    entity_id = excluded.entity_id,
    result_json = excluded.result_json;

  return jsonb_build_object(
    'status', 'completed',
    'initializationId', v_init.id,
    'tenantId', v_tenant_id,
    'storeId', v_store_id,
    'warehouseId', v_warehouse_id,
    'ownerEmployeeId', v_employee_id,
    'attempts', v_attempts
  );
end;
$$;

comment on function public.initialize_tenant(uuid, text, text, text, text, uuid, text, text, text, uuid, text, text, text) is
  'S3.1-A 租户初始化闭环:创建首店/租户所有者/默认仓库/支付上下文/基础字典/打印设置;支持医院地址入参;幂等+可恢复+单事务+全程审计';
