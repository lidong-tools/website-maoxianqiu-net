-- ============================================================
-- 20260810000090_rpc_manifest_reconciliation.sql
-- Agent-07 集成修复(S3.1 收尾):RPC 权限一致性(service-role-only)
--
-- 背景:Agent-02/03/05 提交的新 RPC 使用了旧授权模式
--   (revoke ... from public + grant execute ... to authenticated),
--   且未登记进 api/lib/service-rpc-manifest.ts → check:rpc-manifest 规则1/2 双失败。
-- 本迁移在既有迁移之后运行,统一收紧为 S30-F02 约定:
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
    -- Agent-03 影像:报告发布
    'publish_imaging_report',
    -- Agent-05 采购:全生命周期
    'create_purchase_order', 'update_purchase_order_draft',
    'submit_purchase_order', 'approve_purchase_order',
    'cancel_purchase_order', 'receive_purchase_order', 'post_purchase_order',
    -- Agent-02 会员:定价预览
    'preview_membership_discount'
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
