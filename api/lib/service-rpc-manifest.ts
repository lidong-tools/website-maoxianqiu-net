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
 *   - 本 manifest 的每一个函数名必须出现在 migration 27(S30-F02 RPC 收紧)
 *     的 revoke 清单中,防止"手工维护高危 RPC 名单"与真实授权漂移。
 *
 * 新增业务 RPC 时必须:
 *   1) 在本文件追加函数名;
 *   2) 在 20260808000027_platform_admin_model.sql 的 revoke DO 块追加同名函数;
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
  // ---- 审计结论(S30-F02):仅服务端/内部辅助,无前端直连,撤销 authenticated ----
  'generate_customer_no',
  'generate_invoice_no',
  'update_import_job',
]

/** manifest 集合(去重后),供 CI 脚本 O(1) 判定 */
export const SERVICE_ROLE_ONLY_RPC_SET: ReadonlySet<string> = new Set(
  SERVICE_ROLE_ONLY_RPC,
)
