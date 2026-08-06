-- ============================================================
-- 20260806000011_migrate_store_members.sql
-- MXQ-3005 现有 store_members 数据迁移到 tenant_memberships / employees
--   / employee_store_assignments / employee_role_assignments
-- 幂等(全部 on conflict / not exists 保护),可重复应用
-- 迁移后 store_members 表保留(兼容期),后续阶段下线
-- ============================================================

-- 1) 租户成员:由 store_members 关联 stores.tenant_id 派生
insert into public.tenant_memberships (tenant_id, user_id, status, joined_at)
select distinct s.tenant_id, sm.user_id, sm.status, coalesce(sm.created_at, now())
from public.store_members sm
join public.stores s on s.id = sm.store_id
where s.tenant_id is not null
on conflict (tenant_id, user_id) do nothing;

-- 2) 员工档案:以 profiles 为员工底座,employee_no 取账号,缺失时用 id 兜底
insert into public.employees (tenant_id, user_id, employee_no, name, email, status)
select
  s.tenant_id,
  p.id,
  coalesce(nullif(p.account, ''), 'EMP-' || left(p.id::text, 8)),
  coalesce(nullif(p.real_name, ''), p.account),
  p.account,
  coalesce(p.status, 'active')
from public.profiles p
join public.store_members sm on sm.user_id = p.id
join public.stores s on s.id = sm.store_id
where s.tenant_id is not null
group by s.tenant_id, p.id, p.account, p.real_name, p.status
on conflict (tenant_id, employee_no) do nothing;

-- 3) 员工门店分配
insert into public.employee_store_assignments (tenant_id, employee_id, store_id, is_primary)
select distinct
  s.tenant_id,
  e.id,
  sm.store_id,
  false
from public.store_members sm
join public.stores s on s.id = sm.store_id
join public.employees e on e.tenant_id = s.tenant_id and e.user_id = sm.user_id
on conflict (employee_id, store_id) do nothing;

-- 4) 员工角色分配(store_id 精确到成员所在门店)
insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
select distinct
  s.tenant_id,
  e.id,
  sm.role_id,
  sm.store_id
from public.store_members sm
join public.stores s on s.id = sm.store_id
join public.employees e on e.tenant_id = s.tenant_id and e.user_id = sm.user_id
where not exists (
  select 1 from public.employee_role_assignments x
  where x.employee_id = e.id
    and x.role_id = sm.role_id
    and x.store_id = sm.store_id
);
