-- ============================================================
-- 20260811000054_nursing_plan_generate_tasks.sql
-- E-R-4(3.7.2-01) 护理计划 → 护理任务批量生成(修复任务清单 R-4, P2)
--
-- 能力:
--   1. nursing_tasks 增加 source_type 列(manual / plan_generated),
--      并为自动生成任务建立幂等唯一键 (plan_id, scheduled_at)。
--   2. generate_nursing_tasks(p_plan_id) RPC:按护理计划起止日期/频率
--      批量生成 nursing_tasks,重复执行不产生重复任务(on conflict do nothing)。
--
-- 频率 → 每日执行时点(Asia/Shanghai):
--   q4h: 00/04/08/12/16/20 点(每日 6 次)
--   q6h: 00/06/12/18 点(每日 4 次)
--   q8h: 00/08/16 点(每日 3 次)
--   q12h: 00/12 点(每日 2 次)
--   daily: 09 点(每日 1 次)
--   twice_daily: 09/17 点(每日 2 次)
-- 说明:end_date 为空时仅生成 start_date 当天任务,避免无限批量生成。
-- 幂等,可重复应用。
-- ============================================================

-- ===== 1. nursing_tasks 增加 source_type 列 =====
alter table public.nursing_tasks
  add column if not exists source_type text not null default 'manual';

-- 自动生成任务幂等键:同一计划同一执行时间只生成一次(手工任务 source_type=manual 不受影响)
create unique index if not exists idx_nursing_tasks_plan_scheduled_auto
  on public.nursing_tasks (plan_id, scheduled_at)
  where plan_id is not null and source_type = 'plan_generated';

-- ===== 2. generate_nursing_tasks RPC(护理计划 → 护理任务批量生成) =====
create or replace function public.generate_nursing_tasks(
  p_plan_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan public.nursing_plans;
  v_interval_hours integer;
  v_day_hours integer[];                 -- 每日固定时点(daily/twice_daily 用)
  v_cur_date date;
  v_end_date date;
  v_ts timestamptz;
  v_hour integer;
  v_generated integer := 0;
  v_skipped integer := 0;
begin
  -- 锁定护理计划
  select * into v_plan from public.nursing_plans
  where id = p_plan_id
  for update;
  if not found then
    raise exception 'NURSING_PLAN_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not v_plan.is_active then
    raise exception 'NURSING_PLAN_INACTIVE' using errcode = 'P0003';
  end if;

  -- 频率 → 执行规则
  case v_plan.frequency
    when 'q4h' then v_interval_hours := 4;
    when 'q6h' then v_interval_hours := 6;
    when 'q8h' then v_interval_hours := 8;
    when 'q12h' then v_interval_hours := 12;
    when 'daily' then v_day_hours := array[9];
    when 'twice_daily' then v_day_hours := array[9, 17];
    else raise exception 'INVALID_NURSING_FREQUENCY' using errcode = 'P0003';
  end case;

  -- 起止日期:end_date 为空时仅生成 start_date 当天
  v_end_date := coalesce(v_plan.end_date, v_plan.start_date);
  v_cur_date := v_plan.start_date;

  while v_cur_date <= v_end_date loop
    if v_plan.frequency in ('daily', 'twice_daily') then
      -- 固定时点模式
      foreach v_hour in array v_day_hours loop
        v_ts := ((v_cur_date::text || ' ' || lpad(v_hour::text, 2, '0') || ':00:00')::timestamp at time zone 'Asia/Shanghai');
        insert into public.nursing_tasks (
          tenant_id, store_id, admission_id, pet_id, plan_id,
          task_type, description, scheduled_at, status, source_type
        )
        values (
          v_plan.tenant_id, v_plan.store_id, v_plan.admission_id, v_plan.pet_id, v_plan.id,
          'other', v_plan.plan_name, v_ts, 'pending', 'plan_generated'
        )
        on conflict (plan_id, scheduled_at)
        where plan_id is not null and source_type = 'plan_generated'
        do nothing;

        if found then
          v_generated := v_generated + 1;
        else
          v_skipped := v_skipped + 1;
        end if;
      end loop;
    else
      -- 等间隔模式(每 N 小时)
      v_hour := 0;
      while v_hour < 24 loop
        v_ts := ((v_cur_date::text || ' ' || lpad(v_hour::text, 2, '0') || ':00:00')::timestamp at time zone 'Asia/Shanghai');
        insert into public.nursing_tasks (
          tenant_id, store_id, admission_id, pet_id, plan_id,
          task_type, description, scheduled_at, status, source_type
        )
        values (
          v_plan.tenant_id, v_plan.store_id, v_plan.admission_id, v_plan.pet_id, v_plan.id,
          'other', v_plan.plan_name, v_ts, 'pending', 'plan_generated'
        )
        on conflict (plan_id, scheduled_at)
        where plan_id is not null and source_type = 'plan_generated'
        do nothing;

        if found then
          v_generated := v_generated + 1;
        else
          v_skipped := v_skipped + 1;
        end if;

        v_hour := v_hour + v_interval_hours;
      end loop;
    end if;

    v_cur_date := v_cur_date + 1;
  end loop;

  -- 审计
  if p_operator_id is not null then
    insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
    values (v_plan.tenant_id, v_plan.store_id, p_operator_id, 'nursing_plan.generate_tasks', 'nursing_plan', v_plan.id,
            jsonb_build_object('planId', v_plan.id, 'generatedCount', v_generated, 'skippedCount', v_skipped,
                               'startDate', v_plan.start_date, 'endDate', v_plan.end_date, 'frequency', v_plan.frequency));
  end if;

  return jsonb_build_object(
    'planId', v_plan.id,
    'planName', v_plan.plan_name,
    'generatedCount', v_generated,
    'skippedCount', v_skipped
  );
end;
$$;

-- ===== 3. RPC 权限收紧(自包含,幂等;service-role-only 与 migration 92 模式一致) =====
do $$
declare
  v_sig text;
begin
  for v_sig in
    select p.oid::regprocedure::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'generate_nursing_tasks'
      and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public', v_sig);
    execute format('revoke all on function %s from anon', v_sig);
    execute format('revoke all on function %s from authenticated', v_sig);
    execute format('grant execute on function %s to service_role', v_sig);
  end loop;
end;
$$;

-- ============================================================
-- 结束
-- ============================================================
