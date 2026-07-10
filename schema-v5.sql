-- ============================================================
-- schema-v5.sql  — Run this in Supabase SQL Editor
-- Adds: weight_logs (one weight entry per user per day, so
--       body weight can be tracked over time / charted as a trend)
-- ============================================================

create table if not exists public.weight_logs (
  id          uuid default gen_random_uuid() primary key,
  user_id     uuid references public.profiles(id) on delete cascade not null,
  date        date not null,
  weight_kg   float not null check (weight_kg > 0),
  created_at  timestamp default now(),
  unique(user_id, date)
);

alter table public.weight_logs enable row level security;

create policy "Users manage their own weight logs"
  on public.weight_logs for all
  using (auth.uid() = user_id);

create policy "Admins read all weight logs"
  on public.weight_logs for select
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );
