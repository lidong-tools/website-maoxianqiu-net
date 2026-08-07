-- ============================================================
-- 20260809000045_lab_samples.sql
-- S3.1 并发任务 C 医疗闭环增强:检验标本(lab_samples)流转闭环
--
-- 角色:开发员工 C(独占 migration 44~49)
--
-- 与既有表关系:
--   lab_specimens(20260806000022)为早期简单采集记录(状态 collected/in_transit/received/discarded),
--   本文件新建 lab_samples 为 S3.1 完整标本流转闭环表,两者并存互不影响:
--   lab_samples 状态机 planned → collected → received → testing → completed;
--   任意非终态 → rejected(须 reason)
--
-- 本文件内容:
--   1. lab_samples 标本表(lab_order_id / sample_no / sample_type /
--      collected / received / rejected 信息,状态 planned/collected/received/testing/completed/rejected)
--   2. 权限码:lab_sample.read / lab_sample.write / lab_sample.execute(tenant/store scope)
--   3. RLS 策略(lab_sample.read 读 / lab_sample.write 写,can_access_store 隔离)
--   4. 原子 RPC(全部 service-role-only,Hono 以 service role 调用):
--      create_lab_sample / transition_lab_sample
--   5. 审计:各 RPC 事务内写 audit_logs
--
-- 设计要点:
--   - sample_no 租户内唯一(LS-YYYYMMDD-随机后缀)
--   - 状态流转走单事务 RPC + CHECK 约束 + 前端状态机三重兜底
--   - rejected 必须填写 reason
--   - 某 lab_order 全部标本 completed → 联动 lab_orders:requested → collected
--     (使后续结果录入/review 流程可继续,不覆盖已 collected/completed 状态)
-- 幂等,可重复应用
-- ============================================================

-- ============================================================
-- 1. lab_samples 表(标本流转)
-- ============================================================
create table if not exists public.lab_samples (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,   -- 从 lab_orders 继承,便于门店级 RLS
  lab_order_id uuid not null references public.lab_orders(id) on delete cascade,
  sample_no text not null,                                          -- 标本编号(租户内唯一)
  sample_type text not null default 'blood',                        -- blood/urine/feces/tissue/other
  status text not null default 'planned',                           -- planned/collected/received/testing/completed/rejected

  planned_at timestamptz not null default now(),                    -- 计划采集时间(创建即 planned)
  planned_by uuid,                                                  -- 计划人
  collected_at timestamptz,                                         -- 实际采集时间
  collected_by uuid,                                                -- 采集人
  received_at timestamptz,                                          -- 实验室签收时间
  received_by uuid,                                                 -- 签收人
  rejected_at timestamptz,                                          -- 拒收时间
  rejected_by uuid,                                                 -- 拒收人
  reject_reason text,                                               -- 拒收原因(status=rejected 时必填)

  container text,                                                   -- 容器描述(如 EDTA 抗凝管)
  storage_condition text,                                           -- 保存条件(如 2-8℃)
  remark text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lab_samples_type_check check (sample_type in ('blood', 'urine', 'feces', 'tissue', 'other')),
  constraint lab_samples_status_check check (
    status in ('planned', 'collected', 'received', 'testing', 'completed', 'rejected')
  )
);

-- 租户内标本编号唯一
create unique index if not exists idx_lab_samples_tenant_no
  on public.lab_samples (tenant_id, sample_no);
create index if not exists idx_lab_samples_order
  on public.lab_samples (lab_order_id);
create index if not exists idx_lab_samples_tenant_store_status
  on public.lab_samples (tenant_id, store_id, status);
create index if not exists idx_lab_samples_pet_join
  on public.lab_samples (lab_order_id, status);

drop trigger if exists trg_lab_samples_updated_at on public.lab_samples;
create trigger trg_lab_samples_updated_at
  before update on public.lab_samples
  for each row execute procedure public.touch_updated_at();

-- ============================================================
-- 2. 权限码(lab_sample.read / write / execute)
-- ============================================================
insert into public.permissions (code, name, module) values
  ('lab_sample.read', '查看检验标本', 'lab'),
  ('lab_sample.write', '管理检验标本', 'lab'),
  ('lab_sample.execute', '执行标本流转', 'lab')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- ============================================================
-- 3. RLS 策略(lab_sample.read 读 / lab_sample.write 写)
-- ============================================================
alter table public.lab_samples enable row level security;

drop policy if exists "lab_samples_select" on public.lab_samples;
create policy "lab_samples_select" on public.lab_samples
  for select to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'lab_sample.read')
    )
  );

drop policy if exists "lab_samples_insert" on public.lab_samples;
create policy "lab_samples_insert" on public.lab_samples
  for insert to authenticated
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'lab_sample.write')
    )
  );

drop policy if exists "lab_samples_update" on public.lab_samples;
create policy "lab_samples_update" on public.lab_samples
  for update to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'lab_sample.write')
    )
  )
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'lab_sample.write')
    )
  );

drop policy if exists "lab_samples_delete" on public.lab_samples;
create policy "lab_samples_delete" on public.lab_samples
  for delete to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'lab_sample.write')
    )
  );

-- ============================================================
-- 4. create_lab_sample RPC(为检验申请创建标本,单事务 + 审计)
--    - 校验 lab_order 存在且未完成(requested/collected)
--    - 生成 sample_no:LS-YYYYMMDD-随机后缀
-- ============================================================
create or replace function public.create_lab_sample(
  p_lab_order_id uuid,
  p_sample_type text default 'blood',
  p_operator_id uuid default null,
  p_container text default null,
  p_storage_condition text default null,
  p_remark text default null
)
returns public.lab_samples
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.lab_orders;
  v_sample_no text;
  v_sample public.lab_samples;
