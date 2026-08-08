-- ============================================================
-- 20260809000056_approval_self_review.sql
-- P0-17:可信层禁止"自己审批自己"
--   - approve_discount(requested_by = approved_by 拒绝)
--   - review_record_amendment(requested_by = reviewer 拒绝)
-- 应用方式:Supabase SQL Editor 按编号顺序执行(幂等)
-- ============================================================

-- ===== 1. approve_discount 禁止自审 =====
create or replace function public.approve_discount(
  p_approval_id uuid,
  p_status text,
  p_approved_by uuid default null,
  p_reason text default null
)
returns public.approvals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_approval public.approvals;
begin
  if p_status not in ('approved', 'rejected') then
    raise exception 'INVALID_APPROVAL_STATUS' using errcode = 'P0003';
  end if;

  select * into v_approval from public.approvals where id = p_approval_id for update;
  if not found then
    raise exception 'APPROVAL_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_approval.status <> 'pending' then
    raise exception 'APPROVAL_ALREADY_PROCESSED' using errcode = 'P0003';
  end if;

  -- P0-17:申请人不可审批自己的申请
  if p_approved_by is not null and v_approval.requested_by = p_approved_by then
    raise exception 'SELF_APPROVAL_FORBIDDEN' using errcode = 'P0003';
  end if;

  update public.approvals
  set status = p_status,
      approved_by = p_approved_by,
      approved_at = now(),
      reason = coalesce(p_reason, reason),
      updated_at = now()
  where id = p_approval_id
  returning * into v_approval;

  return v_approval;
end;
$$;

revoke all on function public.approve_discount(uuid, text, uuid, text) from public;
grant execute on function public.approve_discount(uuid, text, uuid, text) to authenticated;

-- ===== 2. review_record_amendment 禁止自审 =====
create or replace function public.review_record_amendment(
  p_amendment_id uuid,
  p_decision text,
  p_reviewer_employee_id uuid,
  p_reason text default null
)
returns public.medical_record_amendments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.medical_record_amendments;
  v_emp_exists boolean;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'INVALID_DECISION' using errcode = 'P0003';
  end if;

  select * into v_row from public.medical_record_amendments where id = p_amendment_id for update;
  if not found then
    raise exception 'AMENDMENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'AMENDMENT_NOT_PENDING' using errcode = 'P0003';
  end if;

  -- P0-17:申请人不可审批自己的修订申请
  if v_row.requested_by = p_reviewer_employee_id then
    raise exception 'SELF_APPROVAL_FORBIDDEN' using errcode = 'P0003';
  end if;

  select exists(
    select 1 from public.employees
    where id = p_reviewer_employee_id and tenant_id = v_row.tenant_id and status = 'active'
  ) into v_emp_exists;
  if not v_emp_exists then
    raise exception 'OPERATOR_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.medical_record_amendments
  set status = p_decision,
      reviewed_by = p_reviewer_employee_id,
      reviewed_at = now(),
      rejected_reason = case when p_decision = 'rejected' then coalesce(p_reason, '') else rejected_reason end,
      updated_at = now()
  where id = p_amendment_id
  returning * into v_row;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_row.tenant_id, v_row.store_id, null,
          case when p_decision = 'approved' then 'medical_record.amend.approve' else 'medical_record.amend.reject' end,
          'medical_record_amendment', p_amendment_id,
          jsonb_build_object('reviewer_employee_id', p_reviewer_employee_id,
                             'decision', p_decision, 'reason', p_reason));

  return v_row;
end;
$$;

revoke all on function public.review_record_amendment(uuid, text, uuid, text) from public;
grant execute on function public.review_record_amendment(uuid, text, uuid, text) to authenticated;

-- ===== 3. SELF_APPROVAL_FORBIDDEN 权限码映射说明 =====
-- 前端调用 /api/billing/approvals/:id/decide 或 /api/compliance/amendments/:id/review
-- 遇到 422 SELF_APPROVAL_FORBIDDEN 时,应提示"不可审批本人申请"并隐藏/禁用对应按钮。
-- 该错误码由各路由的 mapRpcError 映射为 422 业务规则失败。
