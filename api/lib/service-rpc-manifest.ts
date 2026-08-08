/**
 * service-role-only RPC manifest(S30-F02)
 *
 * 单一定义源:全部"仅允许 service_role 执行"的 PostgreSQL 函数(RPC)。
 * 原则(默认拒绝):
 *   - revoke public / revoke anon / revoke authenticated
 *   - grant service_role
 *   - 不得依赖 SECURITY DEFINER + RLS 作为权限边界
 *
 * CI 静态规则(check:rpc-manifest):
 *   - api/routes 中 service.rpc('<fn>') 的每一个函数名必须属于本 manifest;
 *   - 本 manifest 的每一个函数名必须出现在 supabase/migrations/ 目录
 *     全部 .sql 文件的 revoke 清单(聚合单引号字符串)中,
 *     防止"手工维护高危 RPC 名单"与真实授权漂移。
 *
 * 新增业务 RPC 时必须:
 *   1) 在本文件追加函数名;
 *   2) 在对应 migration(禁止改动已交付 migration 01~27,S3.1 新 RPC 放新 migration)
 *      的 revoke DO 块追加同名函数;
 *   3) 否则 CI 静态校验失败。
 */
export const SERVICE_ROLE_ONLY_RPC: readonly string[] = [
  // ---- billing ----
  'create_invoice',
  'confirm_invoice',
  'cancel_invoice',
  'approve_discount',
  'process_payment',
  'process_refund',
  'generate_receipt',
  'release_inventory_reservation',
  // ---- clinical ----
  'transition_appointment',
  'sign_encounter',
  'revise_encounter',
  'save_prescription',
  'dispense_prescription',
  'confirm_inventory_reservation',
  'dispense_inventory',
  // ---- crm ----
  'create_customer',
  'update_customer',
  'archive_customer',
  'merge_customers',
  'create_import_job',
  // ---- catalog ----
  'migrate_catalog_to_store',
  // ---- iam(员工/角色/门店) ----
  'invite_employee',
  'set_employee_status',
  'replace_role_permissions',
  'archive_store',
  'restore_store',
  // ---- diagnostics ----
  'publish_lab_results',
  'review_lab_results',
  'issue_vaccine_certificate',
  'scan_diag_reminders',
  // ---- files ----
  'create_upload_intent',
  'complete_upload',
  'archive_file',
  // ---- inpatient ----
  'admit_patient',
  'transfer_cage',
  'discharge_patient',
  'create_handover',
  'generate_daily_charges',
  // ---- boarding(寄养,S3.1 Agent-06,migration 71~73) ----
  'boarding_generate_no',
  'boarding_book_stay',
  'boarding_check_in',
  'boarding_cancel',
  'boarding_change_cage',
  'boarding_prepare_checkout',
  'boarding_checkout',
  'boarding_record_daily',
  'boarding_add_charge',
  // ---- inventory ----
  'post_goods_receipt',
  'post_stock_count',
  'transfer_inventory',
  'reserve_inventory',
  'release_expired_reservations',
  // ---- operations ----
  'adjust_points',
  'scan_reminders',
  'send_delivery',
  'create_import_task',
  'create_print_job',
  'generate_report_snapshot',
  // ---- pets ----
  'create_pet',
  'update_pet',
  'archive_pet',
  // ---- compliance(S3.1-1 合规) ----
  'archive_encounter',
  'archive_admission',
  'request_record_amendment',
  'review_record_amendment',
  'apply_record_amendment',
  'upsert_veterinarian_registration',
  'issue_prescription',
  'extend_prescription_validity',
  // ---- regulatory(S3.1-PARALLEL-01 监管运营) ----
  'save_institution_license',
  'change_license_status',
  'generate_regulatory_report',
  'submit_regulatory_report',
  'save_epidemic_event',
  'isolate_epidemic_event',
  'resolve_epidemic_event',
  'save_waste_record',
  'handover_waste',
  // ---- daily closing & reconciliation(S31-PARALLEL-B 日结与对账) ----
  'close_daily_business',
  'adjust_daily_closing',
  'save_reconciliation_actual',
  'confirm_reconciliation',
  'get_payment_channel_summary',
  // ---- tenant init(S3.1-A 租户初始化) ----
  'initialize_tenant',
  'get_tenant_initialization',
  // ---- platform tenant mgmt(S3.1-PARALLEL-A 平台租户停用/恢复) ----
  'suspend_tenant',
  'resume_tenant',
  // ---- medical loop(S3.1-并发任务C 医疗闭环增强:migration 44~49) ----
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
  // ---- 审计结论(S30-F02):仅服务端/内部辅助,无前端直连,撤销 authenticated ----
  'generate_customer_no',
  'generate_invoice_no',
  'update_import_job',
]

/** manifest 集合(去重后),供 CI 脚本 O(1) 判定 */
export const SERVICE_ROLE_ONLY_RPC_SET: ReadonlySet<string> = new Set(
  SERVICE_ROLE_ONLY_RPC,
)
