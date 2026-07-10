-- ============================================================
-- schema-v6.sql  — Run this in Supabase SQL Editor
-- Adds: admin ability to update any profile (needed for the new
--       in-app Family Management screen), plus a trigger that
--       closes a pre-existing gap where any user could change
--       their own `role` column via a normal client-side update.
-- ============================================================

-- 1. Allow admins to update any profile row (e.g. promote/demote
--    another member's role). Without this, only the "Users manage
--    their own profile" policy applies, which limits updates to
--    your own row only.
create policy "Admins update all profiles"
  on public.profiles for update
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );

-- 2. Column-level guard: block changes to `role` unless the caller
--    is currently an admin. RLS policies alone can't compare
--    old vs. new column values, so this is enforced with a trigger.
--    security definer lets it read profiles.role for the caller
--    without being blocked by RLS recursion.
create or replace function public.enforce_role_change_admin_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role then
    if not exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    ) then
      raise exception 'Only admins can change member roles.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_role_change_admin_only on public.profiles;

create trigger trg_enforce_role_change_admin_only
  before update on public.profiles
  for each row execute procedure public.enforce_role_change_admin_only();
