-- ============================================================
-- 20260811000073_lab_result_revision.sql
-- G-R-3(3.9.2-05 结果修订机制修复):
--   1. lab_result_versions 版本表:每次修订复制当前结果为新版本行(快照旧值),
--      已发布结果不可静默覆盖,修订后旧值可追溯(参照 imaging_reports.version 机制)。
--   2. revise_lab_results RPC:仅已发布(存在 approved 审核记录)可修订;
--      change_reason 必填;双签:修订人≠结果录入人(参照 review_lab_results 双签校验);
--      更新当前值 + 写版本行 + 审计,全部同一事务。
--   3. 新权限码 lab.result.revise(定义在迁移中,不改 supabase/seed.sql)。
-- 幂等,可重复应用
-- ============================================================

-- ===== 1. lab_result_versions 版本表(G-R-3) =====
-- 跟随 lab_orders(联表 RLS 只读);写入由 security definer RPC 完成,浏览器不可直连写
create table if not exists public.lab_result_versions (
  id uuid primary key default gen_random_uuid(),
  lab_order_id uuid not null references public.lab_orders(id) on delete cascade,
  analyte_id uuid,                                        -- 引用 lab_analytes.id,不加 FK(与 lab_order_analytes 一致)
  version integer not null default 1,
  result_value text,
  result_numeric numeric(12,4),
  flag text,                                              -- low/high/critical
  snapshot jsonb not null default '{}'::jsonb,            -- 修订前的整行快照(旧值追溯)
  change_reason text not null,                            -- 变更原因(必填)
  created_by uuid references auth.users(id) on delete set null,
  verified_by uuid references auth.users(id) on delete set null,   -- 原发布审核人(双签留痕)
  verified_at timestamptz,
  created_at timestamptz not null default now(),

  constraint lab_result_versions_flag_check check (flag is null or flag in ('low', 'high', 'critical')),
  constraint lab_result_versions_reason_check check (btrim(change_reason) <> ''),
  constraint lab_result_versions_order_analyte_version_unique unique (lab_order_id, analyte_id, version)
);

create index if not exists idx_lab_result_versions_order on public.lab_result_versions (lab_order_id, version desc);

-- RLS:读跟随 lab_orders(租户成员 + 门店可见);不开放写策略(写入走 RPC)
alter table public.lab_result_versions enable row level security;

drop policy if exists "lab_result_versions_select" on public.lab_result_versions;
create policy "lab_result_versions_select" on public.lab_result_versions
  for select to authenticated
  using (
    exists (
      select 1 from public.lab_orders lo
      where lo.id = lab_result_versions.lab_order_id
        and public.is_tenant_member(lo.tenant_id)
        and (lo.store_id is null or public.can_access_store(lo.tenant_id, lo.store_id))
    )
  );

