-- ============================================================
-- 20260809000049_medical_loop_rbac_revoke.sql
-- S3.1 并发任务 C 医疗闭环增强:权限种子 + RPC 权限收紧(收尾)
--
-- 角色:开发员工 C(独占 migration 44~49)
--
-- 本文件内容:
--   1. 新权限码的角色分配(role_permissions 幂等):
--        lab_sample.*   / lab_critical.*  (migration 45/46)
--        progress.*     / settlement.*    (migration 47/48)
--   2. roles.permissions 数组同步(兼容旧代码读取)
--   3. 全部 S3.1-C 新增 RPC 权限收紧(service-role-only):
--        migration 44:create_medical_order / complete_nurse_task /
--           cancel_nurse_task / fail_nurse_task / cancel_medical_order /
--           scan_nurse_task_overdue
--        migration 45:create_lab_sample / transition_lab_sample
--        migration 46:notify_critical_value / ack_critical_value
--        migration 47:create_progress_note / sign_progress_note /
--           link_medical_lab_ref
--        migration 48:prepare_settlement / settle_admission /
--           waive_admission_charge / finalize_settlement
--     与 service-rpc-manifest.ts(S30-F02)保持一致,revoke 清单必须出现
--     本文件中每个函数名(CI 静态校验)。
-- 幂等,可重复应用
-- ============================================================

-- ============================================================
-- 1. 新权限码角色分配(role_permissions)
--    lab_sample / lab_critical / progress / settlement
-- ============================================================
-- system_admin:全部授予
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'system_admin'
  and p.code in (
    'lab_sample.read', 'lab_sample.write', 'lab_sample.execute',
    'lab_critical.read', 'lab_critical.write', 'lab_critical.execute',
    'progress.view', 'progress.write', 'progress.sign',
    'settlement.view', 'settlement.write', 'settlement.execute'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- store_manager:全部授予
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code in (
    'lab_sample.read', 'lab_sample.write', 'lab_sample.execute',
    'lab_critical.read', 'lab_critical.write', 'lab_critical.execute',
    'progress.view', 'progress.write', 'progress.sign',
    'settlement.view', 'settlement.write', 'settlement.execute'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- doctor:标本管理(创建/流转)+ 危急值确认 + 病程全流程 + 结算只读
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'doctor'
  and p.code in (
    'lab_sample.read', 'lab_sample.write',
    'lab_critical.read', 'lab_critical.write', 'lab_critical.execute',
    'progress.view', 'progress.write', 'progress.sign',
    'settlement.view'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- nurse:标本流转全流程 + 危急值只读 + 病程只读
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'nurse'
  and p.code in (
    'lab_sample.read', 'lab_sample.write', 'lab_sample.execute',
    'lab_critical.read',
    'progress.view'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- cashier:结算只读/收款(收银参与出院结算收款)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'cashier'
  and p.code in ('settlement.view', 'settlement.write')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- ============================================================
-- 2. roles.permissions 数组同步(兼容旧代码读取)
-- ============================================================
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'lab_sample.read', 'lab_sample.write', 'lab_sample.execute',
    'lab_critical.read', 'lab_critical.write', 'lab_critical.execute',
    'progress.view', 'progress.write', 'progress.sign',
    'settlement.view', 'settlement.write', 'settlement.execute'
  ])
)
where code in ('system_admin', 'store_manager') and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'lab_sample.read', 'lab_sample.write',
    'lab_critical.read', 'lab_critical.write', 'lab_critical.execute',
    'progress.view', 'progress.write', 'progress.sign',
    'settlement.view'
  ])
)
where code = 'doctor' and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'lab_sample.read', 'lab_sample.write', 'lab_sample.execute',
    'lab_critical.read',
    'progress.view'
  ])
)
where code = 'nurse' and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'settlement.view', 'settlement.write'
  ])
)
where code = 'cashier' and is_system = true;

-- ============================================================
-- 3. RPC 权限收紧(service-role-only,manifest 同步登记)
--    S3.1 并发任务 C 全部新增 RPC(44~48)
-- ============================================================
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    -- migration 44:医嘱 + 护士任务
    'create_medical_order',
    'complete_nurse_task',
    'cancel_nurse_task',
    'fail_nurse_task',
    'cancel_medical_order',
    'scan_nurse_task_overdue',
    -- migration 45:检验标本
    'create_lab_sample',
    'transition_lab_sample',
    -- migration 46:危急值
    'notify_critical_value',
    'ack_critical_value',
    -- migration 47:病程 + 医嘱检验关联
    'create_progress_note',
    'sign_progress_note',
    'link_medical_lab_ref',
    -- migration 48:出院结算
    'prepare_settlement',
    'settle_admission',
    'waive_admission_charge',
    'finalize_settlement'
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

-- ============================================================
-- 4. 结束
--    seed.sql 权限同步见文件内新增权限码/角色数组(与本次一致)
-- ============================================================
