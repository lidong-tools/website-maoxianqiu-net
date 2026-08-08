-- ============================================================
-- S32-A FIX: 导入执行完整性(Import Execution Integrity, P0-C)
-- ------------------------------------------------------------
-- 审计问题(S3.2-Final-Full-Code-Audit #7~#11):
--   1. /imports/:id/start 无原子 validated→processing claim,
--      双击/超时重试可并发执行同一任务,造成重复副作用;
--   2. 执行阶段(DB 写入失败/领域错误)未持久化到 import_job_errors,
--      页面错误详情看不到执行期失败;
--   3. started_at/finished_at 在执行完成后一起写入,任务没有真实
--      processing 窗口,后台监控/取消语义不完整。
--
-- 修复:
--   1. import_jobs 新增 execution_key(请求幂等键),配合路由层原子
--      claim(UPDATE ... WHERE status IN 可执行态)保证单执行者;
--   2. import_job_errors 新增 stage 列(validate / execute),执行期
--      错误以 stage='execute' 持久化;
--   3. 时间语义:claim 时写 started_at,完成/失败时写 finished_at。
-- ============================================================

set search_path = public;

-- ===== 1. import_jobs:请求幂等键 =====
alter table public.import_jobs add column if not exists execution_key text;

comment on column public.import_jobs.execution_key is
  '执行请求幂等键(Idempotency-Key);相同键的重复 start 返回既有结果,防止双击/重试并发执行';

create index if not exists idx_import_jobs_execution_key
  on public.import_jobs (tenant_id, execution_key)
  where execution_key is not null;

-- ===== 2. import_job_errors:执行阶段标记 =====
alter table public.import_job_errors add column if not exists stage text not null default 'validate';

alter table public.import_job_errors
  drop constraint if exists import_job_errors_stage_check;
alter table public.import_job_errors
  add constraint import_job_errors_stage_check
  check (stage in ('validate', 'execute'));

comment on column public.import_job_errors.stage is
  '错误产生阶段:validate=校验期(前端可改后重验);execute=执行期(写入/领域错误)';
