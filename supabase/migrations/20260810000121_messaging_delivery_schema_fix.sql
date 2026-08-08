-- ============================================================
-- S3.2 Final Fix: message_deliveries Schema 一致性(Messaging P0-A,Full12 §5/§6)
-- ------------------------------------------------------------
-- 审计问题(S3.2-Final-Source-Audit-Full12 §5):
--   1. 应用层 DeliveryRow 引用 message_deliveries.updated_at
--      (isStaleSending / Retry CAS stale 过滤),但既有 97 个 Migration
--      中该表只有 created_at,没有 updated_at → 真实查询直接失败;
--   2. stale sending 判断建议使用语义精确的 sending_claimed_at
--      (claim 成功时刻),而非通用 updated_at(§5 修复方案)。
--
-- 修复:
--   1. 增加 updated_at(not null default now()) + touch_updated_at
--      trigger(复用 migration 15 的函数),解决 Application Model ≠ DB Schema;
--   2. 增加 sending_claimed_at:应用层在 CAS claim 成功时显式写入,
--      isStaleSending / Retry CAS 优先使用它判断"陈旧发送"。
-- 自包含幂等,可重复应用。
-- ============================================================
set search_path = public;

-- ===== 1. updated_at(通用审计时间 + stale 兜底) =====
alter table public.message_deliveries
  add column if not exists updated_at timestamptz not null default now();

comment on column public.message_deliveries.updated_at is
  '投递记录最近更新时间;写入/claim 时由 touch_updated_at 触发器刷新,供 stale sending 兜底判断';

drop trigger if exists message_deliveries_touch_updated_at on public.message_deliveries;
create trigger message_deliveries_touch_updated_at
  before update on public.message_deliveries
  for each row execute procedure public.touch_updated_at();

-- ===== 2. sending_claimed_at(claim 成功时刻,语义精确) =====
alter table public.message_deliveries
  add column if not exists sending_claimed_at timestamptz;

comment on column public.message_deliveries.sending_claimed_at is
  '发送 claim 成功时刻(进入 sending 的时间);stale sending 回收以此为准,'
  '避免通用 updated_at 被后续状态写入污染';

-- 历史行回填:存量 sending 无真实 claim 时间,以 updated_at 兜底(仅存量,新行由应用写入)
update public.message_deliveries
  set sending_claimed_at = updated_at
  where status = 'sending' and sending_claimed_at is null;
