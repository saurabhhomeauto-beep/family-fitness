# Build Prompts — Family Fitness Hub Roadmap

A sequenced set of prompts to hand to Claude in Cowork to build out the roadmap in `PRODUCT-ROADMAP.md`.

**How to use this**
- Run prompts **in order** — later ones assume earlier schema/features exist.
- Run **one prompt per session/turn**, then test before moving on.
- Each prompt is self-contained (safe to paste into a fresh session).
- Prompts that change the database include a Supabase migration — apply it in **Supabase → SQL Editor** before/after deploying, as the prompt states.
- Golden rules to repeat if the model drifts: **stay $0/month (free tiers only)**, **keep AI calls on-demand** (Gemini free-tier limits), **match the existing vanilla-JS + Tailwind + Supabase + Netlify architecture**, and **don't break Row-Level Security**.

---

## Prompt 0 — Prime the context (run once at the start of a build session)

```
You're working in my local project "family-fitness-v3", a zero-cost family fitness PWA.
Stack: vanilla JS ES modules (js/app.js), Tailwind, Supabase (Postgres + RLS), Netlify
serverless functions (netlify/functions/analyze.js, chat.js) proxying Gemini 2.0 Flash.

Before doing anything, read: README.md, js/app.js, js/config.js, schema.sql, schema-v2.sql,
and the netlify/functions files. Summarize back to me the current data model and the main
app flows (auth, onboarding, today tab, food/fitness logging, history, chat, admin view) so
I can confirm you understand it. Do NOT change any code yet.

Hard constraints for everything that follows:
- Must stay $0/month — free tiers only. No paid APIs, no paid hardware.
- Keep the existing architecture and code style (vanilla JS, Tailwind classes, Supabase client).
- Never weaken Row-Level Security. Any new table gets RLS policies matching the existing pattern
  (users manage own rows; admins can read all).
- Keep AI calls on-demand to respect Gemini free-tier rate limits.
- Deliver DB changes as a new numbered migration file (e.g. schema-v3.sql) I run in Supabase SQL Editor.
```

---

## NOW — remove daily friction

### Prompt 1 — Manual entry & edit everywhere

```
Feature: manual entry and editing, so the app is usable without a screenshot.

1. On the Today tab, add manual inputs to set/adjust steps, active calories, resting calories,
   and water (in addition to the existing screenshot upload and water quick-add buttons).
2. Make food entries editable, not just deletable — let me tap an entry to edit its name,
   calories, and macros, then save.
3. Add a plain "add food manually" path (name + calories + macros) that doesn't call the AI.

Keep AI logging as the fast path and manual as the fallback. Reuse existing confirmModal / toast
patterns. Update js/app.js only unless a schema change is truly needed. Show me a diff summary when done.
```

### Prompt 2 — Saved foods, recents & meals (biggest retention lever)

```
Feature: stop re-analyzing the same foods. Add re-logging.

1. Migration (schema-v3.sql): create `saved_foods` (user_id, food_name, calories, protein_g,
   carbs_g, fat_g) and `meals` (a named group of foods). Add RLS policies matching the existing
   pattern (users manage own; admins read all).
2. After the AI analyzes a food, offer a "Save" action to store it in saved_foods.
3. On the Log Food card, add a search box that shows: my saved foods, my recent foods (from
   food_entries history), and lets me re-log any of them in one tap without calling the AI.
4. Also let me save a set of today's foods as a named "meal" and re-log the whole meal later.

Zero-cost only. Give me the schema-v3.sql to run in Supabase, then the app.js changes.
```

### Prompt 3 — Full macros (carbs + fat)

```
Feature: track full macros, not just protein.

1. Migration: add `carbs_g` and `fat_g` (float, default 0, >= 0 checks) to food_entries.
2. Update netlify/functions/analyze.js Gemini prompt for food so it returns carbs_g and fat_g
   alongside calories and protein_g, in the same JSON array shape.
3. Update the food confirm modal and the Today tab to show a macro breakdown
   (protein / carbs / fat) and daily totals.

Keep the response schema backward-compatible (missing macro = 0). Deliver migration + code changes.
```

### Prompt 4 — In-app editable goals/targets

```
Feature: personalize targets in-app instead of editing config.js.

1. Migration: add target columns to user_settings — target_steps, target_active_kcal,
   target_water_ml, and target_intake_kcal (daily calorie budget).
2. On finishing onboarding, seed these: steps/active/water from the current config.js defaults,
   and target_intake_kcal from TDEE adjusted by goal (lose = TDEE-500, build = TDEE+300,
   maintain = TDEE) — the onboarding already computes this number, just persist it.
3. Add a Settings screen where users can edit all four targets.
4. Make the Today tab read targets from user_settings (fall back to config.js TARGETS if null),
   and surface the daily calorie-intake target in the energy-balance card.

Deliver migration + code changes.
```

### Prompt 5 — Editable profile (keep BMR/TDEE fresh)

```
Feature: edit profile after onboarding so BMR/TDEE don't go stale.

Add to the Settings screen the ability to update age, sex, height, weight, activity level, goal,
and dietary notes. On save, recompute bmr_kcal and tdee_kcal using the existing calculateBMR /
calculateTDEE functions and upsert to user_settings. Reflect changes immediately on the Today tab.
Reuse existing form styling. js/app.js changes; no schema change needed.
```

---

## NEXT — depth, retention & the food win

### Prompt 6 — Weight log + trend chart

```
Feature: track weight over time (currently captured once at onboarding and never again).

1. Migration: create `weight_logs` (id, user_id, date, weight_kg, created_at) with RLS matching
   the existing pattern; one entry per user per date (unique constraint).
2. Add a quick "log weight" action (defaults to today).
3. Show a weight line chart with a 7-day moving average. Load Chart.js from the Cloudflare CDN
   (https://cdnjs.cloudflare.com) — no bundler. Put the chart on the History tab or a Progress view.

Zero-cost only. Deliver migration + code changes.
```

### Prompt 7 — Trends & charts (30/90 day)

```
Feature: real trends beyond the current 7-day list.

On the History/Progress view, add a range selector (7 / 30 / 90 days) and Chart.js line charts for:
steps, calories in vs out, and net balance. Reuse the Chart.js include from the weight feature.
Query daily_logs and food_entries efficiently (aggregate per day; avoid N+1 fetches). Keep it fast
and mobile-friendly. js/app.js changes.
```

### Prompt 8 — Barcode scanning (free, via Open Food Facts)

```
Feature: barcode scanning for packaged foods — kept FREE (MyFitnessPal charges for this).

1. Add a "Scan barcode" button on the Log Food card that opens the device camera.
2. Decode the barcode client-side (use a lightweight scanner lib from a CDN, e.g. a
   ZXing/quagga-style library — pick one loadable from cdnjs, no build step).
3. Look up the product via the free Open Food Facts API
   (https://world.openfoodfacts.org/api/v2/product/<barcode>.json) and prefill food_name +
   calories + macros into the food confirm modal for me to save.
4. Gracefully handle "not found" by falling back to manual entry.

No paid services. Handle camera-permission denial cleanly. Deliver code changes.
```

### Prompt 9 — Streaks & gentle gamification

```
Feature: reward consistency to drive retention — but keep it encouraging, never punitive.

Compute and display: a current logging streak (consecutive days with any log), a longest streak,
and simple goal-hit badges (e.g. hit step goal, hit water goal, logged all meals). Derive streaks
from existing daily_logs/food_entries dates — add a lightweight cache column or table only if needed
for performance. Show a small streak indicator on the Today header and a badges strip.

Wellbeing rule: no shame, no loss-aversion pressure, no punishing broken streaks — framing stays
positive and optional. Deliver code (and migration only if truly required).
```

---

## LATER — lean into the family moat & polish

### Prompt 10 — Family challenges & leaderboard

```
Feature: make the family view interactive — this is our differentiator (competitors are personal-first).

1. Migration: create `challenges` (family/group weekly goal: type = steps|water|active_kcal, target,
   start_date, end_date) and `challenge_participants` progress, plus a simple `cheers` table for
   reactions between members. RLS: members read family data, manage their own participation.
2. In the Family Overview, add: a shared weekly challenge with per-member progress bars, an opt-in
   leaderboard, a family streak, and lightweight "cheer" reactions on each member's card.

Since this is a private family app, define "family" as all profiles in the same Supabase project
(keep it simple) unless we already have a family/group id — confirm with me before designing the
grouping. Zero-cost only. Propose the schema first, then build after I approve.
```

### Prompt 11 — In-app family management

```
Feature: manage members without editing the database.

Add an admin-only Settings section to: invite a member (share a signup link / instructions),
view all members, and promote/demote admin role (update profiles.role) from the UI instead of the
Supabase table editor. Respect RLS — only admins can change roles. js/app.js + policies if needed.
```

### Prompt 12 — Reminders via Web Push

```
Feature: opt-in reminders to log meals/water.

Implement Web Push using VAPID (free): generate/store a VAPID keypair as Netlify env vars, add a
subscription flow, store subscriptions in a `push_subscriptions` table (RLS), and a scheduled
Netlify function to send opt-in nudges. Update sw.js to handle push + notificationclick.

Be explicit in the UI about limitations: iOS only supports this when the PWA is installed to the
home screen. Keep reminders fully opt-in and easy to turn off. No paid push service. Propose the
approach first, then build.
```

### Prompt 13 — Data export + password reset

```
Two small trust/ownership wins:

1. Add a "Export my data (CSV)" button in Settings that downloads the user's daily_logs,
   food_entries, and weight_logs as CSV, generated client-side.
2. Add a "Forgot password?" flow on the auth screen using supabase.auth.resetPasswordForEmail,
   plus the reset-handling view. Match existing auth styling.

js/app.js changes; no paid services.
```

### Prompt 14 — Sleep, simple workouts & on-demand AI meal ideas (build on demand)

```
Only build these once the earlier tiers are stable and there's demand.

1. Sleep: add an optional sleep-hours field to daily_logs (migration) and let users log it manually
   or extract it from the health-app screenshot (extend analyze.js fitness prompt).
2. Workouts: allow logging a workout (type, duration, est. calories) that feeds active calories.
3. AI meal ideas: a Settings/Coach action that generates a goal- and diet-aware meal suggestion via
   Gemini — ON DEMAND only (one call per tap), never background, to protect the free-tier quota.

Zero-cost only. Deliver migrations + code. Keep each of the three as a separately testable change.
```

---

## Not to be built (out of scope — breaks $0 or focus)

Native Apple Health / Google Fit / Health Connect sync (keep the screenshot path as the deliberate
zero-cost substitute), human coaching, connected hardware (smart scale / CGM), and any always-on
background AI analysis.
