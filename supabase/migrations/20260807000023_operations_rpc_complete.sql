-- ============================================================
-- 20260807000023_operations_rpc_complete.sql
-- Operations 领域 RPC 完整实现(R-07 补齐)
--   - scan_reminders(MXQ-12004):提醒扫描 + 消息模板匹配
--   - send_delivery(MXQ-12005):消息发送,供应商适配模拟
--   - generate_report_snapshot(MXQ-12008):报表快照查询
--
-- 说明:
--   - 覆盖 00018 中的"框架/桩"实现,函数签名与桩完全一致,保留 revoke/grant
--   - 幂等:create or replace function + on conflict 兜底,可重复应用
--   - 禁止修改旧 migration(00001~00022),本文件为纯新增
--   - 测试契约(rls_operations.sql):
--     O15 scan_reminders 返回 jsonb 含 scanned_count/scanned_at;有到期 pending 提醒时 >= 1
--     O18 generate_report_snapshot 返回快照,report_id 关联定义、period_start 等于入参
--     O19 period_start > period_end 抛 INVALID_PERIOD
--   - send_delivery 无测试覆盖,按 MXQ-12005 完成供应商模拟 + 幂等
-- ============================================================

-- ============================================================
-- MXQ-12004 scan_reminders RPC(完整实现)
-- 扫描到期提醒 → 匹配消息模板 → 创建待发送交付 → 标记提醒已处理
--   - 仅扫描 status='pending' 且 scheduled_at <= now() 的提醒
--   - p_store_id 为 null 表示全部门店
--   - 模板匹配规则:优先 payload.template_code,其次按提醒类型约定 code
--     ({type}_reminder),均按 version 取最新;无匹配模板时仍创建交付(内容用 payload)
--   - 幂等:同一提醒已有交付(not exists + 唯一索引兜底)则跳过,不重复创建
--   - 创建交付后把提醒标记为 sent(reminders 表已有 status 列,不改表结构)
--   - 返回 { scanned_count, scanned_at }
-- ============================================================
create or replace function public.scan_reminders(
  p_tenant_id uuid,
  p_store_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_now timestamptz := now();
  v_rem public.reminders;
  v_tpl public.message_templates;
  v_channel text;
  v_recipient text;
  v_content text;
  v_customer_phone text;
  v_customer_email text;
  v_k text;
  v_v text;
begin
  -- 逐条扫描到期且待发送的提醒(加行锁 + skip locked 防并发重复扫描)
  for v_rem in
    select r.*
    from public.reminders r
    where r.tenant_id = p_tenant_id
      and (p_store_id is null or r.store_id = p_store_id)
      and r.status = 'pending'
      and r.scheduled_at <= v_now
      and not exists (
        select 1 from public.message_deliveries md
        where md.reminder_id = r.id
      )
    order by r.scheduled_at
    for update of r skip locked
  loop
    -- 重置复合类型变量(select into 无匹配行时保持旧值,需手动置空)
    v_tpl := null;

    -- 匹配消息模板:优先 payload.template_code,其次按提醒类型约定 code,取最新版本
    select * into v_tpl
    from public.message_templates
    where tenant_id = p_tenant_id
      and is_active = true
      and code = coalesce(
        nullif(v_rem.payload->>'template_code', ''),
        v_rem.type || '_reminder'
      )
    order by version desc
    limit 1;

    -- 解析渠道:模板 channel 优先,其次 payload.channel,默认 sms
    v_channel := case
      when v_tpl is not null then coalesce(v_tpl.channel, nullif(v_rem.payload->>'channel', ''), 'sms')
      else coalesce(nullif(v_rem.payload->>'channel', ''), 'sms')
    end;

    -- 解析收件人:优先 payload.recipient,其次按客户档案取 phone/email
    v_recipient := nullif(v_rem.payload->>'recipient', '');
    if v_recipient is null and v_rem.customer_id is not null then
      select phone, email into v_customer_phone, v_customer_email
      from public.customers
      where id = v_rem.customer_id and tenant_id = p_tenant_id;
      if found then
        v_recipient := case when v_channel = 'email' then v_customer_email else v_customer_phone end;
      end if;
    end if;
    v_recipient := coalesce(v_recipient, '');

    -- 渲染内容快照:模板 body 做变量替换;无模板时用 payload 文本
    if v_tpl is not null then
      v_content := replace(v_tpl.body, '{{customer_id}}', coalesce(v_rem.customer_id::text, ''));
      v_content := replace(v_content, '{{pet_id}}', coalesce(v_rem.pet_id::text, ''));
      v_content := replace(v_content, '{{type}}', v_rem.type);
      v_content := replace(v_content, '{{scheduled_at}}', to_char(v_rem.scheduled_at, 'YYYY-MM-DD HH24:MI'));
      -- payload 内变量逐键替换 {{key}} → value
      for v_k, v_v in
        select * from jsonb_each_text(coalesce(v_rem.payload, '{}'::jsonb))
      loop
        v_content := replace(v_content, '{{' || v_k || '}}', v_v);
      end loop;
    else
      v_content := coalesce(v_rem.payload::text, '');
    end if;

    -- 创建待发送交付(幂等:唯一索引兜底,冲突时跳过)
    insert into public.message_deliveries (
      tenant_id, reminder_id, template_id, channel, recipient, content_snapshot, status
    ) values (
      p_tenant_id, v_rem.id, v_tpl.id, v_channel, v_recipient, v_content, 'queued'
    )
    on conflict do nothing;

    -- 插入成功才算处理过,并标记提醒已处理(pending → sent)
    if found then
      v_count := v_count + 1;
      update public.reminders
      set status = 'sent', sent_at = v_now
      where id = v_rem.id and status = 'pending';
    end if;
  end loop;

  -- 写入 jobs 队列(reminders 队列,异步消费发送任务)
  insert into public.jobs (tenant_id, store_id, queue, payload, status)
  values (
    p_tenant_id, p_store_id, 'reminders',
    jsonb_build_object('scanned_at', v_now, 'created_count', v_count),
    'queued'
  );

  return jsonb_build_object(
    'scanned_count', v_count,
    'scanned_at', v_now
  );
end;
$$;

revoke all on function public.scan_reminders(uuid, uuid) from public;
grant execute on function public.scan_reminders(uuid, uuid) to authenticated;

-- ============================================================
-- MXQ-12005 send_delivery RPC(完整实现,供应商适配模拟)
-- 将交付状态推进:queued/retry → sent / failed
--   - 幂等:已终态(sent/failed)直接返回现有行,不重复发送/不重复扣减
--   - 供应商适配:按 delivery.channel 映射模拟供应商
--     sms→mock-sms / email→mock-email / wechat→mock-wechat /
--     work_wechat→mock-work_wechat / 其他→mock-webhook
--   - p_provider_message_id 传 'MOCK_FAIL' 触发失败路径(演示/测试用),
--     否则按 'mock-{provider}-{id}' 生成供应商消息 id
--   - 发送成功后同步推进关联提醒状态(pending → sent)
-- ============================================================
create or replace function public.send_delivery(
  p_delivery_id uuid,
  p_provider_message_id text default null
)
returns public.message_deliveries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.message_deliveries;
  v_provider text;
  v_mock_id text;
  v_success boolean := true;
  v_error text;
begin
  -- 锁定交付记录,防止并发重复发送
  select * into v_row
  from public.message_deliveries
  where id = p_delivery_id
  for update;

  if not found then
    raise exception 'DELIVERY_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 幂等:已发送/已失败直接返回,不重复发送
  if v_row.status in ('sent', 'failed') then
    return v_row;
  end if;

  -- 渠道 → 供应商适配器映射
  v_provider := case v_row.channel
    when 'sms' then 'mock-sms'
    when 'email' then 'mock-email'
    when 'wechat' then 'mock-wechat'
    when 'work_wechat' then 'mock-work_wechat'
    else 'mock-webhook'
  end;

  -- 模拟供应商调用:MOCK_FAIL 走失败路径,其余成功
  if p_provider_message_id = 'MOCK_FAIL' then
    v_success := false;
    v_error := 'mock provider rejected';
  else
    v_mock_id := coalesce(p_provider_message_id, v_provider || '-' || replace(v_row.id::text, '-', ''));
  end if;

  -- 更新发送结果(状态推进 + attempts +1 + 写入供应商消息 id/错误)
  update public.message_deliveries
  set status = case when v_success then 'sent' else 'failed' end,
      sent_at = case when v_success then now() else null end,
      provider_message_id = case when v_success then v_mock_id else null end,
      error = case when v_success then null else v_error end,
      attempts = v_row.attempts + 1
  where id = p_delivery_id
  returning * into v_row;

  -- 同步推进关联提醒状态(pending → sent)
  if v_success and v_row.reminder_id is not null then
    update public.reminders
    set status = 'sent', sent_at = now()
    where id = v_row.reminder_id and status = 'pending';
  end if;

  return v_row;
end;
$$;

revoke all on function public.send_delivery(uuid, text) from public;
grant execute on function public.send_delivery(uuid, text) to authenticated;

-- ============================================================
-- MXQ-12008 generate_report_snapshot RPC(完整实现)
-- 按报表定义执行查询并落快照
--   - period_start > period_end 抛 INVALID_PERIOD(O19)
--   - 报表定义存在则按定义 category 执行聚合查询;不存在时自动创建默认定义
--     (category 按 code 关键词推断,兜底 customer)再生成快照(O18 契约兼容)
--   - 支持类别:revenue(invoices)/inventory(inventory_balances)/
--     customer(customers)/medical(encounters)
--   - 返回 report_snapshots 行:report_id 关联定义 id、period_start 等于入参
-- ============================================================
create or replace function public.generate_report_snapshot(
  p_tenant_id uuid,
  p_report_code text,
  p_period_start date,
  p_period_end date,
  p_generated_by uuid default null
)
returns public.report_snapshots
language plpgsql
security definer
set search_path = public
as $$
declare
  v_def public.report_definitions;
  v_row public.report_snapshots;
  v_category text;
  v_summary jsonb;
begin
  -- 参数校验:起始日期晚于结束日期直接抛错(O19)
  if p_period_start > p_period_end then
    raise exception 'INVALID_PERIOD' using errcode = 'P0003';
  end if;

  -- 查找启用的报表定义
  select * into v_def
  from public.report_definitions
  where tenant_id = p_tenant_id and code = p_report_code and is_active = true;

  -- 定义不存在时自动创建默认定义(可建默认快照)
  if not found then
    v_category := case
      when p_report_code ilike '%revenue%' or p_report_code ilike '%income%' then 'revenue'
      when p_report_code ilike '%inventory%' or p_report_code ilike '%stock%' then 'inventory'
      when p_report_code ilike '%customer%' or p_report_code ilike '%member%' then 'customer'
      when p_report_code ilike '%medical%' or p_report_code ilike '%clinical%' then 'medical'
      else 'customer'
    end;
    insert into public.report_definitions (tenant_id, code, name, category, query_config, is_active)
    values (p_tenant_id, p_report_code, p_report_code, v_category, jsonb_build_object('metric', v_category), true)
    on conflict (tenant_id, code) do update set is_active = true
    returning * into v_def;
  end if;

  -- 按定义类别执行报表聚合查询
  if v_def.category = 'revenue' then
    -- 收入报表:期间内已确认/已支付发票的笔数与金额
    select jsonb_build_object(
      'invoice_count', count(*),
      'total_amount', coalesce(sum(total), 0),
      'paid_amount', coalesce(sum(paid_amount), 0)
    ) into v_summary
    from public.invoices
    where tenant_id = p_tenant_id
      and created_at::date between p_period_start and p_period_end
      and status in ('confirmed', 'paid', 'partially_paid');
  elsif v_def.category = 'inventory' then
    -- 库存报表:当前在库商品数与可用/预留数量
    select jsonb_build_object(
      'sku_count', count(*),
      'total_on_hand', coalesce(sum(quantity_on_hand), 0),
      'total_reserved', coalesce(sum(quantity_reserved), 0)
    ) into v_summary
    from public.inventory_balances
    where tenant_id = p_tenant_id;
  elsif v_def.category = 'customer' then
    -- 客户报表:期间内新增客户数
    select jsonb_build_object(
      'new_customers', count(*)
    ) into v_summary
    from public.customers
    where tenant_id = p_tenant_id
      and created_at::date between p_period_start and p_period_end;
  elsif v_def.category = 'medical' then
    -- 医疗报表:期间内就诊量
    select jsonb_build_object(
      'encounter_count', count(*)
    ) into v_summary
    from public.encounters
    where tenant_id = p_tenant_id
      and started_at::date between p_period_start and p_period_end;
  else
    v_summary := '{}'::jsonb;
  end if;

  -- 落快照并返回(含聚合 summary、query_config 与期间信息)
  insert into public.report_snapshots (
    tenant_id, report_id, period_start, period_end, data, generated_by
  ) values (
    p_tenant_id, v_def.id, p_period_start, p_period_end,
    jsonb_build_object(
      'category', v_def.category,
      'summary', coalesce(v_summary, '{}'::jsonb),
      'query_config', v_def.query_config,
      'period', jsonb_build_object('start', p_period_start, 'end', p_period_end)
    ),
    p_generated_by
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.generate_report_snapshot(uuid, text, date, date, uuid) from public;
grant execute on function public.generate_report_snapshot(uuid, text, date, date, uuid) to authenticated;