begin
  if p_sample_type not in ('blood', 'urine', 'feces', 'tissue', 'other') then
    raise exception 'INVALID_SAMPLE_TYPE' using errcode = 'P0003';
  end if;

  select * into v_order from public.lab_orders where id = p_lab_order_id for update;
  if not found then
    raise exception 'LAB_ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_order.status not in ('requested', 'collected') then
    raise exception 'LAB_ORDER_NOT_ACCEPTING_SAMPLE' using errcode = 'P0003',
      message = '仅待采集/已采集状态的检验申请可添加标本';
  end if;

  -- 生成租户内唯一标本编号
  v_sample_no := 'LS-' || to_char(now() at time zone 'Asia/Shanghai', 'YYYYMMDD') || '-' || upper(substr(md5(random()::text), 1, 6));

  insert into public.lab_samples (
    tenant_id, store_id, lab_order_id, sample_no, sample_type, status,
    planned_at, planned_by, container, storage_condition, remark
  )
  values (
    v_order.tenant_id, v_order.store_id, p_lab_order_id, v_sample_no, p_sample_type, 'planned',
    now(), p_operator_id, p_container, p_storage_condition, p_remark
  )
  returning * into v_sample;

  -- 事务内审计
  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_sample.tenant_id, v_sample.store_id, p_operator_id, 'lab_sample.create', 'lab_sample', v_sample.id,
          jsonb_build_object('sampleNo', v_sample_no, 'labOrderId', p_lab_order_id, 'sampleType', p_sample_type));

  return v_sample;
end;
$$;

-- ============================================================
-- 5. transition_lab_sample RPC(标本状态流转,单事务 + 审计)
--    状态机:
--      planned → collected → received → testing → completed
--      任意非终态 → rejected(须 reason)
--    自动填充时间/操作人;全部标本 completed 联动 lab_orders → collected
-- ============================================================
create or replace function public.transition_lab_sample(
  p_sample_id uuid,
  p_to_status text,
  p_operator_id uuid default null,
  p_reason text default null
)
returns public.lab_samples
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sample public.lab_samples;
begin
  select * into v_sample from public.lab_samples where id = p_sample_id for update;
  if not found then
    raise exception 'LAB_SAMPLE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 校验目标状态合法(防御 CHECK 之外的错误码)
  if p_to_status not in ('planned', 'collected', 'received', 'testing', 'completed', 'rejected') then
    raise exception 'INVALID_SAMPLE_STATUS' using errcode = 'P0003';
  end if;

  -- 状态机合法性校验
  if not (
    (v_sample.status = 'planned' and p_to_status in ('collected', 'rejected'))
    or (v_sample.status = 'collected' and p_to_status in ('received', 'rejected'))
    or (v_sample.status = 'received' and p_to_status in ('testing', 'rejected'))
    or (v_sample.status = 'testing' and p_to_status in ('completed', 'rejected'))
  ) then
    raise exception 'INVALID_SAMPLE_TRANSITION' using errcode = 'P0003',
      message = '标本状态不可由 ' || v_sample.status || ' 转为 ' || p_to_status;
  end if;

  -- rejected 必须填写原因
  if p_to_status = 'rejected' and (p_reason is null or p_reason = '') then
    raise exception 'REJECT_REASON_REQUIRED' using errcode = 'P0003';
  end if;

  -- 按目标状态填充对应时间/操作人
  update public.lab_samples
  set status = p_to_status,
      collected_at = case when p_to_status = 'collected' then now() else collected_at end,
      collected_by = case when p_to_status = 'collected' then p_operator_id else collected_by end,
      received_at  = case when p_to_status = 'received'  then now() else received_at end,
      received_by  = case when p_to_status = 'received'  then p_operator_id else received_by end,
      rejected_at  = case when p_to_status = 'rejected'  then now() else rejected_at end,
      rejected_by  = case when p_to_status = 'rejected'  then p_operator_id else rejected_by end,
      reject_reason = case when p_to_status = 'rejected' then p_reason else null end,
      remark       = case when p_reason is not null and p_reason <> '' then coalesce(remark, '') || ' | ' || p_reason else remark end,
      updated_at = now()
  where id = p_sample_id
  returning * into v_sample;

  -- 联动:该 lab_order 全部标本 completed → lab_orders:requested → collected(不覆盖已采集/完成)
  if p_to_status = 'completed' then
    update public.lab_orders lo
    set status = 'collected', collected_at = coalesce(lo.collected_at, now()), updated_at = now()
    where lo.id = v_sample.lab_order_id
      and lo.status = 'requested'
      and not exists (
        select 1 from public.lab_samples ls
        where ls.lab_order_id = v_sample.lab_order_id
          and ls.status <> 'completed'
      );
  end if;

  -- 事务内审计
  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_sample.tenant_id, v_sample.store_id, p_operator_id, 'lab_sample.transition', 'lab_sample', p_sample_id,
          jsonb_build_object('fromStatus', v_sample.status, 'toStatus', p_to_status, 'reason', p_reason));

  return v_sample;
end;
$$;

-- ============================================================
-- 6. 结束(权限收紧统一放 migration 49 的 revoke DO 块)
-- ============================================================
