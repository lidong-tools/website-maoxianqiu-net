-- ============================================================
-- G-3.9 R-2 报告插入病历:encounter_lab_result_refs 病历引用检验结果表
--
-- 需求依据:PRD §12.2「发布后医生可一键引用到病历」、S31 §6「引用必须保留
--   source_lab_result_id,不得只复制文本」。
--
-- 设计要点:
--   1. source_lab_result_id 外键引用 lab_order_analytes(id),保证可追溯;
--   2. snapshot jsonb 保存引用时的结果快照(文本 + 结果项明细),
--      后续结果被修订时旧引用内容不受破坏(快照生效);
--   3. target_field 记录插入到病历的哪个字段;
--   4. RLS 跟随 encounter(encounter.view/clinical 权限族:读=跟随联表,
--      写=encounter.work)。
-- ============================================================

create table if not exists public.encounter_lab_result_refs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  pet_id uuid not null,
  -- 来源检验申请与结果项(可追溯,删除后级联清理引用)
  lab_order_id uuid not null references public.lab_orders(id) on delete cascade,
  source_lab_result_id uuid not null references public.lab_order_analytes(id) on delete cascade,
  -- 引用时的结果快照(修订后旧引用不受破坏)
  snapshot jsonb not null,
  -- 插入到病历的哪个字段(与 encounters 表列对应)
  target_field text not null,
  sort_order integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint encounter_lab_result_refs_target_check check (
    target_field in ('chief_complaint', 'history_present', 'exam_findings', 'diagnosis_text', 'treatment_plan')
  )
);

create index if not exists idx_encounter_lab_refs_encounter on public.encounter_lab_result_refs (encounter_id, created_at desc);
create index if not exists idx_encounter_lab_refs_pet on public.encounter_lab_result_refs (tenant_id, pet_id);
create index if not exists idx_encounter_lab_refs_order on public.encounter_lab_result_refs (lab_order_id);

-- ===== RLS:跟随 encounter(联表校验,encounter.view/clinical 权限族) =====
alter table public.encounter_lab_result_refs enable row level security;

-- 读:能读到关联 encounter(租户成员 + 门店可达)即可见,与 encounters_select 语义一致
drop policy if exists "encounter_lab_result_refs_select" on public.encounter_lab_result_refs;
create policy "encounter_lab_result_refs_select" on public.encounter_lab_result_refs
  for select to authenticated
  using (
    exists (
      select 1 from public.encounters e
      where e.id = encounter_lab_result_refs.encounter_id
        and public.is_tenant_member(e.tenant_id)
        and (e.store_id is null or public.can_access_store(e.tenant_id, e.store_id))
    )
  );

-- 写:临床权限族 encounter.work(Hono Command 为权威写入路径,RLS 兜底)
drop policy if exists "encounter_lab_result_refs_insert" on public.encounter_lab_result_refs;
create policy "encounter_lab_result_refs_insert" on public.encounter_lab_result_refs
  for insert to authenticated
  with check (
    exists (
      select 1 from public.encounters e
      where e.id = encounter_lab_result_refs.encounter_id
        and public.is_tenant_member(e.tenant_id)
        and (e.store_id is null or public.can_access_store(e.tenant_id, e.store_id))
        and public.has_permission(e.tenant_id, e.store_id, 'encounter.work')
    )
  );

drop policy if exists "encounter_lab_result_refs_update" on public.encounter_lab_result_refs;
create policy "encounter_lab_result_refs_update" on public.encounter_lab_result_refs
  for update to authenticated
  using (
    exists (
      select 1 from public.encounters e
      where e.id = encounter_lab_result_refs.encounter_id
        and public.is_tenant_member(e.tenant_id)
        and (e.store_id is null or public.can_access_store(e.tenant_id, e.store_id))
        and public.has_permission(e.tenant_id, e.store_id, 'encounter.work')
    )
  )
  with check (
    exists (
      select 1 from public.encounters e
      where e.id = encounter_lab_result_refs.encounter_id
        and public.is_tenant_member(e.tenant_id)
        and (e.store_id is null or public.can_access_store(e.tenant_id, e.store_id))
        and public.has_permission(e.tenant_id, e.store_id, 'encounter.work')
    )
  );

drop policy if exists "encounter_lab_result_refs_delete" on public.encounter_lab_result_refs;
create policy "encounter_lab_result_refs_delete" on public.encounter_lab_result_refs
  for delete to authenticated
  using (
    exists (
      select 1 from public.encounters e
      where e.id = encounter_lab_result_refs.encounter_id
        and public.is_tenant_member(e.tenant_id)
        and (e.store_id is null or public.can_access_store(e.tenant_id, e.store_id))
        and public.has_permission(e.tenant_id, e.store_id, 'encounter.work')
    )
  );
