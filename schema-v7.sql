-- ============================================================
-- schema-v7.sql — Fix RLS infinite recursion on admin policies
-- ============================================================
--
-- PROBLEM
--   Every "Admins read all …" policy checked admin status with:
--       exists (select 1 from public.profiles
--               where id = auth.uid() and role = 'admin')
--   Because the `profiles` table ALSO has an admin policy using that
--   same self-referencing subquery, Postgres re-applies the profiles
--   RLS policy while evaluating the profiles RLS policy → infinite
--   recursion (error 42P17). PostgREST surfaces this as HTTP 500 on
--   every table whose admin policy touches `profiles`.
--
-- FIX
--   Move the admin check into a SECURITY DEFINER function. Running as
--   the definer bypasses RLS on `profiles`, so there is no recursion.
--   Then recreate every admin policy to call that function.
--
-- Safe to run once, in order, after schema.sql … schema-v6.sql.
-- ------------------------------------------------------------

-- 1. Admin-check helper. SECURITY DEFINER = bypasses RLS (no recursion).
--    STABLE = result is constant within a single statement.
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- Allow the app's authenticated users to call it.
grant execute on function public.is_admin() to authenticated;

-- 2. Recreate every recursive admin policy using is_admin().

-- profiles ----------------------------------------------------
drop policy if exists "Admins read all profiles" on public.profiles;
create policy "Admins read all profiles"
  on public.profiles for select
  using ( public.is_admin() );

drop policy if exists "Admins update all profiles" on public.profiles;
create policy "Admins update all profiles"
  on public.profiles for update
  using ( public.is_admin() );

-- daily_logs --------------------------------------------------
drop policy if exists "Admins read all daily logs" on public.daily_logs;
create policy "Admins read all daily logs"
  on public.daily_logs for select
  using ( public.is_admin() );

-- food_entries ------------------------------------------------
drop policy if exists "Admins read all food entries" on public.food_entries;
create policy "Admins read all food entries"
  on public.food_entries for select
  using ( public.is_admin() );

-- user_settings -----------------------------------------------
drop policy if exists "Admins read all settings" on public.user_settings;
create policy "Admins read all settings"
  on public.user_settings for select
  using ( public.is_admin() );

-- saved_foods -------------------------------------------------
drop policy if exists "Admins read all saved foods" on public.saved_foods;
create policy "Admins read all saved foods"
  on public.saved_foods for select
  using ( public.is_admin() );

-- meals -------------------------------------------------------
drop policy if exists "Admins read all meals" on public.meals;
create policy "Admins read all meals"
  on public.meals for select
  using ( public.is_admin() );

-- meal_items --------------------------------------------------
drop policy if exists "Admins read all meal items" on public.meal_items;
create policy "Admins read all meal items"
  on public.meal_items for select
  using ( public.is_admin() );

-- weight_logs -------------------------------------------------
drop policy if exists "Admins read all weight logs" on public.weight_logs;
create policy "Admins read all weight logs"
  on public.weight_logs for select
  using ( public.is_admin() );

-- 3. (Optional but tidy) point the role-change guard at is_admin() too,
--    so all admin checks share one definition. It was already SECURITY
--    DEFINER, so this is a consistency change, not a bug fix.
create or replace function public.enforce_role_change_admin_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role then
    if not public.is_admin() then
      raise exception 'Only admins can change member roles.';
    end if;
  end if;
  return new;
end;
$$;
