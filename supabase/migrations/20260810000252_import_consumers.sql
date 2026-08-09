-- ============================================================
-- 20260810000252_import_consumers.sql
-- Agent-07 (Stage-04): Import Consumers 运行时支撑
--   - employee_invite_imports 状态扩展:pending/processing/applied/failed
--     新增 employee_id / invited_user_id / applied_at / processing_at / error_code / error_message
--   - opening_stock_import_requests 状态扩展:pending/processing/applied/failed
--     新增 batch_id / movement_id / applied_at / processing_at / error_code
--   - import_jobs 状态新增 partially_completed(部分领域应用,收口终态之一)
--   - apply_opening_stock_import RPC:期初入账正式 Command
--     复用 post_goods_receipt 语义(建批次/增余额/写 receive 流水),
--     reference_type='opening_stock_import',幂等键按请求 id 生成防重放
-- 边界:
--   - Employee Consumer 不在 DB 层建 auth 用户/组织数据,由 Hono service 调
--     既有 IAM 域(invite_employee RPC + auth.admin.createUser),本迁移只扩展状态列
--   - 期初入账最终落 inventory_movements / inventory_batches,与现有库存真源一致
--   - Import 终态收口规则(IMPORT_TERMINAL_STATE_RULE):
--     全部 applied → completed;有成功有失败 → partially_completed;全失败 → failed
-- 幂等,可重复应用
-- ============================================================
set search_path = public;

-- ===== 1. employee_invite_imports 状态与结果列扩展 =====
alter table public.employee_invite_imports
  add column if not exists employee_id uuid,                          -- 邀请成功后员工档案 id
  add column if not exists invited_user_id uuid,                      -- 邀请成功后 auth 用户 id
  add column if not exists applied_at timestamptz,
  add column if not exists processing_at timestamptz,
  add column if not exists error_code text,
  add column if not exists error_message text;

alter table public.employee_invite_imports drop constraint if exists employee_invite_imports_status_check;
alter table public.employee_invite_imports
  add constraint employee_invite_imports_status_check check (
    status in ('pending', 'processing', 'applied', 'failed', 'duplicate', 'sent')
  );

create index if not exists idx_employee_invite_job_status
  on public.employee_invite_imports (import_job_id, status);

-- ===== 2. opening_stock_import_requests 状态与结果列扩展 =====
alter table public.opening_stock_import_requests
  add column if not exists batch_id uuid,                             -- 落地批次
  add column if not exists movement_id uuid,                          -- 落地流水
  add column if not exists applied_at timestamptz,
  add column if not exists processing_at timestamptz,
  add column if not exists error_code text;

alter table public.opening_stock_import_requests drop constraint if exists opening_stock_import_requests_status_check;
alter table public.opening_stock_import_requests
  add constraint opening_stock_import_requests_status_check check (
    status in ('pending', 'processing', 'applied', 'failed', 'skipped')
  );

create index if not exists idx_opening_stock_req_job_status
  on public.opening_stock_import_requests (import_job_id, status);

-- ===== 3. import_jobs 收口终态扩展(partially_completed) =====
alter table public.import_jobs drop constraint if exists import_jobs_status_check;
alter table public.import_jobs
  add constraint import_jobs_status_check check (
    status in ('uploaded', 'mapped', 'validated', 'queued', 'pending', 'processing',
               'completed', 'failed', 'cancelled', 'awaiting_domain_apply', 'partially_completed')
  );

comment on column public.import_jobs.status is
  '导入任务状态:awaiting_domain_apply=领域命令已生成、等待 Consumer 应用;'
  '领域命令全部 applied 后收口为 completed;部分成功为 partially_completed;全失败为 failed;'
  'completed 仅表示业务数据已直接落地(customer/pet/catalog-item)。';

-- ===== 4. apply_opening_stock_import RPC(期初入账正式 Command) =====
-- 事务:建批次 → 增余额 → 写 receive 流水(reference_type='opening_stock_import') → 标记 applied
-- 前置:调用方(Hono Consumer)先 CAS claim pending → processing
-- 幂等:movement 唯一索引 (tenant_id, idempotency_key) + applied 状态短路,防重复入账
create or replace function public.apply_opening_stock_import(
  p_request_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.opening_stock_import_requests;
  v_warehouse public.warehouses;
  v_batch public.inventory_batches;
  v_balance public.inventory_balances;
  v_movement public.inventory_movements;
  v_idem_key text := 'opening_import:' || p_request_id;
begin
  -- 锁行(并发安全:同一请求仅一个事务能处理)
  select * into v_req from public.opening_stock_import_requests
  where id = p_request_id
  for update;
  if not found then
    raise exception 'OPENING_IMPORT_REQUEST_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 幂等:已 applied 直接返回原结果
  if v_req.status = 'applied' then
    return jsonb_build_object(
      'requestId', v_req.id, 'status', 'applied', 'idempotent', true,
      'batchId', v_req.batch_id, 'movementId', v_req.movement_id
    );
  end if;
  if v_req.status <> 'processing' then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;
  if v_req.quantity <= 0 then
    raise exception 'INVALID_QUANTITY' using errcode = 'P0003';
  end if;

  -- 校验仓库归属与启用
  select * into v_warehouse from public.warehouses
  where id = v_req.warehouse_id and tenant_id = v_req.tenant_id
  for update;
  if not found then
    raise exception 'WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_warehouse.is_active is false then
    raise exception 'WAREHOUSE_INACTIVE' using errcode = 'P0003';
  end if;

  -- 1) 创建批次(期初入账,数量/成本/效期取自导入行)
  insert into public.inventory_batches (
    tenant_id, warehouse_id, catalog_item_id, batch_no,
    received_date, expiry_date, quantity_received, quantity_remaining, unit_cost, status
  )
  values (
    v_req.tenant_id, v_req.warehouse_id, v_req.catalog_item_id, v_req.batch_no,
    current_date, v_req.expiry_date, v_req.quantity, v_req.quantity, v_req.unit_cost, 'active'
  )
  returning * into v_batch;

  -- 2) 增加余额(并发安全:on conflict 原子累加)
  insert into public.inventory_balances (tenant_id, warehouse_id, catalog_item_id, quantity_on_hand, quantity_reserved)
  values (v_req.tenant_id, v_req.warehouse_id, v_req.catalog_item_id, v_req.quantity, 0)
  on conflict (warehouse_id, catalog_item_id)
  do update set quantity_on_hand = inventory_balances.quantity_on_hand + excluded.quantity_on_hand,
                 updated_at = now()
  returning * into v_balance;

  -- 3) 写不可变流水(receive,期初入账来源;幂等键唯一防重放)
  insert into public.inventory_movements (
    tenant_id, warehouse_id, catalog_item_id, batch_id,
    movement_type, quantity, balance_after,
    reference_type, reference_id, idempotency_key, operator_id
  )
  values (
    v_req.tenant_id, v_req.warehouse_id, v_req.catalog_item_id, v_batch.id,
    'receive', v_req.quantity, v_balance.quantity_on_hand,
    'opening_stock_import', v_req.id::text, v_idem_key, p_operator_id
  )
  returning * into v_movement;

  -- 4) 标记已应用
  update public.opening_stock_import_requests
  set status = 'applied', applied_at = now(), batch_id = v_batch.id, movement_id = v_movement.id,
      error_message = null
  where id = p_request_id;

  return jsonb_build_object(
    'requestId', v_req.id, 'status', 'applied', 'idempotent', false,
    'batchId', v_batch.id, 'movementId', v_movement.id,
    'quantityOnHand', v_balance.quantity_on_hand
  );
end;
$$;

-- ===== 5. Consumer 执行权限码 =====
insert into public.permissions (code, name, module) values
  ('imports.employee.execute', '执行员工导入', 'imports'),
  ('imports.opening_stock.execute', '执行期初库存导入', 'imports')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code in ('system_admin', 'store_manager')
  and p.code in ('imports.employee.execute', 'imports.opening_stock.execute')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'imports.employee.execute', 'imports.opening_stock.execute'
  ])
)
where code in ('system_admin', 'store_manager') and is_system = true;

-- ===== 6. service-role-only 授权(自包含,幂等) =====
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array['apply_opening_stock_import']
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
