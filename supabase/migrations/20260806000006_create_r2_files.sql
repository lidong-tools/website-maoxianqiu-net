-- ============================================================
-- 20260806000006_create_r2_files.sql
-- 追踪 R2 存储记录(复刻自 LTX-Dev)
-- 写入由后端 service role(绕过 RLS)完成;用户可读自己的文件
-- ============================================================

create table if not exists public.r2_files (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  url text not null,
  content_type text,
  size integer,
  user_id uuid references auth.users(id) on delete set null,
  user_email text,
  source text,
  source_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_r2_files_user_id on public.r2_files(user_id);
create index if not exists idx_r2_files_user_email on public.r2_files(user_email);
create index if not exists idx_r2_files_source on public.r2_files(source);
create index if not exists idx_r2_files_created_at on public.r2_files(created_at desc);

alter table public.r2_files enable row level security;

create policy "r2_files_read_own" on public.r2_files
  for select using (auth.uid() = user_id);
