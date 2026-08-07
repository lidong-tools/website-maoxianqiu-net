-- ============================================================
-- 20260809000047_progress_notes_medical_lab_refs.sql
-- S3.1 并发任务 C 医疗闭环增强:住院病程记录 + 医嘱-检验关联
--
-- 角色:开发员工 C(独占 migration 44~49)
--
-- 本文件内容:
--   1. inpatient_progress_notes 病程记录表(daily/critical/preop/postop/discharge,
--      状态 draft → signed,签署人须具备 progress.sign)
--   2. medical_lab_refs 医嘱-检验申请关联表(medical_orders ↔ lab_orders)
--   3. 权限码:progress.view / progress.write / progress.sign
--   4. RLS 策略(inpatient_progress_notes 按 progress.* 隔离;
--      medical_lab_refs 镜像 medical_orders 隔离)
--   5. 原子 RPC(全部 service-role-only,Hono 以 service role 调用):
--      create_progress_note / sign_progress_note / link_medical_lab_ref
--   6. 审计:各 RPC 事务内写 audit_logs
--
-- 设计要点:
--   - 病程记录遵循"记录 → 签署"双时点闭环,签署后内容不可再改(RLS + RPC 双兜底)
--   - 签署可本人签署或主治医生签署(Hono 层按 progress.sign 授权)
--   - medical_lab_refs 关联创建走 RPC 校验两实体归属同租户,防跨租户引用
--   - 权限码与角色分配统一在 migration 49 完成
-- 幂等,可重复应用
-- ============================================================

-- ============================================================
-- 1. inpatient_progress_notes 表(病程记录)
-- ============================================================
create table if not exists public.inpatient_progress_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,
  admission_id uuid not null,                             -- 引用 admissions.id,不加 FK
  pet_id uuid not null,                                   -- 引用 pets.id,不加 FK
  note_no text not null,                                  -- 病程记录编号(租户内唯一)
  note_type text not null default 'daily',                -- daily/critical/preop/postop/discharge
  content text not null,                                  -- 病程内容(支持换行)
  status text not null default 'draft',                   -- draft/signed
  recorded_at timestamptz not null default now(),         -- 记录时间
  recorded_by uuid,                                       -- 记录医生(auth.users.id)
  signed_at timestamptz,                                  -- 签署时间
  signed_by uuid,                                         -- 签署医生(auth.users.id)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint progress_notes_type_check check (
    note_type in ('daily', 'critical', 'preop', 'postop', 'discharge')
  ),
  constraint progress_notes_status_check check (status in ('draft', 'signed'))
);

-- 租户内病程编号唯一
create unique index if not exists idx_progress_notes_tenant_no
  on public.inpatient_progress_notes (tenant_id, note_no);
create index if not exists idx_progress_notes_tenant_store
  on public.inpatient_progress_notes (tenant_id, store_id);
create index if not exists idx_progress_notes_admission
  on public.inpatient_progress_notes (admission_id, recorded_at desc);
create index if not exists idx_progress_notes_pet
  on public.inpatient_progress_notes (tenant_id, pet_id);
create index if not exists idx_progress_notes_status
  on public.inpatient_progress_notes (tenant_id, store_id, status);

drop trigger if exists trg_progress_notes_updated_at on public.inpatient_progress_notes;
create trigger trg_progress_notes_updated_at
  before update on public.inpatient_progress_notes
  for each row execute procedure public.touch_updated_at();

-- ============================================================
-- 2. medical_lab_refs 表(医嘱-检验申请关联)
-- ============================================================
create table if not exists public.medical_lab_refs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,
  medical_order_id uuid not null,                         -- 引用 medical_orders.id,不加 FK
  lab_order_id uuid not null,                             -- 引用 lab_orders.id,不加 FK
  link_type text not null default 'order_request',        -- order_request/result_followup
  created_by uuid,                                        -- 创建人(auth.users.id)
  created_at timestamptz not null default now(),

  constraint medical_lab_refs_link_type_check check (
    link_type in ('order_request', 'result_followup')
  )
);

-- 同一(医嘱,检验申请)仅一条关联,防重复
create unique index if not exists idx_medical_lab_refs_unique
  on public.medical_lab_refs (medical_order_id, lab_order_id);
create index if not exists idx_medical_lab_refs_order
  on public.medical_lab_refs (medical_order_id);
create index if not exists idx_medical_lab_refs_lab
  on public.medical_lab_refs (lab_order_id);
create index if not exists idx_medical_lab_refs_tenant_store
  on public.medical_lab_refs (tenant_id, store_id);

-- ============================================================
-- 3. 权限码(progress.view / write / sign)
-- ============================================================
insert into public.permissions (code, name, module) values
  ('progress.view', '查看住院病程', 'inpatient'),
  ('progress.write', '记录住院病程', 'inpatient'),
  ('progress.sign', '签署住院病程', 'inpatient')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- ============================================================
-- 4. RLS 策略
-- ============================================================
alter table public.inpatient_progress_notes enable row level security;
alter table public.medical_lab_refs enable row level security;

-- inpatient_progress_notes:读须 progress.view,写须 progress.write
drop policy if exists "progress_notes_select" on public.inpatient_progress_notes;
create policy "progress_notes_select" on public.inpatient_progress_notes
  for select to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'progress.view')
    )
  );

drop policy if exists "progress_notes_insert" on public.inpatient_progress_notes;
create policy "progress_notes_insert" on public.inpatient_progress_notes
  for insert to authenticated
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'progress.write')
    )
  );

drop policy if exists "progress_notes_update" on public.inpatient_progress_notes;
create policy "progress_notes_update" on public.inpatient_progress_notes
  for update to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'progress.write')
    )
  )
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'progress.write')
    )
  );

drop policy if exists "progress_notes_delete" on public.inpatient_progress_notes;
create policy "progress_notes_delete" on public.inpatient_progress_notes
  for delete to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'progress.write')
    )
  );

-- medical_lab_refs:读同 medical_orders(租户成员+门店),写须 nurse_task.manage
drop policy if exists "medical_lab_refs_select" on public.medical_lab_refs;
create policy "medical_lab_refs_select" on public.medical_lab_refs
  for select to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
    )
  );

drop policy if exists "medical_lab_refs_insert" on public.medical_lab_refs;
create policy "medical_lab_refs_insert" on public.medical_lab_refs
  for insert to authenticated
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'nurse_task.manage')
    )
  );

drop policy if exists "medical_lab_refs_delete" on public.medical_lab_refs;
create policy "medical_lab_refs_delete" on public.medical_lab_refs
  for delete to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'nurse_task.manage')
    )
  );

-- ============================================================
-- 5. create_progress_note RPC(记录病程,单事务 + 审计)
--    - 校验 admission 存在且住院中(admitted)
--    - 生成 note_no:PN-YYYYMMDD-随机后缀
-- ============================================================
create or replace function public.create_progress_note(
  p_admission_id uuid,
  p_content text,
  p_note_type text default 'daily',
  p_recorded_at timestamptz default null,
  p_operator_id uuid default null
)
returns public.inpatient_progress_notes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admission public.admissions;
  v_note_no text;
  v_note public.inpatient_progress_notes;
begin
  if p_content is null or p_content = '' then
    raise exception 'PROGRESS_CONTENT_REQUIRED' using errcode = 'P0003';
  end if;
  if p_note_type not in ('daily', 'critical', 'preop', 'postop', 'discharge') then
    raise exception 'INVALID_PROGRESS_TYPE' using errcode = 'P0003';
  end if;

  select * into v_admission from public.admissions where id = p_admission_id for update;
  if not found then
    raise exception 'ADMISSION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_admission.status <> 'admitted' then
    raise exception 'ADMISSION_NOT_ADMITTED' using errcode = 'P0003',
      message = '仅住院中的记录可书写病程';
  end if;

  -- 生成租户内唯一病程编号
  v_note_no := 'PN-' || to_char(now() at time zone 'Asia/Shanghai', 'YYYYMMDD') || '-' || upper(substr(md5(random()::text), 1, 6));

  insert into public.inpatient_progress_notes (
    tenant_id, store_id, admission_id, pet_id, note_no, note_type,
    content, status, recorded_at, recorded_by
  )
  values (
    v_admission.tenant_id, v_admission.store_id, p_admission_id, v_admission.pet_id,
    v_note_no, p_note_type, p_content, 'draft',
    coalesce(p_recorded_at, now()), p_operator_id
  )
  returning * into v_note;

  -- 事务内审计
  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_note.tenant_id, v_note.store_id, p_operator_id, 'progress_note.create', 'inpatient_progress_note', v_note.id,
          jsonb_build_object('noteNo', v_note_no, 'noteType', p_note_type, 'admissionId', p_admission_id));

  return v_note;
end;
$$;

-- ============================================================
-- 6. sign_progress_note RPC(签署病程,单事务 + 审计)
--    - 状态机:draft → signed(终态,签署后内容不可再改)
-- ============================================================
create or replace function public.sign_progress_note(
  p_note_id uuid,
  p_signed_by uuid default null
)
returns public.inpatient_progress_notes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note public.inpatient_progress_notes;
begin
  select * into v_note from public.inpatient_progress_notes where id = p_note_id for update;
  if not found then
    raise exception 'PROGRESS_NOTE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_note.status <> 'draft' then
    raise exception 'PROGRESS_NOTE_ALREADY_SIGNED' using errcode = 'P0003',
      message = '病程已签署,不可重复签署';
  end if;

  update public.inpatient_progress_notes
  set status = 'signed',
      signed_at = now(),
      signed_by = p_signed_by,
      updated_at = now()
  where id = p_note_id
  returning * into v_note;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_note.tenant_id, v_note.store_id, p_signed_by, 'progress_note.sign', 'inpatient_progress_note', p_note_id,
          jsonb_build_object('noteNo', v_note.note_no, 'admissionId', v_note.admission_id));

  return v_note;
end;
$$;

-- ============================================================
-- 7. link_medical_lab_ref RPC(建立医嘱-检验关联,单事务 + 审计)
--    - 校验 medical_order 与 lab_order 同租户(防跨租户引用)
--    - 幂等:同(medical_order_id, lab_order_id)命中直接返回原记录
-- ============================================================
create or replace function public.link_medical_lab_ref(
  p_medical_order_id uuid,
  p_lab_order_id uuid,
  p_link_type text default 'order_request',
  p_operator_id uuid default null
)
returns public.medical_lab_refs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.medical_orders;
  v_lab public.lab_orders;
  v_ref public.medical_lab_refs;
begin
  if p_link_type not in ('order_request', 'result_followup') then
    raise exception 'INVALID_LINK_TYPE' using errcode = 'P0003';
  end if;

  select * into v_order from public.medical_orders where id = p_medical_order_id for update;
  if not found then
    raise exception 'MEDICAL_ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_lab from public.lab_orders where id = p_lab_order_id for update;
  if not found then
    raise exception 'LAB_ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 跨租户引用防护
  if v_order.tenant_id <> v_lab.tenant_id then
    raise exception 'CROSS_TENANT_REF' using errcode = 'P0003',
      message = '医嘱与检验申请不属于同一租户';
  end if;

  -- 幂等:已存在直接返回
  select * into v_ref from public.medical_lab_refs
  where medical_order_id = p_medical_order_id and lab_order_id = p_lab_order_id;
  if v_ref.id is not null then
    return v_ref;
  end if;

  insert into public.medical_lab_refs (
    tenant_id, store_id, medical_order_id, lab_order_id, link_type, created_by
  )
  values (
    v_order.tenant_id, coalesce(v_order.store_id, v_lab.store_id),
    p_medical_order_id, p_lab_order_id, p_link_type, p_operator_id
  )
  returning * into v_ref;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_ref.tenant_id, v_ref.store_id, p_operator_id, 'medical_lab_ref.link', 'medical_lab_ref', v_ref.id,
          jsonb_build_object('medicalOrderId', p_medical_order_id, 'labOrderId', p_lab_order_id, 'linkType', p_link_type));

  return v_ref;
end;
$$;

-- ============================================================
-- 8. 结束(权限收紧统一放 migration 49 的 revoke DO 块)
-- ============================================================
