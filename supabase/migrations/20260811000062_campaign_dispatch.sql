-- ============================================================
-- 20260811000062_campaign_dispatch.sql
-- 营销活动发布后触发投递(F-R-3: 3.8.2-03 Campaign 发布后触发投递发送)
--   - message_deliveries 增加 campaign_id / run_no 关联列
--   - dispatch_campaign_run() RPC:按 run_id 关联 Audience + 模板 + 渠道,
--     逐客户渲染模板变量生成 queued 投递(替换 send_delivery Mock 链路的生成环节)
--
-- 说明:
--   - dispatch_campaign_run 只负责"生成 queued 投递",真实发送由
--     F-R-2 统一消费逻辑(api/routes/cron.ts 消费 queued → engine.retryDelivery)完成
--   - 幂等:唯一索引(campaign_id, run_no, recipient)兜底 + run.dispatch_count>0 快速返回
--   - 模板停用/不存在时抛 TEMPLATE_NOT_FOUND,发布端点可据此提示配置错误
--   - 纯新增,禁止修改旧 migration;自包含幂等,可重复应用
-- ============================================================
set search_path = public;

-- ===== 1. message_deliveries 增加 Campaign 关联列(幂等) =====
alter table public.message_deliveries
  add column if not exists campaign_id uuid references public.marketing_campaigns(id) on delete set null,
  add column if not exists run_no integer;

comment on column public.message_deliveries.campaign_id is
  '营销活动关联(dispatch_campaign_run 生成);投递记录可按活动筛选';
comment on column public.message_deliveries.run_no is
  '营销活动运行批次(与 marketing_campaign_runs.run_no 对应)';

create index if not exists idx_message_deliveries_tenant_campaign_run
  on public.message_deliveries (tenant_id, campaign_id, run_no);

-- 幂等:同一活动同一批次向同一收件人只生成一条投递
create unique index if not exists idx_message_deliveries_campaign_run_recipient
  on public.message_deliveries (campaign_id, run_no, recipient)
  where campaign_id is not null and run_no is not null;

