-- ============================================================
-- MXQ-6001 三级类目树维护
-- - 数据库强制同租户父子关系、无环、最多三级
-- - 非空类目禁止删除
-- - 所有写命令经 Hono + catalog_category_command RPC
-- - move 在事务内锁定租户类目并规范化新旧同级排序
-- ============================================================

-- 删除父类目时不得把子类目静默提升为顶级。
alter table public.catalog_categories
  drop constraint if exists catalog_categories_parent_id_fkey;
alter table public.catalog_categories
  add constraint catalog_categories_parent_id_fkey
  foreign key (parent_id) references public.catalog_categories(id) on delete restrict;

-- 删除仍被目录项引用的类目时不得让目录项静默变为未分类。
alter table public.catalog_items
  drop constraint if exists catalog_items_category_id_fkey;
alter table public.catalog_items
  add constraint catalog_items_category_id_fkey
  foreign key (category_id) references public.catalog_categories(id) on delete restrict;

/** 在每次写入前校验整棵分支的最终深度与父子关系。 */
create or replace function public.validate_catalog_category_tree()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_parent_tenant uuid;
  v_ancestor_depth integer := 0;
  v_subtree_depth integer := 1;
  v_has_cycle boolean := false;
begin
  if tg_op = 'UPDATE' and new.tenant_id <> old.tenant_id then
    raise exception 'CATEGORY_TENANT_MISMATCH' using errcode = '23514';
  end if;

  if new.parent_id is not null then
    if new.parent_id = new.id then
      raise exception 'CATEGORY_CYCLE' using errcode = '23514';
    end if;

    select tenant_id into v_parent_tenant
    from public.catalog_categories
    where id = new.parent_id;

    if v_parent_tenant is null then
      raise exception 'PARENT_NOT_FOUND' using errcode = 'P0002';
    end if;
    if v_parent_tenant <> new.tenant_id then
      raise exception 'CATEGORY_TENANT_MISMATCH' using errcode = '23514';
    end if;

    with recursive ancestors as (
      select c.id, c.parent_id, 1 as depth, array[c.id] as path
      from public.catalog_categories c
      where c.id = new.parent_id
      union all
      select p.id, p.parent_id, a.depth + 1, a.path || p.id
      from ancestors a
      join public.catalog_categories p on p.id = a.parent_id
      where a.depth < 100 and not p.id = any(a.path)
    )
    select coalesce(max(depth), 0), coalesce(bool_or(id = new.id), false)
      into v_ancestor_depth, v_has_cycle
    from ancestors;

    if v_has_cycle then
      raise exception 'CATEGORY_CYCLE' using errcode = '23514';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    with recursive descendants as (
      select new.id as id, 1 as depth
      union all
      select c.id, d.depth + 1
      from descendants d
      join public.catalog_categories c on c.parent_id = d.id
      where c.id <> new.id and d.depth < 100
    )
    select coalesce(max(depth), 1) into v_subtree_depth from descendants;
  end if;

  if v_ancestor_depth + v_subtree_depth > 3 then
    raise exception 'CATEGORY_MAX_DEPTH' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_catalog_categories_validate_tree on public.catalog_categories;
create trigger trg_catalog_categories_validate_tree
  before insert or update of tenant_id, parent_id on public.catalog_categories
  for each row execute function public.validate_catalog_category_tree();

/**
 * 类目统一命令入口。
 * action=create/update/move/delete；所有动作均带幂等键并锁定租户类目集合。
 */
