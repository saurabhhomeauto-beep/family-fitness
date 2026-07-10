# Family Fitness Hub — Deployment Guide

A complete, zero-cost deployment walkthrough for the Family Fitness Hub PWA.

**Stack being deployed**

| Layer | Technology | Where it runs |
|---|---|---|
| Frontend | Vanilla JS (ES modules) + Tailwind (built at deploy) | Netlify CDN |
| PWA | `manifest.json` + `sw.js` | User's device |
| Serverless API | Netlify Functions (`analyze.js`, `chat.js`) | Netlify |
| Database + Auth | Supabase (Postgres + Row-Level Security) | Supabase |
| AI | Gemini 2.0 Flash (`gemini-2.0-flash`) | Google, via the Netlify proxy |

**Total cost:** $0/month on free tiers for typical family use.

---

## 0. Prerequisites

Create free accounts (no credit card needed) on:

1. **GitHub** — to host the code Netlify deploys from — <https://github.com>
2. **Supabase** — database + auth — <https://supabase.com>
3. **Netlify** — hosting + serverless functions — <https://netlify.com>
4. **Google AI Studio** — Gemini API key — <https://aistudio.google.com>

You also need **Git** installed locally, and (optional, for local preview) **Node.js 18+**.

> Time to first deploy: ~20–30 minutes.

---

## 1. Set up Supabase (database + auth)

### 1.1 Create the project
1. Go to <https://supabase.com> → **New project**.
2. Give it a name and a strong database password (save it). Pick the region closest to your family.
3. Wait for provisioning to finish (~2 minutes).

### 1.2 Run the database migrations — **in this exact order**
Open **SQL Editor** in the Supabase dashboard, then paste and **Run** each file's contents one at a time, top to bottom. Order matters: later migrations depend on earlier tables/columns.

| # | File | What it creates |
|---|---|---|
| 1 | `schema.sql` | Core tables: `profiles`, `daily_logs`, `food_entries` + RLS policies |
| 2 | `schema-v2.sql` | `onboarding_complete`, `resting_calories`, `user_settings` |
| 3 | `schema-v3.sql` | Macros (`carbs_g`, `fat_g`) + `saved_foods`, `meals`, `meal_items` |
| 4 | `schema-v4.sql` | Personalized daily targets on `user_settings` |
| 5 | `schema-v5.sql` | `weight_logs` (weight-over-time tracking) |
| 6 | `schema-v6.sql` | Admin-update policy + role-change guard trigger |

> These migrations are idempotent-friendly (`if not exists` / `add column if not exists`), so re-running a file is safe. Still, run them in order the first time.

### 1.3 Configure auth for a private family app
1. **Authentication → Providers → Email**: for a small private app you may **disable "Confirm email"** so members can sign in immediately. (Leave it on if you prefer email verification.)
2. Nothing else is required — the app uses email/password auth.

### 1.4 Copy your API credentials
Go to **Project Settings → API** and copy:
- **Project URL** (e.g. `https://abcdefghijklmnop.supabase.co`)
- **anon / public key** (a long JWT starting with `eyJ...`)

You'll paste these into `js/config.js` in the next step.

> **Security note:** the anon key is *designed* to be public and shipped in client code — Row-Level Security is what protects your data. Never expose the **service_role** key, and never put the Gemini key in client code (it goes in a Netlify env var instead — see Step 4).

---

## 2. Get a Gemini API key

1. Go to <https://aistudio.google.com> → **Get API key** → create a key.
2. Copy it and keep it secret. **Do not** paste it into any file in the repo — it will be set as a Netlify environment variable in Step 4.

---

## 3. Configure the app

Open `js/config.js` and replace the two placeholders with your Supabase values from Step 1.4:

```js
export const SUPABASE_URL      = 'https://YOUR_PROJECT_ID.supabase.co'  // ← Project URL
export const SUPABASE_ANON_KEY = 'eyJhbGci...'                          // ← anon public key
```

Optionally adjust the default daily targets (these are fallbacks; users can also set their own in-app under Settings):

```js
export const TARGETS = {
  steps:            10_000,
  water_ml:          2_000,
  active_calories:     500,
}
```

If the placeholders are left in, the app shows a clear "Supabase not configured" screen instead of loading — a useful sanity check.

---

## 4. Deploy to Netlify

### 4.1 Push the code to GitHub
```bash
cd family-fitness-v3
git init            # if not already a repo
git add .
git commit -m "Deploy Family Fitness Hub"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

> The `duplicate/` folder is an archived older draft and is safe to delete before pushing.

### 4.2 Create the Netlify site
1. Netlify → **Add new site → Import an existing project** → connect GitHub → pick your repo.
2. **Build settings are read automatically from `netlify.toml`** — no manual entry needed:
   - Build command: `npm install && npx tailwindcss -i css/input.css -o css/tailwind.css --minify`
   - Publish directory: `.`
   - Functions directory: `netlify/functions`
3. Before the first deploy finishes, add the AI key: **Site settings → Environment variables → Add a variable**:
   - **Key:** `GEMINI_API_KEY`
   - **Value:** *(your Gemini key from Step 2)*
4. Trigger a deploy (**Deploys → Trigger deploy → Deploy site**) so the function picks up the new env var.

When the deploy is green, open the live URL (e.g. `https://your-site.netlify.app`).

---

## 5. Create family profiles & the first admin

1. Open the live URL and **Sign up** with each family member's email + a display name.
2. Each member completes the 5-step onboarding (biometrics, activity, goal, diet, and computed BMR/TDEE).
3. **Promote one person to admin** so they get the Family Overview and member management:
   - Supabase → **Table Editor → `profiles`** → set that person's `role` to `admin`.
   - After that, admins can promote/demote others in-app under **Settings → Family Management** (a v6 trigger enforces that only admins can change roles).

---

## 6. Install as a PWA (optional but recommended)

- **iOS (Safari):** open the site → Share → **Add to Home Screen**. *(Required on iOS for standalone/app-like behavior.)*
- **Android (Chrome):** menu → **Install app / Add to Home Screen**.
- **Desktop (Chrome/Edge):** install icon in the address bar.

---

## 7. Post-deploy smoke test

Run through this checklist once against the live site to confirm every layer is wired up:

- [ ] Home page loads (no "Supabase not configured" screen) → **config.js is correct**.
- [ ] Sign up a test user → lands in onboarding → completes → reaches the Today dashboard → **Supabase auth + tables work**.
- [ ] Today tab shows activity rings, energy balance, and macro breakdown.
- [ ] Log food by **text** (e.g. "one banana") → confirm modal shows items with calories + macros → **`GEMINI_API_KEY` + `analyze` function work**.
- [ ] Upload a health-app **screenshot** → metrics extracted.
- [ ] **AI Coach** chat returns a reply → **`chat` function works**.
- [ ] Log weight and view the trend chart; open **History** and switch 7/30/90-day ranges → **Chart.js + `weight_logs` work**.
- [ ] Open **Settings** → edit targets and profile → values persist.
- [ ] As admin, open **Family Overview** and **Family Management**.
- [ ] Export data to CSV; test **Forgot password** on the sign-in screen.
- [ ] Add to Home Screen and confirm it opens standalone.

If a function step fails, check **Netlify → Functions → logs** and confirm `GEMINI_API_KEY` is set and you redeployed after adding it.

---

## 8. Updating & redeploying

- **Code changes** (e.g. the `js/app.js` onboarding fix): commit and `git push` — Netlify auto-builds and redeploys. The service worker (`sw.js`) is served `no-cache`, so clients pick up new versions on next load.
- **New database migration:** add the new `schema-vN.sql`, run it in Supabase **SQL Editor** (in order), *then* push any code that depends on it.
- **Rotating the Gemini key:** update the `GEMINI_API_KEY` env var in Netlify → trigger a redeploy.
- **Changing Supabase creds:** edit `js/config.js` → commit → push.

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Supabase not configured" screen | Placeholders still in `js/config.js` | Paste real Project URL + anon key, redeploy |
| Login works but no data / RLS errors | Migrations not all run, or run out of order | Re-run `schema.sql` → `v2` → … → `v6` in order |
| Food/screenshot analysis fails | `GEMINI_API_KEY` missing or set after deploy | Add env var, then **trigger a new deploy** |
| AI Coach returns connection error | Same as above, or Gemini free-tier rate limit hit | Check Netlify function logs; retry later |
| Styles look broken/unstyled | Tailwind didn't build | Confirm the `netlify.toml` build command ran (check deploy log) |
| Can't change a member's role | Not signed in as an admin | Promote via Supabase Table Editor first |
| iOS push/standalone quirks | iOS PWA limitations | Must be installed via Add to Home Screen |

---

## 10. Rollback

- **App/site:** Netlify → **Deploys** → pick a previous successful deploy → **Publish deploy**. Instant rollback, no rebuild.
- **Database:** migrations are additive, so a code rollback usually needs no DB change. Only write a reversing SQL script if a specific migration must be undone (rare).

---

## 11. Cost summary

| Service | Free tier | Typical family usage |
|---|---|---|
| Netlify | Starter (build minutes + bandwidth) | Comfortably within free |
| Supabase | 500 MB DB, 50k monthly active users | Far within free |
| Gemini API | Free tier with rate limits | Sufficient; keep AI calls on-demand |

**Total: $0/month** for a typical family. The main thing to watch is the Gemini free-tier rate limit if many members log via AI at once.