-- ===== 2. dispatch_campaign_run RPC(F-R-3) =====
-- 按 run_id 关联:
--   marketing_campaign_runs → marketing_campaigns → message_templates
--   marketing_campaign_audiences → customers → pets → stores(门店档案)
-- 逐客户渲染模板变量生成 message_deliveries(queued):
--   scene = birthday(生日活动)/marketing(其余)
--   recipient 按渠道解析:sms→phone / email→email / wechat/work_wechat 无档案跳过
-- 渲染仅做白名单变量替换(与 template-engine.ts VARIABLE_WHITELIST 对齐),
-- 渲染后残留占位符清空,避免把 {{...}} 原文发给客户。
create or replace function public.dispatch_campaign_run(
  p_run_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run record;
  v_campaign record;
  v_template record;
  v_tenant record;
  v_store record;
  v_aud record;
  v_customer record;
  v_pet record;
  v_count integer := 0;
  v_scene text;
  v_channel text;
  v_recipient text;
  v_content text;
  v_subject text;
  v_store_name text;
  v_store_phone text;
  v_store_address text;
  v_tenant_name text;
  v_pet_name text;
  v_pet_species text;
begin
  -- 校验 run 存在
  select * into v_run from public.marketing_campaign_runs where id = p_run_id;
  if not found then
    raise exception 'RUN_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 幂等:该 run 已 dispatch 过则直接返回,不重复生成投递
  if v_run.dispatch_count > 0 then
    return jsonb_build_object(
      'run_id', p_run_id,
      'campaign_id', v_run.campaign_id,
      'run_no', v_run.run_no,
      'dispatch_count', v_run.dispatch_count,
      'idempotent', true
    );
  end if;

  -- 活动与模板
  select * into v_campaign
  from public.marketing_campaigns
  where id = v_run.campaign_id and tenant_id = v_run.tenant_id;
  if not found then
    raise exception 'CAMPAIGN_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 未配置模板:无可发送内容,直接返回 0(不算错误,发布端点按可空模板处理)
  if v_campaign.message_template_id is null then
    return jsonb_build_object(
      'run_id', p_run_id,
      'campaign_id', v_run.campaign_id,
      'run_no', v_run.run_no,
      'dispatch_count', 0,
      'skipped', 'no_template'
    );
  end if;

  select * into v_template
  from public.message_templates
  where id = v_campaign.message_template_id and tenant_id = v_run.tenant_id;
  if not found then
    raise exception 'TEMPLATE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_template.is_active = false then
    raise exception 'TEMPLATE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 医院档案:医院名称取租户名;电话/地址取门店档案(活动定向门店优先,其次客户所属门店)
  select * into v_tenant from public.tenants where id = v_run.tenant_id;
  v_tenant_name := coalesce(v_tenant.name, '');

  v_scene := case when v_campaign.type = 'birthday' then 'birthday' else 'marketing' end;
  v_channel := v_campaign.channel;

  -- 逐客户生成投递
  for v_aud in
    select * from public.marketing_campaign_audiences
    where tenant_id = v_run.tenant_id and campaign_id = v_campaign.id
    order by matched_at
  loop
    -- 客户档案(仅 active;非 active 客户不发营销)
    select * into v_customer
    from public.customers
    where id = v_aud.customer_id and tenant_id = v_run.tenant_id and status = 'active';
    if not found then
      continue;
    end if;

    -- 收件人按渠道解析
    v_recipient := '';
    if v_channel = 'email' then
      v_recipient := coalesce(v_customer.email, '');
    elsif v_channel in ('sms', 'wechat', 'work_wechat') then
      -- 短信渠道用手机号;微信渠道无 openid 档案,跳过
      if v_channel = 'sms' then
        v_recipient := coalesce(v_customer.phone, '');
      end if;
    end if;
    if v_recipient = '' then
      continue;
    end if;

    -- 门店档案(活动定向门店优先,其次客户所属门店;未命中时档案字段保持空串)
    v_store_name := '';
    v_store_phone := '';
    v_store_address := '';
    select * into v_store
    from public.stores
    where id = coalesce(v_campaign.store_id, v_customer.store_id);
    if found then
      v_store_name := coalesce(v_store.name, '');
      v_store_phone := coalesce(v_store.phone, '');
      v_store_address := coalesce(v_store.address, '');
    end if;

    -- 宠物档案(取客户最近一条)
    v_pet_name := '';
    v_pet_species := '';
    select * into v_pet
    from public.pets
    where customer_id = v_customer.id
    order by created_at desc
    limit 1;
    if found then
      v_pet_name := coalesce(v_pet.name, '');
      v_pet_species := coalesce(v_pet.species, '');
    end if;

    -- 渲染内容快照(白名单变量替换,与 template-engine.ts 白名单对齐)
    v_content := v_template.body;
    v_content := replace(v_content, '{{customer.name}}', coalesce(v_customer.name, ''));
    v_content := replace(v_content, '{{customer.phone}}', coalesce(v_customer.phone, ''));
    v_content := replace(v_content, '{{pet.name}}', v_pet_name);
    v_content := replace(v_content, '{{pet.species}}', v_pet_species);
    v_content := replace(v_content, '{{store.name}}', v_store_name);
    v_content := replace(v_content, '{{store.phone}}', v_store_phone);
    v_content := replace(v_content, '{{store.address}}', v_store_address);
    v_content := replace(v_content, '{{hospital.name}}', v_tenant_name);
    v_content := replace(v_content, '{{hospital.phone}}', v_store_phone);
    v_content := replace(v_content, '{{hospital.address}}', v_store_address);
    -- 残留占位符清空(如 appointment.* / order.total 等无数据来源的变量)
    v_content := regexp_replace(v_content, '\{\{\s*[\w.]+\s*\}\}', '', 'g');

    v_subject := null;
    if v_template.subject is not null then
      v_subject := v_template.subject;
      v_subject := replace(v_subject, '{{customer.name}}', coalesce(v_customer.name, ''));
      v_subject := replace(v_subject, '{{pet.name}}', v_pet_name);
      v_subject := regexp_replace(v_subject, '\{\{\s*[\w.]+\s*\}\}', '', 'g');
    end if;

    -- 创建 queued 投递(幂等:同一活动/批次/收件人冲突时跳过)
    insert into public.message_deliveries (
      tenant_id, store_id, scene, campaign_id, run_no, template_id,
      channel, recipient, content_snapshot, subject_snapshot, status
    ) values (
      v_run.tenant_id,
      coalesce(v_campaign.store_id, v_customer.store_id),
      v_scene, v_campaign.id, v_run.run_no, v_template.id,
      v_channel, v_recipient, v_content, v_subject, 'queued'
    )
    on conflict (campaign_id, run_no, recipient) where campaign_id is not null and run_no is not null
    do nothing;

    if found then
      v_count := v_count + 1;
    end if;
  end loop;

  -- 回填 run 投递数
  update public.marketing_campaign_runs
  set dispatch_count = v_count,
      status = 'completed',
      completed_at = now()
  where id = p_run_id;

  return jsonb_build_object(
    'run_id', p_run_id,
    'campaign_id', v_campaign.id,
    'run_no', v_run.run_no,
    'dispatch_count', v_count,
    'audience_count', v_run.audience_count,
    'template_code', v_template.code,
    'idempotent', false
  );
end;
$$;

-- ===== 3. 高危 RPC ACL:仅 service_role =====
revoke all on function public.dispatch_campaign_run(uuid) from public;
revoke all on function public.dispatch_campaign_run(uuid) from anon;
revoke all on function public.dispatch_campaign_run(uuid) from authenticated;
grant execute on function public.dispatch_campaign_run(uuid) to service_role;
