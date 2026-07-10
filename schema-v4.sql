-- ============================================================
-- schema-v4.sql  — Run this in Supabase SQL Editor
-- Adds: personalized daily targets on user_settings
--       (steps, active kcal, water, and calorie-intake budget)
-- ============================================================

-- Columns default to NULL so existing rows fall back to the
-- app's config.js TARGETS until a user (re)saves them via
-- onboarding or the new Settings screen.

alter table public.user_settings
  add column if not exists target_steps integer check (target_steps > 0);

alter table public.user_settings
  add column if not exists target_active_kcal integer check (target_active_kcal >= 0);

alter table public.user_settings
  add column if not exists target_water_ml integer check (target_water_ml >= 0);

alter table public.user_settings
  add column if not exists target_intake_kcal integer check (target_intake_kcal >= 0);