create or replace function public.catalog_category_command(
  p_tenant_id uuid,
  p_action text,
  p_category_id uuid default null,
  p_code text default null,
  p_name text default null,
  p_parent_id uuid default null,
  p_is_active boolean default null,
  p_position integer default null,
  p_idempotency_key text default null,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text := lower(trim(coalesce(p_action, '')));
  v_record public.catalog_categories%rowtype;
  v_old_parent uuid;
  v_result jsonb;
  v_position integer := greatest(coalesce(p_position, 0), 0);
begin
  if v_action not in ('create', 'update', 'move', 'delete') then
    raise exception 'CATEGORY_ACTION_INVALID' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_idempotency_key, '')), '') is null then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = '22023';
  end if;

  -- 同一租户的树结构命令串行化；随后 SELECT FOR UPDATE 锁定实际行。
  perform pg_advisory_xact_lock(hashtextextended('catalog-category:' || p_tenant_id::text, 0));

  select result_json into v_result
  from public.idempotency_records
  where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key
  for update;
  if v_result is not null then
    return v_result;
  end if;

  perform id from public.catalog_categories
  where tenant_id = p_tenant_id
  for update;

  if v_action = 'create' then
    if nullif(trim(coalesce(p_code, '')), '') is null or nullif(trim(coalesce(p_name, '')), '') is null then
      raise exception 'CATEGORY_FIELDS_REQUIRED' using errcode = '22023';
    end if;
    if exists (
      select 1 from public.catalog_categories
      where tenant_id = p_tenant_id and lower(code) = lower(trim(p_code))
    ) then
      raise exception 'CATEGORY_CODE_EXISTS' using errcode = '23505';
    end if;

    insert into public.catalog_categories (tenant_id, code, name, parent_id, sort_order)
    values (
      p_tenant_id, trim(p_code), trim(p_name), p_parent_id,
      coalesce((select max(sort_order) + 1 from public.catalog_categories
                where tenant_id = p_tenant_id and parent_id is not distinct from p_parent_id), 0)
    )
    returning * into v_record;

    v_result := to_jsonb(v_record);

  elsif v_action = 'update' then
    select * into v_record
    from public.catalog_categories
    where id = p_category_id and tenant_id = p_tenant_id
    for update;
    if not found then
      raise exception 'CATEGORY_NOT_FOUND' using errcode = 'P0002';
    end if;

    update public.catalog_categories
    set name = case when p_name is null then name else trim(p_name) end,
        is_active = coalesce(p_is_active, is_active)
    where id = p_category_id
    returning * into v_record;
    v_result := to_jsonb(v_record);

  elsif v_action = 'move' then
    select * into v_record
    from public.catalog_categories
    where id = p_category_id and tenant_id = p_tenant_id
    for update;
    if not found then
      raise exception 'CATEGORY_NOT_FOUND' using errcode = 'P0002';
    end if;
    v_old_parent := v_record.parent_id;

    -- 先移动目标；校验触发器会阻止跨租户、成环及超过三级。
    update public.catalog_categories
    set parent_id = p_parent_id,
        sort_order = v_position
    where id = p_category_id;

    -- 将目标按指定位置插入新同级列表并连续编号。
    with peers as (
      select id,
             row_number() over (order by sort_order, created_at, id) - 1 as base_position
      from public.catalog_categories
      where tenant_id = p_tenant_id
        and parent_id is not distinct from p_parent_id
        and id <> p_category_id
    ), desired as (
      select id,
             case when base_position >= v_position then base_position + 1 else base_position end as desired_position
      from peers
      union all
      select p_category_id, v_position
    ), ranked as (
      select id, row_number() over (order by desired_position, (id = p_category_id) desc, id) - 1 as final_position
      from desired
    )
    update public.catalog_categories c
    set sort_order = ranked.final_position
    from ranked
    where c.id = ranked.id;

    -- 跨父级移动时同步清理旧同级列表留下的序号空洞。
    if v_old_parent is distinct from p_parent_id then
      with ranked as (
        select id, row_number() over (order by sort_order, created_at, id) - 1 as final_position
        from public.catalog_categories
        where tenant_id = p_tenant_id and parent_id is not distinct from v_old_parent
      )
      update public.catalog_categories c
      set sort_order = ranked.final_position
      from ranked
      where c.id = ranked.id;
    end if;

    select * into v_record from public.catalog_categories where id = p_category_id;
    v_result := to_jsonb(v_record);

  else
    select * into v_record
    from public.catalog_categories
    where id = p_category_id and tenant_id = p_tenant_id
    for update;
    if not found then
      raise exception 'CATEGORY_NOT_FOUND' using errcode = 'P0002';
    end if;
    if exists (select 1 from public.catalog_categories where parent_id = p_category_id)
      or exists (select 1 from public.catalog_items where category_id = p_category_id) then
      raise exception 'CATEGORY_NOT_EMPTY' using errcode = '23503';
    end if;

    v_old_parent := v_record.parent_id;
    delete from public.catalog_categories where id = p_category_id;
    with ranked as (
      select id, row_number() over (order by sort_order, created_at, id) - 1 as final_position
      from public.catalog_categories
      where tenant_id = p_tenant_id and parent_id is not distinct from v_old_parent
    )
    update public.catalog_categories c
    set sort_order = ranked.final_position
    from ranked
    where c.id = ranked.id;
    v_result := jsonb_build_object('id', p_category_id, 'deleted', true);
  end if;

  insert into public.idempotency_records (
    tenant_id, idempotency_key, action, entity_type, entity_id, result_json
  ) values (
    p_tenant_id, p_idempotency_key, 'catalog_category.' || v_action,
    'catalog_categories', coalesce(p_category_id, (v_result->>'id')::uuid), v_result
  );

  return v_result;
end;
$$;

-- service-role-only 授权采用签名发现,与 RPC manifest 静态检查保持一致。
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array['catalog_category_command']
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

-- 浏览器仅保留读取能力，类目写入统一走 Hono scoped authorization。
drop policy if exists "catalog_categories_insert" on public.catalog_categories;
drop policy if exists "catalog_categories_update" on public.catalog_categories;
drop policy if exists "catalog_categories_delete" on public.catalog_categories;

comment on function public.catalog_category_command(uuid, text, uuid, text, text, uuid, boolean, integer, text, uuid)
  is '三级类目树统一写命令:create/update/move/delete;Hono scoped authorization 后以 service role 调用。';
