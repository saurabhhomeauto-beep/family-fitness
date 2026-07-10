-- ============================================================
-- schema-v3.sql  — Run this in Supabase SQL Editor
-- Adds: full macro tracking (carbs_g, fat_g) on food_entries,
--       saved_foods (quick re-log library),
--       meals + meal_items (named food groups for one-tap re-log)
-- ============================================================

-- 1. Full macro tracking on food_entries
alter table public.food_entries
  add column if not exists carbs_g float default 0.0 check (carbs_g >= 0.0);

alter table public.food_entries
  add column if not exists fat_g float default 0.0 check (fat_g >= 0.0);

-- 2. Saved foods (user's personal library of foods for one-tap re-log)
create table if not exists public.saved_foods (
  id          uuid default gen_random_uuid() primary key,
  user_id     uuid references public.profiles(id) on delete cascade not null,
  food_name   text not null,
  calories    integer not null default 0 check (calories >= 0),
  protein_g   float default 0.0 check (protein_g >= 0.0),
  carbs_g     float default 0.0 check (carbs_g >= 0.0),
  fat_g       float default 0.0 check (fat_g >= 0.0),
  created_at  timestamp default now(),
  unique(user_id, food_name)
);

alter table public.saved_foods enable row level security;

create policy "Users manage their own saved foods"
  on public.saved_foods for all
  using (auth.uid() = user_id);

create policy "Admins read all saved foods"
  on public.saved_foods for select
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );

-- 3. Meals (a named group of foods, e.g. "My usual breakfast")
create table if not exists public.meals (
  id          uuid default gen_random_uuid() primary key,
  user_id     uuid references public.profiles(id) on delete cascade not null,
  name        text not null,
  created_at  timestamp default now()
);

alter table public.meals enable row level security;

create policy "Users manage their own meals"
  on public.meals for all
  using (auth.uid() = user_id);

create policy "Admins read all meals"
  on public.meals for select
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );

-- 4. Meal items (the individual foods that make up a meal)
create table if not exists public.meal_items (
  id          uuid default gen_random_uuid() primary key,
  meal_id     uuid references public.meals(id) on delete cascade not null,
  user_id     uuid references public.profiles(id) on delete cascade not null,
  food_name   text not null,
  calories    integer not null default 0 check (calories >= 0),
  protein_g   float default 0.0 check (protein_g >= 0.0),
  carbs_g     float default 0.0 check (carbs_g >= 0.0),
  fat_g       float default 0.0 check (fat_g >= 0.0)
);

alter table public.meal_items enable row level security;

create policy "Users manage their own meal items"
  on public.meal_items for all
  using (auth.uid() = user_id);

create policy "Admins read all meal items"
  on public.meal_items for select
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );
