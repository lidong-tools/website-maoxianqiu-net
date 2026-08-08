-- encounter 乐观锁版本号(Stage-03 UI 优化 P0)
-- 病历多人/多窗口编辑覆盖防护:更新携带 expectedVersion,不匹配返回 409
-- 修订流程(revise_encounter)已有 SELECT ... FOR UPDATE 行锁,此处补客户端版本令牌
alter table public.encounters
  add column if not exists version integer not null default 1;

comment on column public.encounters.version is '乐观锁版本号:每次更新 +1,客户端提交 expectedVersion 做并发冲突检测';