-- ===== 2. revise_lab_results RPC(G-R-3) =====
-- 版本化修订:复制当前结果为新版本 + 更新当前值 + 写审计(单事务)
-- 校验:仅已发布(存在 approved 审核)可修订;change_reason 必填;双签(修订人≠结果录入人)
-- p_results_json:[{ id, result_value, result_numeric, is_abnormal, is_critical, flag, note }]
-- 返回 { revisedCount, versionsCount }
create or replace function public.revise_lab_results(
  p_lab_order_id uuid,
  p_results_json jsonb,
  p_change_reason text,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.lab_orders;
  v_item jsonb;
  v_loa public.lab_order_analytes;
  v_version integer;
  v_revised_count integer := 0;
  v_versions_count integer := 0;
  v_reviewer_id uuid;
begin
  -- 变更原因必填
  if p_change_reason is null or btrim(p_change_reason) = '' then
    raise exception 'REVISE_REASON_REQUIRED' using errcode = 'P0003';
  end if;

  select * into v_order from public.lab_orders where id = p_lab_order_id for update;
  if not found then
    raise exception 'LAB_ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 仅已发布可修订:必须存在 approved 审核记录
  select reviewed_by into v_reviewer_id
  from public.lab_result_reviews
  where lab_order_id = p_lab_order_id and decision = 'approved'
  order by reviewed_at desc
  limit 1;
  if not found then
    raise exception 'LAB_ORDER_NOT_PUBLISHED' using errcode = 'P0003';
  end if;

  -- 双签:修订人不可与结果录入人为同一人(查任意一条已录结果的 resulted_by)
  perform 1
  from public.lab_order_analytes loa
  where loa.lab_order_id = p_lab_order_id
    and loa.resulted_at is not null
    and loa.resulted_by = p_operator_id
  limit 1;
  if found then
    raise exception 'REVISER_IS_RESULT_INPUTTER' using errcode = 'P0003';
  end if;

  -- 逐项修订:复制当前值为新版本行 + 更新当前值
  for v_item in select * from jsonb_array_elements(p_results_json)
  loop
    select * into v_loa
    from public.lab_order_analytes
    where id = nullif(v_item->>'id', '')::uuid
      and lab_order_id = p_lab_order_id;
    if not found then
      raise exception 'INVALID_RESULT_ITEM' using errcode = 'P0003', detail = '结果项不存在或不属于该申请单';
    end if;

    -- 该 (lab_order, analyte) 的新版本号 = max(version) + 1
    select coalesce(max(version), 0) + 1 into v_version
    from public.lab_result_versions
    where lab_order_id = p_lab_order_id and analyte_id = v_loa.analyte_id;

    -- 旧值入版本表(整行快照,修订后旧引用内容不受破坏)
    insert into public.lab_result_versions (
      lab_order_id, analyte_id, version, result_value, result_numeric, flag,
      snapshot, change_reason, created_by, verified_by, verified_at
    ) values (
      p_lab_order_id, v_loa.analyte_id, v_version,
      v_loa.result_value, v_loa.result_numeric, v_loa.flag,
      to_jsonb(v_loa),
      btrim(p_change_reason), p_operator_id, v_reviewer_id, now()
    );
    v_versions_count := v_versions_count + 1;

    -- 更新当前值(resulted_by 同步为修订人,保证下次修订双签仍生效)
    update public.lab_order_analytes
    set result_value = nullif(v_item->>'result_value', ''),
        result_numeric = case when v_item ? 'result_numeric' and nullif(v_item->>'result_numeric', '') is not null
                              then (v_item->>'result_numeric')::numeric else null end,
        is_abnormal = coalesce((v_item->>'is_abnormal')::boolean, v_loa.is_abnormal),
        is_critical = coalesce((v_item->>'is_critical')::boolean, v_loa.is_critical),
        flag = nullif(v_item->>'flag', ''),
        note = case when v_item ? 'note' then nullif(v_item->>'note', '') else v_loa.note end,
        resulted_at = now(),
        resulted_by = p_operator_id
    where id = v_loa.id;
    v_revised_count := v_revised_count + 1;
  end loop;

  if v_revised_count = 0 then
    raise exception 'INVALID_RESULT_ITEM' using errcode = 'P0003', detail = '至少修订一条结果';
  end if;

  -- 事务内审计
  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_order.tenant_id, v_order.store_id, p_operator_id, 'lab.revise_results', 'lab_order', p_lab_order_id,
          jsonb_build_object('revised_count', v_revised_count, 'versions_count', v_versions_count,
                             'change_reason', btrim(p_change_reason)));

  return jsonb_build_object('revisedCount', v_revised_count, 'versionsCount', v_versions_count);
end;
$$;

revoke all on function public.revise_lab_results(uuid, jsonb, text, uuid) from public;
grant execute on function public.revise_lab_results(uuid, jsonb, text, uuid) to authenticated;

-- ===== 3. 权限码 lab.result.revise(G-R-3,不改 seed.sql) =====
insert into public.permissions (code, name, module) values
  ('lab.result.revise', '修订检验结果', 'lab')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- system_admin / store_manager / doctor 授予修订权限(幂等)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code in ('system_admin', 'store_manager', 'doctor')
  and p.code = 'lab.result.revise'
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容旧代码读取)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array['lab.result.revise'])
)
where code in ('system_admin', 'store_manager', 'doctor') and is_system = true;
