-- ============================================================
-- 20260811000023_catalog_bulk_migrate.sql
-- MXQ-6005 目录项跨类目批量迁移(B-R-1)
--   - catalog_items_bulk_migrate RPC:事务内校验目标类目同租户、项目存在且属于来源类目,
--     批量 UPDATE catalog_items.category_id,并写 audit_logs 审计日志。
--   - 与 migrate_catalog_to_store(租户目录→门店实例化)语义区分:
--     本 RPC 是"产品目录各目录之间互迁(项目跨类目改归类)"。
-- 幂等,可重复应用。
-- ============================================================

create or replace function public.catalog_items_bulk_migrate(
  p_tenant_id uuid,
  p_source_category_id uuid,
  p_item_ids uuid[],
  p_target_category_id uuid,
  p_operator_id uuid default null
)
returns table(migrated_count bigint, skipped_count bigint, total_count bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_exists integer;
  v_target_exists integer;
  v_valid_ids uuid[] := '{}';
  v_migrated bigint := 0;
  v_skipped bigint := 0;
  v_total bigint := 0;
begin
  -- 1. 来源类目必须属于同租户
  select count(*) into v_source_exists
  from public.catalog_categories
  where id = p_source_category_id and tenant_id = p_tenant_id;
  if v_source_exists = 0 then
    raise exception 'SOURCE_CATEGORY_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 2. 目标类目必须属于同租户(跨租户目标类目拒绝)
  select count(*) into v_target_exists
  from public.catalog_categories
  where id = p_target_category_id and tenant_id = p_tenant_id;
  if v_target_exists = 0 then
    raise exception 'TARGET_CATEGORY_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 3. 过滤 p_item_ids:去重 + 仅保留"存在、同租户、且当前属于来源类目"的项目
  select coalesce(array_agg(distinct ci.id), '{}')
  into v_valid_ids
  from unnest(p_item_ids) as ids(id)
  join public.catalog_items ci on ci.id = ids.id
  where ci.tenant_id = p_tenant_id
    and ci.category_id = p_source_category_id;

  v_total := cardinality(p_item_ids);
  v_skipped := v_total - coalesce(cardinality(v_valid_ids), 0);

  -- 4. 批量改归类(同事务)
  if coalesce(cardinality(v_valid_ids), 0) > 0 then
    update public.catalog_items
    set category_id = p_target_category_id
    where id = any(v_valid_ids)
      and tenant_id = p_tenant_id
      and category_id = p_source_category_id;
    get diagnostics v_migrated = row_count;
  end if;

  -- 5. 写审计日志(catalog.itemsBulkMigrate)
  insert into public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  values (
    p_tenant_id,
    p_operator_id,
    'catalog.itemsBulkMigrate',
    'catalog_items',
    null,
    jsonb_build_object(
      'sourceCategoryId', p_source_category_id,
      'targetCategoryId', p_target_category_id,
      'itemIds', p_item_ids,
      'migratedCount', v_migrated,
      'skippedCount', v_skipped
    )
  );

  -- 6. 返回统计
  return query select v_migrated, v_skipped, v_total;
end;
$$;

revoke all on function public.catalog_items_bulk_migrate(uuid, uuid, uuid[], uuid, uuid) from public;
grant execute on function public.catalog_items_bulk_migrate(uuid, uuid, uuid[], uuid, uuid) to authenticated;
