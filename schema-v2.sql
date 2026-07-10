-- ============================================================
-- schema-v2.sql  — Run this in Supabase SQL Editor
-- Adds: onboarding_complete, resting_calories, user_settings
-- ============================================================

-- 1. Add onboarding flag to profiles
alter table public.profiles
  add column if not exists onboarding_complete boolean default false;

-- 2. Add resting calories column to daily_logs
alter table public.daily_logs
  add column if not exists resting_calories integer default 0 check (resting_calories >= 0);

-- 3. User settings table (biometrics + goals from onboarding)
create table if not exists public.user_settings (
  user_id     uuid references public.profiles(id) on delete cascade primary key,
  age         integer check (age > 0 and age < 120),
  sex         text check (sex in ('male', 'female', 'other')),
  height_cm   float check (height_cm > 0),
  weight_kg   float check (weight_kg > 0),
  activity_level text check (activity_level in ('sedentary','light','moderate','active','very_active')),
  goal        text check (goal in ('lose','maintain','build')),
  dietary_notes text default '',
  bmr_kcal    integer default 0,
  tdee_kcal   integer default 0,
  updated_at  timestamp default now()
);

-- Enable RLS
alter table public.user_settings enable row level security;

-- Policy: users manage only their own settings
create policy "Users manage own settings"
  on public.user_settings for all
  using (auth.uid() = user_id);

-- Policy: admins can read all settings
create policy "Admins read all settings"
  on public.user_settings for select
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );
