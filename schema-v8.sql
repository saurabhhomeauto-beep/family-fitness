-- ============================================================
-- schema-v8.sql — Auto-create a profile row on signup (safety net)
-- ============================================================
--
-- WHY
--   The app creates the profiles row from client code right after
--   auth.signUp(). If that client call ever fails (RLS misconfig,
--   email-confirmation delaying the session, a dropped request), the
--   auth user is left with NO profile row — an "orphan" that then hits
--   406 (no profile) and 409 (user_settings FK points at a missing
--   profile) errors and can't finish onboarding.
--
--   This trigger makes the database itself create the profile the moment
--   an auth user is inserted, so a profile ALWAYS exists regardless of
--   what the client does. SECURITY DEFINER lets it write to
--   public.profiles without being blocked by RLS.
--
-- Safe to run once, after schema.sql … schema-v7.sql.
-- Idempotent: re-running replaces the function and re-creates the trigger.
-- ------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, role, onboarding_complete)
  values (
    new.id,
    -- Prefer a name passed via signUp options.data; otherwise fall back
    -- to the part of the email before "@". The client then upserts the
    -- real typed name over this (see app.js handleAuth).
    coalesce(
      nullif(new.raw_user_meta_data->>'display_name', ''),
      nullif(new.raw_user_meta_data->>'name', ''),
      split_part(new.email, '@', 1)
    ),
    'user',
    false
  )
  on conflict (id) do nothing;  -- never clobber an existing profile
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
