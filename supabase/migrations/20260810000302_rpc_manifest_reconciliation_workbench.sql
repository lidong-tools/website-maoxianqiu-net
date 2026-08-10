-- ============================================================
-- 20260810000302_rpc_manifest_reconciliation_workbench.sql
-- Stage-04 岗位与医生工作台收尾:RPC 权限一致性(service-role-only)
--
-- 背景:
--   * 岗位工作台/患者旅程路由(patient-journey.ts)使用的 9 个业务 RPC
--     此前未登记 manifest、也未执行 revoke/grant;
--     commit_clinical_plan 的 revoke/grant 已在 migration 301 内完成,
--     本迁移处理其余 8 个。
--   * Agent-06/05/08 新增的保险/营销/门户 RPC 虽已登记 manifest,
--     但未落入 migrations 的 revoke 清单 → check:rpc-manifest 规则2 失败。
-- 本迁移统一收紧为 S30-F02 约定:
--   revoke public / anon / authenticated + grant service_role。
-- 函数名以单引号数组出现,同时满足 check:rpc-manifest 规则2(revoke 清单存在性)。
-- 幂等:仅对已存在的函数执行 revoke/grant,重复应用无害。
-- ============================================================

do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    -- 岗位工作台 / 患者旅程(Stage-04,migration 301 起;commit_clinical_plan 已在 301 授权,此处仅登记清单)
    'commit_clinical_plan',
    'check_in_clinical_patient',
    'record_clinical_triage',
    'transition_clinical_queue',
    'transition_workflow_task',
    'upsert_encounter_charge_item',
    'void_encounter_charge_item',
    'create_invoice_from_pending_charges',
    'transition_encounter_clinical_status',
    -- 保险理赔 / 签名(Stage-04 Agent-06,migration 235)
    'create_insurance_claim_pack',
    'update_insurance_claim_pack_items',
    'transition_insurance_claim_pack',
    'create_insurance_claim_export',
    'create_signature_request',
    'transition_signature_request',
    'record_signature_event',
    -- CRM 增长 / 营销(Stage-04 Agent-05,migration 220~223)
    'customer_profile_snapshot',
    'evaluate_customer_segments',
    'compute_customer_churn',
    'refresh_segment_memberships',
    'refresh_churn_scores',
    'gen_coupon_code',
    'issue_coupons',
    'preview_coupon_discount',
    'redeem_coupon',
    'cancel_coupon_issue',
    'purchase_package',
    'redeem_package',
    'reverse_package_redemption',
    'refund_package',
    'generate_referral_code',
    'register_referral',
    'publish_campaign',
    -- 客户门户(Stage-04 Agent-08,migration 265~267)
    'portal_create_otp_challenge',
    'portal_verify_otp',
    'create_portal_appointment',
    'apply_provider_event'
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
