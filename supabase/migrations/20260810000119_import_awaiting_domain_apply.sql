-- ============================================================
-- S32-A FIX v2: Import 准确终态(awaiting_domain_apply)
-- ------------------------------------------------------------
-- 审计问题(S3.2-Fix-Reaudit-v2 §10/§11):
--   employee / opening-stock 两类导入只生成"待邀请/期初入账命令"
--   (employee_invite_imports / opening_stock_import_requests,status=pending),
--   真实业务落地(IAM 邀请 / 库存期初入账)由 S32-E Integrator 消费。
--   原实现把这类任务直接置为 completed,暗示"业务数据已完成导入",不准确。
--
-- 修复:
--   1. import_jobs.status 新增 awaiting_domain_apply(业务命令已生成、等待领域应用);
--   2. employee / opening-stock 导入执行成功后终态为 awaiting_domain_apply,
--      completed 仅用于业务数据已直接落地的类型(customer/pet/catalog-item)。
-- 自包含幂等,可重复应用。
-- ============================================================
set search_path = public;

alter table public.import_jobs drop constraint if exists import_jobs_status_check;
alter table public.import_jobs
  add constraint import_jobs_status_check check (
    status in ('uploaded', 'mapped', 'validated', 'queued', 'pending', 'processing', 'completed', 'failed', 'cancelled', 'awaiting_domain_apply')
  );

comment on column public.import_jobs.status is
  '导入任务状态:uploaded/mapped/validated 为向导阶段,processing 为执行中;'
  'awaiting_domain_apply=业务命令已生成、等待领域应用(employee/opening-stock);'
  'completed=业务数据已直接落地(customer/pet/catalog-item);failed/cancelled 为异常终态。';
