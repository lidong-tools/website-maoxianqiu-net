-- ============================================================
-- 20260810000092_rpc_acl_final_lockdown.sql
-- Agent-07 二轮收口(P0-01):RPC ACL 最终锁定
--
-- 背景:多 Agent 并发期,部分 Feature Migration 重新开放了敏感 Command RPC 的
--   authenticated EXECUTE(09055 create_invoice/confirm_invoice、09056 approve_discount/
--   review_record_amendment、57 preview/get_effective_membership_discount + create_invoice(boolean)、
--   73 boarding_prepare_checkout),导致 check:rpc-manifest 静态 PASS 不能代表最终 ACL。
--
-- 本迁移在全部 Feature Migration 之后执行,以 api/lib/service-rpc-manifest.ts
-- (116 个 service-role-only RPC)为唯一事实来源,统一:
--   REVOKE ALL FROM public/anon/authenticated
--   GRANT EXECUTE TO service_role
-- 另补 get_effective_membership_discount(SECURITY DEFINER,信任 tenant/store/customer 参数,
--   不在 manifest 但应禁止 authenticated 直连,避免跨业务边界读取会员折扣)。
-- 幂等:仅对已存在函数执行 revoke/grant,重复应用无害。
-- ============================================================

set search_path = public;

do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    'create_invoice',
    'confirm_invoice',
    'cancel_invoice',
    'approve_discount',
    'process_payment',
    'process_refund',
    'generate_receipt',
    'release_inventory_reservation',
    'transition_appointment',
    'sign_encounter',
    'revise_encounter',
    'save_prescription',
    'dispense_prescription',
    'confirm_inventory_reservation',
    'dispense_inventory',
    'create_customer',
    'update_customer',
    'archive_customer',
    'merge_customers',
    'create_import_job',
    'migrate_catalog_to_store',
    'invite_employee',
    'set_employee_status',
    'replace_role_permissions',
    'archive_store',
    'restore_store',
    'publish_lab_results',
    'review_lab_results',
    'issue_vaccine_certificate',
    'scan_diag_reminders',
    'publish_imaging_report',
    'create_upload_intent',
    'complete_upload',
    'archive_file',
    'admit_patient',
    'transfer_cage',
    'discharge_patient',
    'create_handover',
    'generate_daily_charges',
    'boarding_generate_no',
    'boarding_book_stay',
    'boarding_check_in',
    'boarding_cancel',
    'boarding_change_cage',
    'boarding_prepare_checkout',
    'boarding_checkout',
    'boarding_record_daily',
    'boarding_add_charge',
    'post_goods_receipt',
    'post_stock_count',
    'transfer_inventory',
    'reserve_inventory',
    'release_expired_reservations',
    'create_purchase_order',
    'update_purchase_order_draft',
    'submit_purchase_order',
    'approve_purchase_order',
    'cancel_purchase_order',
    'receive_purchase_order',
    'post_purchase_order',
    'adjust_points',
    'scan_reminders',
    'send_delivery',
    'create_import_task',
    'create_print_job',
    'generate_report_snapshot',
    'preview_membership_discount',
    'create_pet',
    'update_pet',
    'archive_pet',
    'archive_encounter',
    'archive_admission',
    'request_record_amendment',
    'review_record_amendment',
    'apply_record_amendment',
    'upsert_veterinarian_registration',
    'issue_prescription',
    'extend_prescription_validity',
    'save_institution_license',
    'change_license_status',
    'generate_regulatory_report',
    'submit_regulatory_report',
    'save_epidemic_event',
    'isolate_epidemic_event',
    'resolve_epidemic_event',
    'save_waste_record',
    'handover_waste',
    'close_daily_business',
    'adjust_daily_closing',
    'save_reconciliation_actual',
    'confirm_reconciliation',
    'get_payment_channel_summary',
    'initialize_tenant',
    'get_tenant_initialization',
    'suspend_tenant',
    'resume_tenant',
    'create_medical_order',
    'complete_nurse_task',
    'cancel_nurse_task',
    'fail_nurse_task',
    'cancel_medical_order',
    'scan_nurse_task_overdue',
    'create_lab_sample',
    'transition_lab_sample',
    'notify_critical_value',
    'ack_critical_value',
    'create_progress_note',
    'sign_progress_note',
    'link_medical_lab_ref',
    'prepare_settlement',
    'settle_admission',
    'waive_admission_charge',
    'finalize_settlement',
    'generate_customer_no',
    'generate_invoice_no',
    'update_import_job',
    'get_effective_membership_discount'
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
