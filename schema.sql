-- ============================================================
-- Family Fitness Hub — Supabase Schema
-- Run this in Supabase → SQL Editor
-- ============================================================

-- 1. Profiles Table (linked to Supabase Auth users)
create table public.profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  display_name text not null,
  role text default 'user' check (role in ('user', 'admin')),
  created_at timestamp default now()
);

-- 2. Daily Metrics Log
create table public.daily_logs (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  date date default current_date not null,
  steps integer default 0 check (steps >= 0),
  active_calories_burned integer default 0 check (active_calories_burned >= 0),
  water_ml integer default 0 check (water_ml >= 0),
  unique(user_id, date)
);

-- 3. Food Entries Log
create table public.food_entries (
  id uuid default gen_random_uuid() primary key,
  log_id uuid references public.daily_logs(id) on delete cascade not null,
  user_id uuid references public.profiles(id) on delete cascade not null,
  food_name text not null,
  calories integer not null check (calories >= 0),
  protein_g float default 0.0 check (protein_g >= 0.0),
  created_at timestamp default now()
);

-- ─── Enable Row-Level Security ──────────────────────────────
alter table public.profiles enable row level security;
alter table public.daily_logs enable row level security;
alter table public.food_entries enable row level security;

-- ─── RLS Policies ───────────────────────────────────────────

-- Profiles
create policy "Users manage their own profile"
  on public.profiles for all
  using (auth.uid() = id);

create policy "Admins read all profiles"
  on public.profiles for select
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );

-- Daily Logs
create policy "Users manage their own daily logs"
  on public.daily_logs for all
  using (auth.uid() = user_id);

create policy "Admins read all daily logs"
  on public.daily_logs for select
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );

-- Food Entries
create policy "Users manage their own food entries"
  on public.food_entries for all
  using (auth.uid() = user_id);

create policy "Admins read all food entries"
  on public.food_entries for select
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );

-- ─── Optional: auto-create profile on signup ────────────────
-- Uncomment if you want profiles created automatically via trigger:
--
-- create or replace function public.handle_new_user()
-- returns trigger language plpgsql security definer set search_path = public
-- as $$
-- begin
--   insert into public.profiles (id, display_name)
--   values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
--   return new;
-- end;
-- $$;
--
-- create trigger on_auth_user_created
--   after insert on auth.users
--   for each row execute procedure public.handle_new_user();
