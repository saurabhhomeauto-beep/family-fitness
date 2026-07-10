# Family Fitness Hub 🏃

A zero-cost Progressive Web App for tracking family fitness metrics and nutrition using AI.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JS (ES Modules), Tailwind CSS (built at deploy time) |
| PWA | manifest.json + Service Worker |
| Backend | Netlify Serverless Functions (Node.js) |
| Database & Auth | Supabase (PostgreSQL + RLS) |
| AI Engine | Gemini 2.0 Flash (via Netlify proxy) |

---

## Setup Guide

### Step 1 — Supabase Project

1. Create a free project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor** and run `schema.sql` first, then run `schema-v2.sql` (it's a migration that adds `onboarding_complete`, `resting_calories`, and the `user_settings` table — run it after, not instead of, `schema.sql`)
3. In **Authentication → Email**, disable "Confirm email" for a private family app
4. From **Project Settings → API**, copy your **Project URL** and **anon/public key**
5. Paste them into `js/config.js`:

```js
export const SUPABASE_URL = 'https://xxxxxxxxxxxx.supabase.co'
export const SUPABASE_ANON_KEY = 'eyJhbGci...'
```

### Step 2 — Gemini API Key

1. Visit [aistudio.google.com](https://aistudio.google.com) and create a free API key
2. Keep it secret — **do not put it in any JS file**

### Step 3 — Netlify Deployment

1. Push this project to a GitHub repository
2. Create a new site at [netlify.com](https://netlify.com) → "Import from Git"
3. Build settings are already defined in `netlify.toml` (build command, publish directory `.`, functions directory `netlify/functions`) — no manual changes needed
4. Go to **Site Settings → Environment Variables** and add:
   - Key: `GEMINI_API_KEY` | Value: _(your Gemini key)_
5. Deploy

### Step 4 — Create Family Profiles

1. Open your live Netlify URL on each device
2. Sign up with each family member's email
3. **To promote someone to Admin:** go to Supabase → Table Editor → `profiles` → change their `role` to `admin`

### Step 5 — Install as PWA

**iOS (Safari):** Open the site → Share button → "Add to Home Screen"  
**Android (Chrome):** Open the site → menu → "Add to Home Screen" or "Install App"

---

## Folder Structure

```
family-fitness-v3/
├── index.html                  # PWA shell
├── manifest.json               # PWA manifest
├── sw.js                       # Service Worker
├── netlify.toml                # Netlify config + redirects + build command
├── package.json                # Tailwind build script
├── tailwind.config.js          # Tailwind config
├── schema.sql                  # Supabase database schema (run first)
├── schema-v2.sql               # Supabase migration (run after schema.sql)
├── generate-icons.py           # Run once to generate app icons
├── css/
│   └── input.css               # Tailwind source (compiled to css/tailwind.css at build time)
├── icons/
│   ├── icon.png                # Apple touch icon (180×180)
│   ├── icon-192.png            # PWA icon
│   └── icon-512.png            # PWA icon (large)
├── js/
│   ├── config.js               # ⚠️ Add your Supabase credentials here
│   └── app.js                  # All app logic: routing, views, handlers
├── netlify/
│   └── functions/
│       ├── analyze.js          # Gemini AI proxy for fitness/food logging (uses GEMINI_API_KEY env var)
│       └── chat.js             # Gemini AI proxy for chat (uses GEMINI_API_KEY env var)
└── duplicate/                  # Archived older draft of this app — not used, safe to ignore/delete
```

---

## How It Works

### Fitness Screenshot Logging
1. Tap **Upload Health App Screenshot**
2. Select a screenshot from Apple Health, Google Fit, Samsung Health, etc.
3. Gemini reads the screenshot and extracts steps, active calories, and water
4. Review the results, then tap **Save Metrics**

### Food Logging
- **Photo:** Tap 📷 Photo, point camera at your meal — Gemini estimates every item
- **Text:** Tap ✏️ Text, describe what you ate — Gemini returns calorie & protein estimates

### Admin Dashboard
Admins can switch to a **Family Overview** that shows all members' today's metrics in one view.

---

## Daily Targets (configurable in `js/config.js`)

| Metric | Default Target |
|---|---|
| Steps | 10,000 |
| Active Calories | 500 kcal |
| Water | 2,000 ml |

---

## Costs

| Service | Cost |
|---|---|
| Netlify | Free (Starter plan) |
| Supabase | Free (500MB DB, 50k MAU) |
| Gemini API | Free tier (sufficient for family use) |

**Total: $0/month** for a typical family.
