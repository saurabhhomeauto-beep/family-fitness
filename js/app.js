// ============================================================
// FAMILY FITNESS HUB — v2
// Features: onboarding, history, chat, resting+active energy,
//           user context in all AI calls, fixed logging bugs
// ============================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'
import { SUPABASE_URL, SUPABASE_ANON_KEY, ANALYZE_ENDPOINT, TARGETS } from './config.js'

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
const CHAT_ENDPOINT = '/.netlify/functions/chat'

// ─── State ───────────────────────────────────────────────────
let S = {
  user: null,
  profile: null,
  settings: null,
  todayLog: null,
  foodEntries: [],
  historyLogs: [],
  historyFood: [],
  savedFoods: [],
  recentFoods: [],
  savedMeals: [],
  weightHistory: [],
  streakInfo: null, // { current, longest, lastDate } — computed client-side, see computeStreaks()
}

// Onboarding
let OB = { step: 1, data: {} }

// Chat
let chatHistory = []  // { role: 'user'|'model', text: '' }
let chatOpen = false

// Last AI food analysis result (kept around so items can be saved to the library)
let lastAnalyzedFoodItems = []

// Quick-add search panel state
let foodSearchLoaded = false

// Active Chart.js instance for the weight trend chart (destroyed/recreated on re-render)
let weightChartInstance = null

// History tab trend charts (steps / calories / net balance)
let trendsRangeDays = 7
let stepsChartInstance = null
let calorieChartInstance = null
let netChartInstance = null

// Tab
let activeTab = 'today'
let authMode = 'login'

// Family Management (Settings, admin-only) — members list for promote/demote
let familyMembers = []

// ─── Utilities ───────────────────────────────────────────────
const getToday = () => new Date().toISOString().split('T')[0]

const greeting = () => {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

const fmt = (n) => (n || 0).toLocaleString()
const fmtDate = () => new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
const fmtShortDate = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })

const toBase64 = (file) => new Promise((res, rej) => {
  const r = new FileReader()
  r.onload = () => res(r.result.split(',')[1])
  r.onerror = rej
  r.readAsDataURL(file)
})

// BMR via Mifflin-St Jeor
function calculateBMR(age, sex, height_cm, weight_kg) {
  let bmr = 10 * weight_kg + 6.25 * height_cm - 5 * age
  if (sex === 'male') bmr += 5
  else if (sex === 'female') bmr -= 161
  else bmr -= 78  // average for 'other'
  return Math.round(bmr)
}

function calculateTDEE(bmr, activityLevel) {
  const mult = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 }
  return Math.round(bmr * (mult[activityLevel] || 1.2))
}

// Resolve the user's personalized daily targets, falling back to config.js
// TARGETS (steps/active/water) when a user_settings target isn't set. There's
// no config.js default for calorie intake, so that falls back to TDEE, then null.
function getTargets() {
  const st = S.settings
  return {
    steps:           st?.target_steps ?? TARGETS.steps,
    active_calories: st?.target_active_kcal ?? TARGETS.active_calories,
    water_ml:        st?.target_water_ml ?? TARGETS.water_ml,
    intake_kcal:     st?.target_intake_kcal ?? st?.tdee_kcal ?? null,
  }
}

// Build context string sent to every Gemini call
function buildUserContext() {
  const p = S.profile
  const st = S.settings
  const log = S.todayLog || {}
  const consumed = S.foodEntries.reduce((s, f) => s + (f.calories || 0), 0)
  const protein = S.foodEntries.reduce((s, f) => s + (f.protein_g || 0), 0)
  const carbs = S.foodEntries.reduce((s, f) => s + (f.carbs_g || 0), 0)
  const fat = S.foodEntries.reduce((s, f) => s + (f.fat_g || 0), 0)
  const totalBurned = (log.active_calories_burned || 0) + (log.resting_calories || 0)
  const t = getTargets()

  if (!st) {
    return `User: ${p?.display_name || 'Unknown'}. No biometric profile yet.`
  }
  return `Name: ${p.display_name} | Age: ${st.age} | Sex: ${st.sex}
Height: ${st.height_cm}cm | Weight: ${st.weight_kg}kg
Goal: ${st.goal} | Activity: ${st.activity_level}
BMR: ${st.bmr_kcal} kcal/day | TDEE: ${st.tdee_kcal} kcal/day
Dietary notes: ${st.dietary_notes || 'None'}

TODAY (${getToday()}):
Steps: ${fmt(log.steps)} / ${fmt(t.steps)} goal
Active cal burned: ${fmt(log.active_calories_burned)} | Resting cal: ${fmt(log.resting_calories)}
Total burned: ${fmt(totalBurned)} | Water: ${log.water_ml || 0}ml
Food consumed: ${fmt(consumed)} kcal${t.intake_kcal ? ` / ${fmt(t.intake_kcal)} kcal target` : ''} | Net: ${fmt(totalBurned - consumed)} (${totalBurned >= consumed ? 'deficit' : 'surplus'})
Macros so far: ${protein.toFixed(1)}g protein · ${carbs.toFixed(1)}g carbs · ${fat.toFixed(1)}g fat`
}

// ─── DOM Helpers ─────────────────────────────────────────────
const mount = (html) => { document.getElementById('app').innerHTML = html }

const toast = (msg, ok = true) => {
  const el = document.createElement('div')
  el.className = `fixed top-5 left-1/2 -translate-x-1/2 z-[100] px-5 py-3 rounded-2xl text-sm font-semibold shadow-2xl
    ${ok ? 'bg-emerald-500 text-white' : 'bg-red-500 text-white'}`
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 3200)
}

const showSpinner = (msg = 'AI is thinking…') => {
  let el = document.getElementById('ai-overlay')
  if (!el) { el = document.createElement('div'); el.id = 'ai-overlay'; document.body.appendChild(el) }
  el.className = 'fixed inset-0 bg-black/75 flex flex-col items-center justify-center z-[90] gap-4'
  el.innerHTML = `<div class="w-12 h-12 border-4 border-cyan-400 border-t-transparent rounded-full animate-spin"></div>
    <p class="text-white font-semibold text-sm">${msg}</p>`
}
const hideSpinner = () => document.getElementById('ai-overlay')?.remove()

const confirmModal = (title, bodyHtml, onConfirm, label = 'Save') => {
  let el = document.getElementById('modal-root')
  if (!el) { el = document.createElement('div'); el.id = 'modal-root'; document.body.appendChild(el) }
  el.innerHTML = `
    <div class="fixed inset-0 bg-black/80 flex items-end justify-center z-[80] p-4">
      <div class="bg-gray-900 border border-gray-800 rounded-3xl w-full max-w-lg p-6 space-y-4">
        <h3 class="text-lg font-bold">${title}</h3>${bodyHtml}
        <div class="flex gap-3 pt-1">
          <button id="_m_cancel" class="flex-1 py-3 rounded-2xl bg-gray-800 text-gray-300 font-semibold text-sm">Cancel</button>
          <button id="_m_confirm" class="flex-1 py-3 rounded-2xl bg-cyan-500 hover:bg-cyan-400 text-white font-semibold text-sm transition-colors">${label}</button>
        </div>
      </div>
    </div>`
  el.querySelector('#_m_cancel').onclick = () => el.remove()
  // Run onConfirm BEFORE removing the modal. Each caller reads its input
  // values synchronously (before its first await), so the inputs must still
  // exist in the DOM at that moment. Removing first left them null → crash.
  el.querySelector('#_m_confirm').onclick = () => { onConfirm(); el.remove() }
}

// ─── Ring SVG ────────────────────────────────────────────────
const ring = (value, max, hex) => {
  const pct = Math.min(100, Math.max(0, ((value || 0) / max) * 100)).toFixed(1)
  return `<svg viewBox="0 0 36 36" class="w-full h-full" style="transform:rotate(-90deg)">
    <circle cx="18" cy="18" r="15.9155" fill="none" stroke="#1F2937" stroke-width="3.2"/>
    <circle cx="18" cy="18" r="15.9155" fill="none" stroke="${hex}" stroke-width="3.2"
      stroke-dasharray="${pct}, 100" stroke-linecap="round"
      style="transition:stroke-dasharray 1.1s cubic-bezier(.4,0,.2,1)"/>
  </svg>`
}

const ringCard = (label, value, display, max, hex, icon) => `
  <div class="flex flex-col items-center gap-2">
    <div class="relative w-[84px] h-[84px]">
      ${ring(value, max, hex)}
      <div class="absolute inset-0 flex flex-col items-center justify-center gap-0.5">
        <span class="text-base leading-none">${icon}</span>
        <span class="text-[11px] font-bold leading-none text-white">${display}</span>
      </div>
    </div>
    <span class="text-xs text-gray-400">${label}</span>
  </div>`

// ─── ═══════════════════════════════════════════════════════ ─
//     AUTH VIEW
// ─── ═══════════════════════════════════════════════════════ ─
window.toggleAuthMode = () => { authMode = authMode === 'login' ? 'signup' : 'login'; renderAuth() }

window.handleAuth = async () => {
  const email = document.getElementById('auth-email').value.trim()
  const pass  = document.getElementById('auth-pass').value
  const name  = document.getElementById('auth-name')?.value.trim()
  const btn   = document.getElementById('auth-btn')
  btn.disabled = true; btn.textContent = 'Please wait…'

  try {
    if (authMode === 'login') {
      const { error } = await supabase.auth.signInWithPassword({ email, password: pass })
      if (error) throw error
    } else {
      if (!name) throw new Error('Display name is required.')
      const { data, error } = await supabase.auth.signUp({ email, password: pass })
      if (error) throw error
      if (data.user) {
        // A DB trigger (schema-v8) already creates this row on signup, so we
        // upsert rather than insert: the display name typed here wins, and a
        // duplicate never raises a 409. If the trigger is ever missing, the
        // upsert still creates the row on its own.
        await supabase.from('profiles').upsert({
          id: data.user.id, display_name: name, role: 'user', onboarding_complete: false
        }, { onConflict: 'id' })
      } else {
        mount(`<div class="min-h-screen bg-gray-950 flex items-center justify-center p-8 text-center">
          <div class="space-y-4"><div class="text-5xl">📧</div>
          <h2 class="text-2xl font-bold">Check your email</h2>
          <p class="text-gray-400 text-sm">We sent a confirmation link to <strong>${email}</strong>. Click it to activate your account.</p></div></div>`)
        return
      }
    }
  } catch (err) {
    toast(err.message, false)
    btn.disabled = false
    btn.textContent = authMode === 'login' ? 'Sign In' : 'Create Account'
  }
}

function renderAuth() {
  const isLogin = authMode === 'login'
  mount(`
  <div class="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-6 py-12">
    <div class="w-full max-w-sm space-y-8">
      <div class="text-center space-y-2">
        <div class="text-5xl">🏃</div>
        <h1 class="text-3xl font-black tracking-tight">Family Fitness Hub</h1>
        <p class="text-gray-400 text-sm">Track your family's health, together.</p>
      </div>
      <div class="bg-gray-900 border border-gray-800 rounded-3xl p-7 space-y-4">
        <h2 class="font-bold text-lg">${isLogin ? 'Welcome back' : 'Create your account'}</h2>
        ${!isLogin ? `<div class="space-y-1">
          <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Your name</label>
          <input id="auth-name" type="text" placeholder="First name" autocomplete="name"
            class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors placeholder-gray-500"/></div>` : ''}
        <div class="space-y-1">
          <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Email</label>
          <input id="auth-email" type="email" placeholder="you@example.com" autocomplete="email"
            class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors placeholder-gray-500"/>
        </div>
        <div class="space-y-1">
          <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Password</label>
          <input id="auth-pass" type="password" placeholder="••••••••"
            autocomplete="${isLogin ? 'current-password' : 'new-password'}"
            class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors placeholder-gray-500"/>
        </div>
        ${isLogin ? `<p class="text-right -mt-2">
          <button onclick="openForgotPassword()" class="text-xs text-gray-500 hover:text-gray-400">Forgot password?</button>
        </p>` : ''}
        <button id="auth-btn" onclick="handleAuth()"
          class="w-full py-3.5 bg-cyan-500 hover:bg-cyan-400 text-white font-bold rounded-xl text-sm transition-colors">
          ${isLogin ? 'Sign In' : 'Create Account'}
        </button>
      </div>
      <p class="text-center text-sm text-gray-500">
        ${isLogin ? "Don't have an account?" : 'Already have an account?'}
        <button onclick="toggleAuthMode()" class="text-cyan-400 font-semibold ml-1">${isLogin ? 'Sign up' : 'Sign in'}</button>
      </p>
    </div>
  </div>`)
}

window.openForgotPassword = () => {
  confirmModal(
    'Reset your password',
    `<div class="space-y-1">
      <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Email</label>
      <input id="forgot-email" type="email" placeholder="you@example.com" autocomplete="email"
        class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors placeholder-gray-500"/>
      <p class="text-xs text-gray-500 pt-1">We'll email you a link to set a new password.</p>
    </div>`,
    async () => {
      const email = document.getElementById('forgot-email').value.trim()
      if (!email) { toast('Enter your email address.', false); return }
      showSpinner('Sending reset email…')
      try {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin })
        if (error) throw error
        hideSpinner()
        toast('Check your email for a reset link 📧')
      } catch (err) {
        hideSpinner()
        toast(err.message || 'Failed to send reset email. Try again.', false)
        console.error(err)
      }
    },
    'Send Link'
  )
}

// ─── ═══════════════════════════════════════════════════════ ─
//     ONBOARDING — 5-step questionnaire
// ─── ═══════════════════════════════════════════════════════ ─
function renderOnboarding() {
  const step = OB.step
  const d = OB.data
  const progress = `
    <div class="flex gap-1.5 mb-6">
      ${[1,2,3,4,5].map(i => `<div class="h-1 flex-1 rounded-full ${i <= step ? 'bg-cyan-400' : 'bg-gray-800'}"></div>`).join('')}
    </div>`

  let content = ''

  if (step === 1) {
    content = `
      <h2 class="text-2xl font-black mb-1">About you</h2>
      <p class="text-gray-400 text-sm mb-6">We use this to calculate your calorie needs accurately.</p>
      <div class="space-y-4">
        <div>
          <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Age</label>
          <input id="ob-age" type="number" min="10" max="100" placeholder="e.g. 32" value="${d.age || ''}" oninput="obCaptureStep1()"
            class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors"/>
        </div>
        <div>
          <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Biological sex</label>
          <div class="flex gap-2 mt-1">
            ${['male','female','other'].map(s => `
              <button onclick="obSelectSex('${s}')" id="sex-${s}"
                class="flex-1 py-2.5 rounded-xl text-sm font-semibold border transition-colors
                  ${d.sex === s ? 'bg-cyan-500 border-cyan-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-300'}">
                ${s.charAt(0).toUpperCase() + s.slice(1)}
              </button>`).join('')}
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Height (cm)</label>
            <input id="ob-height" type="number" min="100" max="250" placeholder="e.g. 175" value="${d.height_cm || ''}" oninput="obCaptureStep1()"
              class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors"/>
          </div>
          <div>
            <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Weight (kg)</label>
            <input id="ob-weight" type="number" min="20" max="300" placeholder="e.g. 75" value="${d.weight_kg || ''}" oninput="obCaptureStep1()"
              class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors"/>
          </div>
        </div>
      </div>`
  }

  else if (step === 2) {
    const levels = [
      { id: 'sedentary',  icon: '🪑', label: 'Sedentary',        desc: 'Desk job, little or no exercise' },
      { id: 'light',      icon: '🚶', label: 'Lightly Active',    desc: 'Light exercise 1–3 days/week' },
      { id: 'moderate',   icon: '🏊', label: 'Moderately Active', desc: 'Moderate exercise 3–5 days/week' },
      { id: 'active',     icon: '🏋️', label: 'Very Active',       desc: 'Hard exercise 6–7 days/week' },
      { id: 'very_active',icon: '⚡', label: 'Extremely Active',  desc: 'Physical job or twice-daily training' },
    ]
    content = `
      <h2 class="text-2xl font-black mb-1">Activity level</h2>
      <p class="text-gray-400 text-sm mb-6">Think about your typical week, not your best week.</p>
      <div class="space-y-2">
        ${levels.map(l => `
          <button onclick="obSelectActivity('${l.id}')"
            class="w-full flex items-center gap-4 p-4 rounded-2xl border text-left transition-colors
              ${d.activity_level === l.id ? 'bg-cyan-500/10 border-cyan-500/60 text-white' : 'bg-gray-800 border-gray-700 text-gray-300'}">
            <span class="text-2xl">${l.icon}</span>
            <div>
              <div class="font-semibold text-sm">${l.label}</div>
              <div class="text-xs text-gray-400">${l.desc}</div>
            </div>
          </button>`).join('')}
      </div>`
  }

  else if (step === 3) {
    const goals = [
      { id: 'lose',     icon: '🔥', label: 'Lose Fat',        desc: 'Reduce body fat while preserving muscle' },
      { id: 'maintain', icon: '⚖️', label: 'Maintain Weight', desc: 'Stay at your current weight and composition' },
      { id: 'build',    icon: '💪', label: 'Build Muscle',    desc: 'Gain strength and lean mass' },
    ]
    content = `
      <h2 class="text-2xl font-black mb-1">Your goal</h2>
      <p class="text-gray-400 text-sm mb-6">Your AI coach will tailor advice to this.</p>
      <div class="space-y-3">
        ${goals.map(g => `
          <button onclick="obSelectGoal('${g.id}')"
            class="w-full flex items-center gap-4 p-4 rounded-2xl border text-left transition-colors
              ${d.goal === g.id ? 'bg-cyan-500/10 border-cyan-500/60 text-white' : 'bg-gray-800 border-gray-700 text-gray-300'}">
            <span class="text-3xl">${g.icon}</span>
            <div>
              <div class="font-semibold text-sm">${g.label}</div>
              <div class="text-xs text-gray-400">${g.desc}</div>
            </div>
          </button>`).join('')}
      </div>`
  }

  else if (step === 4) {
    const tags = ['Vegetarian','Vegan','Gluten-free','Dairy-free','Halal','Kosher','Low-carb','Nut-free']
    const selectedTags = d.dietTags || []
    content = `
      <h2 class="text-2xl font-black mb-1">Dietary notes</h2>
      <p class="text-gray-400 text-sm mb-6">Helps AI give better food advice. Skip if no restrictions.</p>
      <div class="flex flex-wrap gap-2 mb-4">
        ${tags.map(t => `
          <button onclick="obToggleTag('${t}')"
            class="px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors
              ${selectedTags.includes(t) ? 'bg-violet-500/20 border-violet-500/60 text-violet-300' : 'bg-gray-800 border-gray-700 text-gray-400'}">
            ${t}
          </button>`).join('')}
      </div>
      <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Anything else?</label>
      <textarea id="ob-notes" rows="3" placeholder="e.g. shellfish allergy, trying to eat less processed food…"
        class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors resize-none placeholder-gray-500">${d.notes || ''}</textarea>`
  }

  else if (step === 5) {
    const bmr = calculateBMR(d.age, d.sex, d.height_cm, d.weight_kg)
    const tdee = calculateTDEE(bmr, d.activity_level)
    const goalCalories = d.goal === 'lose' ? tdee - 500 : d.goal === 'build' ? tdee + 300 : tdee
    OB.data.bmr = bmr
    OB.data.tdee = tdee
    content = `
      <h2 class="text-2xl font-black mb-1">Your numbers 🎯</h2>
      <p class="text-gray-400 text-sm mb-6">Based on your profile. These are estimates — adjust as needed.</p>
      <div class="space-y-3">
        <div class="bg-gray-800 rounded-2xl p-4 flex justify-between items-center">
          <div>
            <div class="text-xs text-gray-400 font-medium">BMR (resting metabolic rate)</div>
            <div class="text-xs text-gray-500 mt-0.5">Calories burned at complete rest</div>
          </div>
          <div class="text-xl font-black text-emerald-400">${fmt(bmr)}<span class="text-xs text-gray-400 font-normal ml-1">kcal</span></div>
        </div>
        <div class="bg-gray-800 rounded-2xl p-4 flex justify-between items-center">
          <div>
            <div class="text-xs text-gray-400 font-medium">TDEE (total daily energy)</div>
            <div class="text-xs text-gray-500 mt-0.5">Estimated total calories burned per day</div>
          </div>
          <div class="text-xl font-black text-cyan-400">${fmt(tdee)}<span class="text-xs text-gray-400 font-normal ml-1">kcal</span></div>
        </div>
        <div class="bg-cyan-500/10 border border-cyan-500/30 rounded-2xl p-4 flex justify-between items-center">
          <div>
            <div class="text-xs text-cyan-300 font-semibold">Recommended daily intake</div>
            <div class="text-xs text-gray-400 mt-0.5">${d.goal === 'lose' ? 'For fat loss (TDEE − 500)' : d.goal === 'build' ? 'For muscle gain (TDEE + 300)' : 'For maintenance'}</div>
          </div>
          <div class="text-xl font-black text-white">${fmt(goalCalories)}<span class="text-xs text-gray-400 font-normal ml-1">kcal</span></div>
        </div>
      </div>`
  }

  const isLast = step === 5
  const canNext = step < 5

  mount(`
  <div class="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-6 py-10">
    <div class="w-full max-w-sm">
      ${progress}
      ${content}
      <div class="mt-6 flex gap-3">
        ${step > 1 ? `<button onclick="obBack()" class="px-5 py-3 rounded-2xl bg-gray-800 text-gray-300 font-semibold text-sm">← Back</button>` : ''}
        <button onclick="${isLast ? 'obFinish()' : 'obNext()'}"
          class="flex-1 py-3 rounded-2xl bg-cyan-500 hover:bg-cyan-400 text-white font-bold text-sm transition-colors">
          ${isLast ? 'Start Tracking 🚀' : 'Continue →'}
        </button>
      </div>
      <p class="text-center text-xs text-gray-600 mt-4">Step ${step} of 5</p>
    </div>
  </div>`)
}

// Onboarding handlers (must be on window)
// Persist step-1 numeric inputs into OB.data so a re-render (e.g. tapping a
// sex button) never wipes what the user already typed.
window.obCaptureStep1 = () => {
  const a = document.getElementById('ob-age')
  const h = document.getElementById('ob-height')
  const w = document.getElementById('ob-weight')
  if (a) OB.data.age       = a.value === '' ? undefined : +a.value
  if (h) OB.data.height_cm = h.value === '' ? undefined : +h.value
  if (w) OB.data.weight_kg = w.value === '' ? undefined : +w.value
}
window.obSelectSex      = (v) => { obCaptureStep1(); OB.data.sex = v; renderOnboarding() }
window.obSelectActivity = (v) => { OB.data.activity_level = v; renderOnboarding() }
window.obSelectGoal     = (v) => { OB.data.goal = v; renderOnboarding() }
window.obToggleTag      = (t) => {
  const tags = OB.data.dietTags || []
  OB.data.dietTags = tags.includes(t) ? tags.filter(x => x !== t) : [...tags, t]
  renderOnboarding()
}

window.obNext = () => {
  const d = OB.data
  if (OB.step === 1) {
    const age = +document.getElementById('ob-age').value
    const height = +document.getElementById('ob-height').value
    const weight = +document.getElementById('ob-weight').value
    if (!age || !height || !weight || !d.sex) { toast('Please fill in all fields.', false); return }
    d.age = age; d.height_cm = height; d.weight_kg = weight
  }
  if (OB.step === 2 && !d.activity_level) { toast('Please select an activity level.', false); return }
  if (OB.step === 3 && !d.goal)           { toast('Please select a goal.', false); return }
  if (OB.step === 4) {
    d.notes = document.getElementById('ob-notes')?.value.trim() || ''
    const tagStr = (d.dietTags || []).join(', ')
    d.dietary_notes = [tagStr, d.notes].filter(Boolean).join('. ')
  }
  OB.step++
  renderOnboarding()
}

window.obBack = () => { OB.step--; renderOnboarding() }

window.obFinish = async () => {
  const d = OB.data
  showSpinner('Saving your profile…')
  try {
    // Seed personalized targets: steps/active/water from config.js defaults,
    // and a calorie-intake budget derived from TDEE + goal.
    const target_intake_kcal = d.goal === 'lose' ? d.tdee - 500
      : d.goal === 'build' ? d.tdee + 300
      : d.tdee

    await supabase.from('user_settings').upsert({
      user_id: S.user.id,
      age: d.age, sex: d.sex,
      height_cm: d.height_cm, weight_kg: d.weight_kg,
      activity_level: d.activity_level,
      goal: d.goal,
      dietary_notes: d.dietary_notes || '',
      bmr_kcal: d.bmr,
      tdee_kcal: d.tdee,
      target_steps: TARGETS.steps,
      target_active_kcal: TARGETS.active_calories,
      target_water_ml: TARGETS.water_ml,
      target_intake_kcal,
    }, { onConflict: 'user_id' })

    await supabase.from('profiles').update({ onboarding_complete: true }).eq('id', S.user.id)

    S.settings = {
      ...d, bmr_kcal: d.bmr, tdee_kcal: d.tdee,
      target_steps: TARGETS.steps, target_active_kcal: TARGETS.active_calories,
      target_water_ml: TARGETS.water_ml, target_intake_kcal,
    }
    S.profile.onboarding_complete = true
    hideSpinner()
    toast('Profile saved! Let\'s go! 🚀')
    await loadUserData()
    renderLayout()
  } catch (err) {
    hideSpinner()
    toast('Failed to save profile. Try again.', false)
    console.error(err)
  }
}

// ─── ═══════════════════════════════════════════════════════ ─
//     DATA LOADING
// ─── ═══════════════════════════════════════════════════════ ─
async function loadUserData() {
  const uid = S.user.id
  const today = getToday()

  const [
    { data: profile },
    { data: settings },
    { data: log },
    { data: food },
    { data: logDates },
  ] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', uid).single(),
    supabase.from('user_settings').select('*').eq('user_id', uid).single(),
    supabase.from('daily_logs').select('*').eq('user_id', uid).eq('date', today).single(),
    supabase.from('food_entries').select('*').eq('user_id', uid).order('created_at', { ascending: false }),
    // Lightweight (date column only) — used to derive streaks client-side.
    // Bounded by one row per calendar day the user has ever logged, so this
    // stays cheap without needing a separate cache table.
    supabase.from('daily_logs').select('date').eq('user_id', uid).order('date', { ascending: true }),
  ])

  S.profile  = profile
  S.settings = settings || null
  S.todayLog = log || { steps: 0, active_calories_burned: 0, resting_calories: settings?.bmr_kcal || 0, water_ml: 0 }

  if (log && food) {
    S.foodEntries = food.filter(f => f.log_id === log.id)
  } else {
    S.foodEntries = []
  }

  S.streakInfo = computeStreaks((logDates || []).map(r => r.date))
}

// ─── Streaks & badges ─────────────────────────────────────────
// Derived entirely from daily_logs.date (a row only ever exists for a day the
// user actually logged something — see getOrCreateLog). No new table/column.
// Framing is additive-only: there is no "streak broken" state surfaced anywhere,
// just a current count (0 shown as nothing) and a longest-ever count.
function computeStreaks(dates) {
  if (!dates.length) return { current: 0, longest: 0, lastDate: null }

  const oneDay = 24 * 60 * 60 * 1000
  const toTime = (d) => new Date(d + 'T00:00:00').getTime()

  let longest = 1
  let run = 1
  for (let i = 1; i < dates.length; i++) {
    const gap = Math.round((toTime(dates[i]) - toTime(dates[i - 1])) / oneDay)
    run = (gap === 1) ? run + 1 : 1
    if (run > longest) longest = run
  }

  // A day's grace: if the last logged day was yesterday (not today yet), the
  // streak still counts as "alive" rather than showing 0 mid-day.
  const today = getToday()
  const yesterday = new Date(Date.now() - oneDay).toISOString().split('T')[0]
  const lastDate = dates[dates.length - 1]

  let current = 0
  if (lastDate === today || lastDate === yesterday) {
    current = 1
    for (let i = dates.length - 1; i > 0; i--) {
      const gap = Math.round((toTime(dates[i]) - toTime(dates[i - 1])) / oneDay)
      if (gap === 1) current++
      else break
    }
  }

  return { current, longest: Math.max(longest, current), lastDate }
}

// Simple, always-positive achievement badges for "today". Additive only —
// there's no unearned/failed visual state beyond a neutral, muted chip.
function computeTodayBadges() {
  const log = S.todayLog || {}
  const targets = getTargets()
  return [
    { id: 'steps', icon: '👟', label: 'Step Goal',    earned: (log.steps || 0) >= targets.steps },
    { id: 'water', icon: '💧', label: 'Hydration',    earned: (log.water_ml || 0) >= targets.water_ml },
    // No per-meal (breakfast/lunch/dinner) schema exists, so "logged all meals"
    // is approximated as 3+ separate food entries logged today.
    { id: 'meals', icon: '🍽️', label: 'Meals Logged', earned: S.foodEntries.length >= 3 },
  ]
}

// Called right when getOrCreateLog() creates the very first row for "today" —
// extends the streak optimistically without re-querying all dates.
function bumpStreakForToday() {
  const today = getToday()
  const info = S.streakInfo || { current: 0, longest: 0, lastDate: null }
  if (info.lastDate === today) return

  const oneDay = 24 * 60 * 60 * 1000
  const yesterday = new Date(Date.now() - oneDay).toISOString().split('T')[0]
  const extendsStreak = info.lastDate === yesterday || info.lastDate === today
  const current = extendsStreak ? info.current + 1 : 1

  S.streakInfo = { current, longest: Math.max(info.longest, current), lastDate: today }
}

// Patches just the header's streak indicator in place (avoids a full renderLayout
// remount, which would otherwise blow away whatever tab is currently mounted).
function updateStreakHeader() {
  const el = document.getElementById('streak-indicator')
  if (!el) return
  const current = S.streakInfo?.current || 0
  el.textContent = current > 0 ? `🔥 ${current}-day streak` : ''
  el.classList.toggle('hidden', current === 0)
}

async function getOrCreateLog() {
  const uid = S.user.id
  const today = getToday()

  const { data: existing } = await supabase.from('daily_logs').select('*')
    .eq('user_id', uid).eq('date', today).single()

  if (existing) { S.todayLog = existing; return existing }

  // Auto-seed resting_calories from BMR
  const resting = S.settings?.bmr_kcal || 0
  const { data: created, error } = await supabase.from('daily_logs')
    .insert({ user_id: uid, date: today, steps: 0, active_calories_burned: 0, resting_calories: resting, water_ml: 0 })
    .select().single()

  if (error) { console.error('getOrCreateLog error:', error); throw error }
  S.todayLog = created

  // First log of a brand-new day — extend the streak in place.
  bumpStreakForToday()
  updateStreakHeader()

  return created
}

async function loadHistoryData() {
  const uid = S.user.id
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  const [{ data: logs }, { data: food }] = await Promise.all([
    supabase.from('daily_logs').select('*')
      .eq('user_id', uid).gte('date', sevenDaysAgo).order('date', { ascending: false }),
    supabase.from('food_entries').select('*').eq('user_id', uid)
  ])

  S.historyLogs = logs || []
  S.historyFood = food || []
}

// Loads up to the last 90 logged weight entries (sparse — not every calendar day),
// ascending by date, for the History tab's weight trend chart.
async function loadWeightData() {
  const uid = S.user.id
  const { data } = await supabase.from('weight_logs')
    .select('*').eq('user_id', uid)
    .order('date', { ascending: true })
    .limit(90)
  S.weightHistory = data || []
}

// Aggregates daily_logs + food_entries into one row per day for the trend charts,
// covering the last `days` days. Two queries total regardless of range (no N+1):
// one for daily_logs in the date range, one batched food_entries fetch keyed by
// the resulting log ids, with per-day calorie totals summed in JS.
async function loadTrendsData(days) {
  const uid = S.user.id
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  const { data: logs } = await supabase.from('daily_logs')
    .select('id, date, steps, active_calories_burned, resting_calories')
    .eq('user_id', uid).gte('date', cutoff).order('date', { ascending: true })

  const logRows = logs || []
  const consumedByLog = {}

  if (logRows.length) {
    const logIds = logRows.map(l => l.id)
    const { data: food } = await supabase.from('food_entries')
      .select('log_id, calories')
      .in('log_id', logIds)
    for (const f of (food || [])) {
      consumedByLog[f.log_id] = (consumedByLog[f.log_id] || 0) + (f.calories || 0)
    }
  }

  return logRows.map(l => {
    const consumed = consumedByLog[l.id] || 0
    const burned = (l.active_calories_burned || 0) + (l.resting_calories || 0)
    return { date: l.date, steps: l.steps || 0, consumed, burned, net: burned - consumed }
  })
}

async function loadAdminData() {
  const today = getToday()
  const [{ data: profiles }, { data: settings }, { data: logs }, { data: food }] = await Promise.all([
    supabase.from('profiles').select('*'),
    supabase.from('user_settings').select('*'),
    supabase.from('daily_logs').select('*').eq('date', today),
    supabase.from('food_entries').select('*')
  ])
  return { profiles: profiles || [], settings: settings || [], logs: logs || [], food: food || [] }
}

// Loads saved foods, recent (deduped) foods, and saved meals for the Quick Add panel.
async function loadQuickAddData() {
  const uid = S.user.id

  const [{ data: saved }, { data: recentRaw }, { data: meals }] = await Promise.all([
    supabase.from('saved_foods').select('*').eq('user_id', uid).order('food_name', { ascending: true }),
    supabase.from('food_entries').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(50),
    supabase.from('meals').select('*').eq('user_id', uid).order('created_at', { ascending: false })
  ])

  S.savedFoods = saved || []

  // Dedup recent food_entries by name, keep the most recent occurrence, cap at 10
  const seen = new Set()
  const recent = []
  for (const f of (recentRaw || [])) {
    const key = f.food_name.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    recent.push(f)
    if (recent.length >= 10) break
  }
  S.recentFoods = recent

  if (meals && meals.length) {
    const mealIds = meals.map(m => m.id)
    const { data: items } = await supabase.from('meal_items').select('*').in('meal_id', mealIds)
    S.savedMeals = meals.map(m => ({
      ...m,
      items: (items || []).filter(i => i.meal_id === m.id)
    }))
  } else {
    S.savedMeals = []
  }

  foodSearchLoaded = true
}

// Lean member list for the Settings → Family Management card (admin-only).
// Deliberately separate from loadAdminData() — that one pulls full daily
// activity/food data for the Family Overview screen; this only needs
// enough to render/promote/demote members.
async function loadMembersForSettings() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, role, created_at')
    .order('created_at', { ascending: true })
  if (error) { console.error(error); return [] }
  return data || []
}

// ─── ═══════════════════════════════════════════════════════ ─
//     LAYOUT SHELL (tabs + persistent elements)
// ─── ═══════════════════════════════════════════════════════ ─
function renderLayout() {
  const isAdmin = S.profile?.role === 'admin'
  mount(`
  <div class="min-h-screen bg-gray-950 text-white flex flex-col">
    <!-- Header -->
    <div class="sticky top-0 bg-gray-950/90 backdrop-blur-md border-b border-gray-800 px-5 py-4 flex items-center justify-between z-10">
      <div>
        <p class="text-xs text-gray-400">${fmtDate()}</p>
        <h1 class="font-bold text-base leading-tight">${greeting()}, ${S.profile?.display_name || 'there'} 👋</h1>
        <p id="streak-indicator" class="text-xs text-amber-400 font-semibold mt-0.5 ${(S.streakInfo?.current || 0) > 0 ? '' : 'hidden'}">${(S.streakInfo?.current || 0) > 0 ? `🔥 ${S.streakInfo.current}-day streak` : ''}</p>
      </div>
      <div class="flex items-center gap-2">
        ${isAdmin ? `<button onclick="showAdminView()" class="px-3 py-1.5 text-xs bg-violet-600 hover:bg-violet-500 rounded-xl font-semibold transition-colors">Family</button>` : ''}
        <button onclick="showSettingsView()" class="w-8 h-8 flex items-center justify-center text-sm bg-gray-800 hover:bg-gray-700 rounded-xl transition-colors" title="Settings">⚙️</button>
        <button onclick="handleLogout()" class="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 rounded-xl font-semibold transition-colors">Log out</button>
      </div>
    </div>

    <!-- Scrollable content area -->
    <div id="tab-content" class="flex-1 overflow-y-auto pb-24"></div>

    <!-- Bottom tab bar -->
    <div class="fixed bottom-0 left-0 right-0 bg-gray-950/95 backdrop-blur-md border-t border-gray-800 px-4 py-2 flex z-10">
      <button onclick="switchTab('today')" id="tab-today"
        class="flex-1 flex flex-col items-center gap-1 py-2 text-xs font-semibold transition-colors rounded-xl">
        <span class="text-lg">🏠</span><span>Today</span>
      </button>
      <button onclick="switchTab('history')" id="tab-history"
        class="flex-1 flex flex-col items-center gap-1 py-2 text-xs font-semibold transition-colors rounded-xl">
        <span class="text-lg">📅</span><span>History</span>
      </button>
      <button onclick="openChat()"
        class="flex-1 flex flex-col items-center gap-1 py-2 text-xs font-semibold text-violet-400 transition-colors rounded-xl">
        <span class="text-lg">🤖</span><span>Coach</span>
      </button>
    </div>
  </div>

  <!-- Chat overlay (hidden by default) -->
  <div id="chat-overlay" class="fixed inset-0 bg-gray-950 flex flex-col z-50 translate-y-full transition-transform duration-300 ease-out">
    <div class="flex items-center justify-between px-5 py-4 border-b border-gray-800">
      <div>
        <h2 class="font-bold">AI Coach</h2>
        <p class="text-xs text-gray-400">Knows your stats for today</p>
      </div>
      <button onclick="closeChat()" class="w-9 h-9 flex items-center justify-center rounded-full bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors text-lg">✕</button>
    </div>
    <div id="chat-messages" class="flex-1 overflow-y-auto px-5 py-4 space-y-3"></div>
    <div class="px-4 pb-8 pt-3 border-t border-gray-800 flex gap-2">
      <input id="chat-input" type="text" placeholder="Ask your coach anything…"
        class="flex-1 bg-gray-800 border border-gray-700 focus:border-violet-500 rounded-2xl px-4 py-3 text-sm outline-none transition-colors placeholder-gray-500"
        onkeydown="if(event.key==='Enter')sendChat()"/>
      <button onclick="sendChat()"
        class="w-12 h-12 bg-violet-600 hover:bg-violet-500 rounded-2xl flex items-center justify-center text-xl transition-colors">➤</button>
    </div>
  </div>`)

  switchTab('today')
}

window.switchTab = (tab) => {
  activeTab = tab
  // Update tab styles
  ;['today','history'].forEach(t => {
    const el = document.getElementById(`tab-${t}`)
    if (el) el.className = `flex-1 flex flex-col items-center gap-1 py-2 text-xs font-semibold transition-colors rounded-xl
      ${t === tab ? 'text-cyan-400' : 'text-gray-500'}`
  })
  // Render content
  if (tab === 'today') renderTodayTab()
  else if (tab === 'history') renderHistoryTab()
}

// ─── ═══════════════════════════════════════════════════════ ─
//     TODAY TAB
// ─── ═══════════════════════════════════════════════════════ ─
// Slim, encouragement-only strip of today's achievement badges. Unearned
// badges are simply muted/neutral — never crossed out, greyed with a warning
// icon, or otherwise framed as a failure.
function renderBadgesStrip() {
  const streak = S.streakInfo || { current: 0, longest: 0 }
  const badges = computeTodayBadges()
  return `
  <div class="bg-gray-900 border border-gray-800 rounded-3xl p-4">
    <div class="flex items-center justify-between mb-2.5">
      <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Badges Today</p>
      ${streak.longest > 1 ? `<span class="text-[11px] text-gray-500">🏆 Best streak: ${streak.longest}d</span>` : ''}
    </div>
    <div class="flex gap-2 overflow-x-auto">
      ${badges.map(b => `
        <div class="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-xl border transition-colors
          ${b.earned ? 'bg-amber-500/10 border-amber-500/40 text-amber-400' : 'bg-gray-800 border-gray-700 text-gray-500'}">
          <span>${b.icon}</span><span class="text-[11px] font-semibold whitespace-nowrap">${b.label}</span>
        </div>`).join('')}
    </div>
  </div>`
}

function renderTodayTab() {
  const log      = S.todayLog || {}
  const steps    = log.steps || 0
  const burned   = log.active_calories_burned || 0
  const resting  = log.resting_calories || S.settings?.bmr_kcal || 0
  const waterMl  = log.water_ml || 0
  const consumed = S.foodEntries.reduce((s, f) => s + (f.calories || 0), 0)
  const protein  = S.foodEntries.reduce((s, f) => s + (f.protein_g || 0), 0)
  const carbsG   = S.foodEntries.reduce((s, f) => s + (f.carbs_g || 0), 0)
  const fatG     = S.foodEntries.reduce((s, f) => s + (f.fat_g || 0), 0)
  const totalBurned = burned + resting
  const net = totalBurned - consumed
  const inDeficit = net >= 0
  const tdee = S.settings?.tdee_kcal || 0
  const targets = getTargets()
  const intakeRemaining = targets.intake_kcal != null ? targets.intake_kcal - consumed : null

  const foodRows = S.foodEntries.length === 0
    ? `<p class="text-sm text-gray-500 text-center py-4">No food logged yet today.</p>`
    : S.foodEntries.map(f => `
        <div class="flex items-center justify-between gap-2 py-2.5 border-b border-gray-800 last:border-0 text-sm">
          <button onclick="editFood('${f.id}')" class="flex-1 min-w-0 text-left hover:text-cyan-400 transition-colors">
            <div class="text-gray-200 truncate">${f.food_name}</div>
            <div class="text-[11px] text-gray-500 mt-0.5">${fmt(f.calories)} kcal · ${(f.protein_g||0).toFixed(1)}P / ${(f.carbs_g||0).toFixed(1)}C / ${(f.fat_g||0).toFixed(1)}F</div>
          </button>
          <button onclick="deleteFood('${f.id}')" class="text-gray-600 hover:text-red-400 transition-colors w-5 shrink-0 text-center">×</button>
        </div>`).join('')

  document.getElementById('tab-content').innerHTML = `
  <div class="max-w-lg mx-auto px-5 space-y-4 pt-5">

    ${renderBadgesStrip()}

    <!-- Ring metrics -->
    <div class="bg-gray-900 border border-gray-800 rounded-3xl p-5">
      <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">Today's Activity</p>
      <div class="grid grid-cols-3 gap-2">
        ${ringCard('Steps',    steps,   fmt(steps), targets.steps, '#22D3EE', '👟')}
        ${ringCard('Active',   burned,  fmt(burned)+' kcal', targets.active_calories, '#FBBF24', '🔥')}
        ${ringCard('Water',    waterMl, waterMl >= 1000 ? (waterMl/1000).toFixed(1)+'L' : waterMl+'ml', targets.water_ml, '#34D399', '💧')}
      </div>
      <div class="grid grid-cols-3 gap-2 mt-2 text-center">
        <span class="text-[10px] text-gray-600">/ ${fmt(targets.steps)}</span>
        <span class="text-[10px] text-gray-600">/ ${targets.active_calories} kcal</span>
        <span class="text-[10px] text-gray-600">/ ${targets.water_ml/1000}L</span>
      </div>
    </div>

    <!-- Energy Balance (Active + Resting) -->
    <div class="bg-gray-900 border border-gray-800 rounded-3xl p-5">
      <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Energy Balance</p>
      <!-- Burned breakdown -->
      <div class="bg-gray-800 rounded-2xl p-3 mb-3 space-y-2">
        <div class="flex justify-between text-sm">
          <span class="text-gray-400">🔥 Active energy</span>
          <span class="font-semibold text-amber-400">${fmt(burned)} kcal</span>
        </div>
        <div class="flex justify-between text-sm">
          <span class="text-gray-400">💤 Resting energy (BMR)</span>
          <span class="font-semibold text-emerald-400">${fmt(resting)} kcal</span>
        </div>
        <div class="border-t border-gray-700 pt-2 flex justify-between text-sm font-bold">
          <span class="text-gray-300">Total burned</span>
          <span class="text-white">${fmt(totalBurned)} kcal</span>
        </div>
      </div>
      <!-- Net -->
      <div class="grid grid-cols-2 gap-3 text-center">
        <div class="bg-gray-800 rounded-xl p-3">
          <div class="text-xs text-gray-400 mb-1">Consumed</div>
          <div class="text-lg font-black text-gray-200">${fmt(consumed)}</div>
          ${targets.intake_kcal != null ? `<div class="text-xs text-gray-500">/ ${fmt(targets.intake_kcal)} target</div>` : ''}
        </div>
        <div class="bg-gray-800 rounded-xl p-3">
          <div class="text-xs text-gray-400 mb-1">Net balance</div>
          <div class="text-lg font-black ${inDeficit ? 'text-emerald-400' : 'text-amber-400'}">${inDeficit ? '+' : ''}${fmt(net)}</div>
          <div class="text-xs ${inDeficit ? 'text-emerald-600' : 'text-amber-600'}">${inDeficit ? 'deficit' : 'surplus'}</div>
        </div>
      </div>
      ${targets.intake_kcal != null ? `
      <div class="mt-3 bg-gray-800 rounded-xl p-3">
        <div class="flex justify-between text-xs">
          <span class="text-gray-400">🎯 Calorie intake target</span>
          <span class="font-semibold text-gray-200">${fmt(targets.intake_kcal)} kcal/day</span>
        </div>
        <div class="w-full bg-gray-700 rounded-full h-1.5 mt-2">
          <div class="h-1.5 rounded-full ${consumed > targets.intake_kcal ? 'bg-amber-400' : 'bg-cyan-400'}"
            style="width:${Math.min(100, consumed / targets.intake_kcal * 100)}%"></div>
        </div>
        <p class="text-xs ${intakeRemaining >= 0 ? 'text-gray-500' : 'text-amber-500'} mt-1.5">
          ${intakeRemaining >= 0 ? `${fmt(intakeRemaining)} kcal remaining` : `${fmt(Math.abs(intakeRemaining))} kcal over target`}
        </p>
      </div>` : ''}
      <!-- Macros -->
      <div class="grid grid-cols-3 gap-2 mt-3 text-center">
        <div class="bg-gray-800 rounded-xl p-2.5">
          <div class="text-[10px] text-gray-500 mb-0.5">Protein</div>
          <div class="text-sm font-bold text-cyan-400">${protein.toFixed(1)}g</div>
        </div>
        <div class="bg-gray-800 rounded-xl p-2.5">
          <div class="text-[10px] text-gray-500 mb-0.5">Carbs</div>
          <div class="text-sm font-bold text-amber-400">${carbsG.toFixed(1)}g</div>
        </div>
        <div class="bg-gray-800 rounded-xl p-2.5">
          <div class="text-[10px] text-gray-500 mb-0.5">Fat</div>
          <div class="text-sm font-bold text-violet-400">${fatG.toFixed(1)}g</div>
        </div>
      </div>
      ${tdee > 0 ? `<p class="text-xs text-gray-600 text-center mt-2">Your TDEE goal: ${fmt(tdee)} kcal/day</p>` : ''}
    </div>

    <!-- Log Fitness -->
    <div class="bg-gray-900 border border-gray-800 rounded-3xl p-5">
      <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Log Fitness Activity</p>
      <button onclick="triggerFitnessUpload()"
        class="w-full py-3.5 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 hover:border-cyan-500/60
               rounded-2xl text-sm font-semibold text-cyan-400 transition-all flex items-center justify-center gap-2">
        📸 Upload Health App Screenshot
      </button>
      <p class="text-xs text-gray-600 text-center mt-2">AI extracts steps, active & resting calories, and water</p>
      <button onclick="editFitnessManually()"
        class="w-full mt-2 py-2.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-2xl text-xs font-semibold text-gray-300 transition-colors">
        ✏️ Enter Manually
      </button>
      <input id="fitness-file" type="file" accept="image/*" class="hidden"/>

      <!-- Quick water -->
      <div class="mt-4 pt-4 border-t border-gray-800">
        <p class="text-xs text-gray-500 mb-2 font-medium">Quick add water</p>
        <div class="grid grid-cols-4 gap-2">
          ${[250,330,500,750].map(ml => `
            <button onclick="logWater(${ml})"
              class="py-2 rounded-xl bg-gray-800 hover:bg-emerald-500/20 border border-gray-700 hover:border-emerald-500/40
                     text-xs font-semibold text-gray-300 hover:text-emerald-400 transition-all">
              +${ml}ml
            </button>`).join('')}
        </div>
      </div>

      <!-- Quick weight log -->
      <div class="mt-4 pt-4 border-t border-gray-800 flex items-center justify-between">
        <p class="text-xs text-gray-500 font-medium">Body weight</p>
        <button onclick="openLogWeightModal()"
          class="text-xs bg-violet-500/10 hover:bg-violet-500/20 border border-violet-500/30 hover:border-violet-500/60
                 text-violet-400 font-semibold rounded-xl px-3 py-1.5 transition-colors">
          ⚖️ Log Weight
        </button>
      </div>
    </div>

    <!-- Log Food -->
    <div class="bg-gray-900 border border-gray-800 rounded-3xl p-5">
      <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Log Food</p>
      <div class="grid grid-cols-2 gap-2">
        <button onclick="triggerFoodPhoto()"
          class="py-3 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 hover:border-amber-500/60
                 rounded-2xl text-xs font-semibold text-amber-400 transition-all flex items-center justify-center gap-1.5">
          📷 Photo
        </button>
        <button onclick="toggleFoodText()"
          class="py-3 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-2xl text-xs font-semibold text-gray-300 transition-all flex items-center justify-center gap-1.5">
          ✏️ Text
        </button>
        <button onclick="addFoodManually()"
          class="py-3 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-2xl text-xs font-semibold text-gray-300 transition-all flex items-center justify-center gap-1.5">
          ➕ Manual
        </button>
        <button onclick="toggleFoodSearch()"
          class="py-3 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-2xl text-xs font-semibold text-gray-300 transition-all flex items-center justify-center gap-1.5">
          🔎 Quick Add
        </button>
      </div>
      <input id="food-photo-file" type="file" accept="image/*" capture="environment" class="hidden"/>

      <div id="food-text-area" class="hidden mt-3 space-y-2">
        <textarea id="food-text-input" rows="3"
          placeholder="e.g. 'oatmeal with banana and honey, a latte with oat milk'"
          class="w-full bg-gray-800 border border-gray-700 focus:border-amber-500/60 rounded-2xl px-4 py-3 text-sm
                 text-white placeholder-gray-500 outline-none transition-colors resize-none"></textarea>
        <button onclick="handleFoodTextSubmit()"
          class="w-full py-2.5 bg-amber-500 hover:bg-amber-400 text-white font-semibold rounded-xl text-sm transition-colors">
          Analyze Food
        </button>
      </div>

      <div id="food-search-area" class="hidden mt-3 space-y-2">
        <input id="food-search-input" type="text" oninput="renderFoodSearchPanel()"
          placeholder="Search saved foods, recent foods, meals…"
          class="w-full bg-gray-800 border border-gray-700 focus:border-cyan-500/60 rounded-2xl px-4 py-3 text-sm
                 text-white placeholder-gray-500 outline-none transition-colors"/>
        <div id="food-search-results" class="space-y-3"></div>
      </div>

      ${S.foodEntries.length > 0 ? `
      <div class="mt-4 pt-4 border-t border-gray-800">
        <div class="flex justify-between items-center mb-2">
          <p class="text-xs text-gray-400 font-medium">Today's log</p>
          <div class="flex items-center gap-3">
            <button onclick="openSaveMealModal()" class="text-xs text-cyan-400 hover:text-cyan-300 font-semibold transition-colors">💾 Save as Meal</button>
            <p class="text-xs text-amber-400 font-bold">${fmt(consumed)} kcal total</p>
          </div>
        </div>
        ${foodRows}
      </div>` : `<div class="mt-4 pt-4 border-t border-gray-800">${foodRows}</div>`}
    </div>

  </div>`  // end max-w-lg

  // Attach file input listeners
  document.getElementById('fitness-file')?.addEventListener('change', (e) => {
    if (e.target.files[0]) handleFitnessFile(e.target.files[0])
  })
  document.getElementById('food-photo-file')?.addEventListener('change', (e) => {
    if (e.target.files[0]) analyzeFood(e.target.files[0], e.target.files[0].type, null)
  })
}

// ─── TODAY HANDLERS ──────────────────────────────────────────
window.handleLogout = async () => { await supabase.auth.signOut() }

window.triggerFitnessUpload = () => document.getElementById('fitness-file').click()
window.triggerFoodPhoto     = () => document.getElementById('food-photo-file').click()
window.toggleFoodText = () => {
  const el = document.getElementById('food-text-area')
  el.classList.toggle('hidden')
  if (!el.classList.contains('hidden')) {
    document.getElementById('food-search-area')?.classList.add('hidden')
    document.getElementById('food-text-input').focus()
  }
}

window.toggleFoodSearch = async () => {
  const el = document.getElementById('food-search-area')
  el.classList.toggle('hidden')
  if (!el.classList.contains('hidden')) {
    document.getElementById('food-text-area')?.classList.add('hidden')
    if (!foodSearchLoaded) {
      document.getElementById('food-search-results').innerHTML = `<p class="text-xs text-gray-500 text-center py-4">Loading…</p>`
      await loadQuickAddData()
    }
    renderFoodSearchPanel()
  }
}
window.handleFoodTextSubmit = async () => {
  const text = document.getElementById('food-text-input')?.value.trim()
  if (!text) return
  await analyzeFood(null, null, text)
}
window.deleteFood = async (id) => {
  await supabase.from('food_entries').delete().eq('id', id)
  S.foodEntries = S.foodEntries.filter(f => f.id !== id)
  renderTodayTab()
  toast('Removed.')
}

// ─── Manual fitness metrics edit ─────────────────────────────
window.editFitnessManually = () => {
  const log = S.todayLog || {}
  const bodyHtml = `
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Steps</label>
        <input id="mf-steps" type="number" min="0" inputmode="numeric" value="${log.steps || 0}"
          class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors"/>
      </div>
      <div>
        <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Water (ml)</label>
        <input id="mf-water" type="number" min="0" inputmode="numeric" value="${log.water_ml || 0}"
          class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors"/>
      </div>
      <div>
        <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Active cal</label>
        <input id="mf-active" type="number" min="0" inputmode="numeric" value="${log.active_calories_burned || 0}"
          class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors"/>
      </div>
      <div>
        <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Resting cal</label>
        <input id="mf-resting" type="number" min="0" inputmode="numeric" value="${log.resting_calories || S.settings?.bmr_kcal || 0}"
          class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors"/>
      </div>
    </div>`

  confirmModal('Edit Metrics Manually', bodyHtml, async () => {
    const steps = Math.max(0, Math.round(+document.getElementById('mf-steps').value) || 0)
    const water_ml = Math.max(0, Math.round(+document.getElementById('mf-water').value) || 0)
    const active_calories_burned = Math.max(0, Math.round(+document.getElementById('mf-active').value) || 0)
    const resting_calories = Math.max(0, Math.round(+document.getElementById('mf-resting').value) || 0)
    try {
      const log = await getOrCreateLog()
      const { error } = await supabase.from('daily_logs').update({
        steps, active_calories_burned, resting_calories, water_ml
      }).eq('id', log.id)
      if (error) throw error
      S.todayLog = { ...log, steps, active_calories_burned, resting_calories, water_ml }
      toast('Metrics updated ✏️')
      renderTodayTab()
    } catch (err) {
      toast('Failed to save. Try again.', false)
      console.error(err)
    }
  }, 'Save')
}

// ─── Edit an existing food entry ─────────────────────────────
window.editFood = (id) => {
  const f = S.foodEntries.find(x => x.id === id)
  if (!f) return
  const bodyHtml = `
    <div class="space-y-3">
      <div>
        <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Food name</label>
        <input id="ef-name" type="text" value="${(f.food_name || '').replace(/"/g, '&quot;')}"
          class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors"/>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Calories</label>
          <input id="ef-cal" type="number" min="0" inputmode="numeric" value="${f.calories || 0}"
            class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors"/>
        </div>
        <div>
          <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Protein (g)</label>
          <input id="ef-protein" type="number" min="0" step="0.1" inputmode="decimal" value="${f.protein_g || 0}"
            class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors"/>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Carbs (g)</label>
          <input id="ef-carbs" type="number" min="0" step="0.1" inputmode="decimal" value="${f.carbs_g || 0}"
            class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors"/>
        </div>
        <div>
          <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Fat (g)</label>
          <input id="ef-fat" type="number" min="0" step="0.1" inputmode="decimal" value="${f.fat_g || 0}"
            class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors"/>
        </div>
      </div>
    </div>`

  confirmModal('Edit Food Entry', bodyHtml, async () => {
    const food_name = document.getElementById('ef-name').value.trim()
    const calories = Math.max(0, Math.round(+document.getElementById('ef-cal').value) || 0)
    const protein_g = Math.max(0, +document.getElementById('ef-protein').value || 0)
    const carbs_g = Math.max(0, +document.getElementById('ef-carbs').value || 0)
    const fat_g = Math.max(0, +document.getElementById('ef-fat').value || 0)
    if (!food_name) { toast('Food name is required.', false); return }
    try {
      const { error } = await supabase.from('food_entries')
        .update({ food_name, calories, protein_g, carbs_g, fat_g })
        .eq('id', id)
      if (error) throw error
      S.foodEntries = S.foodEntries.map(x => x.id === id ? { ...x, food_name, calories, protein_g, carbs_g, fat_g } : x)
      toast('Food entry updated ✏️')
      renderTodayTab()
    } catch (err) {
      toast('Failed to update. Try again.', false)
      console.error(err)
    }
  }, 'Save')
}

// ─── Add a food entry manually (no AI call) ──────────────────
window.addFoodManually = () => {
  const bodyHtml = `
    <div class="space-y-3">
      <div>
        <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Food name</label>
        <input id="mf-name" type="text" placeholder="e.g. Grilled chicken breast"
          class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-amber-500 transition-colors placeholder-gray-500"/>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Calories</label>
          <input id="mf-food-cal" type="number" min="0" inputmode="numeric" placeholder="0"
            class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-amber-500 transition-colors placeholder-gray-500"/>
        </div>
        <div>
          <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Protein (g)</label>
          <input id="mf-food-protein" type="number" min="0" step="0.1" inputmode="decimal" placeholder="0"
            class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-amber-500 transition-colors placeholder-gray-500"/>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Carbs (g)</label>
          <input id="mf-food-carbs" type="number" min="0" step="0.1" inputmode="decimal" placeholder="0"
            class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-amber-500 transition-colors placeholder-gray-500"/>
        </div>
        <div>
          <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Fat (g)</label>
          <input id="mf-food-fat" type="number" min="0" step="0.1" inputmode="decimal" placeholder="0"
            class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-amber-500 transition-colors placeholder-gray-500"/>
        </div>
      </div>
    </div>`

  confirmModal('Add Food Manually', bodyHtml, async () => {
    const food_name = document.getElementById('mf-name').value.trim()
    const calories = Math.max(0, Math.round(+document.getElementById('mf-food-cal').value) || 0)
    const protein_g = Math.max(0, +document.getElementById('mf-food-protein').value || 0)
    const carbs_g = Math.max(0, +document.getElementById('mf-food-carbs').value || 0)
    const fat_g = Math.max(0, +document.getElementById('mf-food-fat').value || 0)
    if (!food_name) { toast('Food name is required.', false); return }
    try {
      const log = await getOrCreateLog()
      const { error } = await supabase.from('food_entries').insert({
        log_id: log.id, user_id: S.user.id, food_name, calories, protein_g, carbs_g, fat_g
      })
      if (error) throw error
      await loadUserData()
      toast('Food added ✏️')
      renderTodayTab()
    } catch (err) {
      toast('Failed to save food. Try again.', false)
      console.error(err)
    }
  }, 'Add')
}

// ─── Quick Add: saved foods, recent foods, meals ──────────────
function renderFoodSearchPanel() {
  const container = document.getElementById('food-search-results')
  if (!container) return
  const q = (document.getElementById('food-search-input')?.value || '').trim().toLowerCase()

  const matchesQ = (name) => !q || name.toLowerCase().includes(q)

  const meals = S.savedMeals.filter(m => matchesQ(m.name))
  const saved = S.savedFoods.filter(f => matchesQ(f.food_name))
  const recent = S.recentFoods.filter(f => matchesQ(f.food_name))

  if (!meals.length && !saved.length && !recent.length) {
    container.innerHTML = `<p class="text-sm text-gray-500 text-center py-4">${q ? 'No matches.' : 'Nothing saved yet — save foods or meals to see them here.'}</p>`
    return
  }

  const section = (title, rows) => rows.length ? `
    <div>
      <p class="text-[11px] text-gray-500 font-semibold uppercase tracking-wide mb-1.5">${title}</p>
      <div class="space-y-1.5">${rows}</div>
    </div>` : ''

  const mealRows = meals.map(m => {
    const kcal = (m.items || []).reduce((s, i) => s + (i.calories || 0), 0)
    return `
    <div class="flex items-center justify-between gap-2 bg-gray-800 rounded-xl px-3 py-2.5">
      <button onclick="quickLogMeal('${m.id}')" class="flex-1 min-w-0 text-left">
        <div class="text-sm text-gray-200 truncate">${m.name}</div>
        <div class="text-[11px] text-gray-500">${(m.items || []).length} items · ${fmt(kcal)} kcal</div>
      </button>
      <button onclick="deleteMeal('${m.id}')" class="text-gray-600 hover:text-red-400 transition-colors w-5 shrink-0 text-center">×</button>
    </div>`
  }).join('')

  const savedRows = saved.map((f, i) => `
    <div class="flex items-center justify-between gap-2 bg-gray-800 rounded-xl px-3 py-2.5">
      <button onclick="quickLogSaved('${f.id}')" class="flex-1 min-w-0 text-left">
        <div class="text-sm text-gray-200 truncate">${f.food_name}</div>
        <div class="text-[11px] text-gray-500">${fmt(f.calories)} kcal · ${(f.protein_g||0).toFixed(1)}P / ${(f.carbs_g||0).toFixed(1)}C / ${(f.fat_g||0).toFixed(1)}F</div>
      </button>
      <button onclick="deleteSavedFood('${f.id}')" class="text-gray-600 hover:text-red-400 transition-colors w-5 shrink-0 text-center">×</button>
    </div>`).join('')

  const recentRows = recent.map(f => `
    <div class="flex items-center justify-between gap-2 bg-gray-800 rounded-xl px-3 py-2.5">
      <button onclick="quickLogRecent('${f.id}')" class="flex-1 min-w-0 text-left">
        <div class="text-sm text-gray-200 truncate">${f.food_name}</div>
        <div class="text-[11px] text-gray-500">${fmt(f.calories)} kcal · ${(f.protein_g||0).toFixed(1)}P / ${(f.carbs_g||0).toFixed(1)}C / ${(f.fat_g||0).toFixed(1)}F</div>
      </button>
    </div>`).join('')

  container.innerHTML = section('Meals', mealRows) + section('Saved foods', savedRows) + section('Recent', recentRows)
}

async function logFoodItem({ food_name, calories, protein_g, carbs_g, fat_g }) {
  try {
    const log = await getOrCreateLog()
    const { error } = await supabase.from('food_entries').insert({
      log_id: log.id, user_id: S.user.id,
      food_name, calories: calories || 0, protein_g: protein_g || 0, carbs_g: carbs_g || 0, fat_g: fat_g || 0
    })
    if (error) throw error
    await loadUserData()
    toast(`${food_name} logged 🥗`)
    renderTodayTab()
  } catch (err) {
    toast('Failed to log food. Try again.', false)
    console.error(err)
  }
}

window.quickLogSaved = async (id) => {
  const f = S.savedFoods.find(x => x.id === id)
  if (!f) return
  await logFoodItem(f)
}

window.quickLogRecent = async (id) => {
  const f = S.recentFoods.find(x => x.id === id)
  if (!f) return
  await logFoodItem(f)
}

window.quickLogMeal = async (mealId) => {
  const meal = S.savedMeals.find(m => m.id === mealId)
  if (!meal || !meal.items?.length) return
  try {
    const log = await getOrCreateLog()
    const rows = meal.items.map(i => ({
      log_id: log.id, user_id: S.user.id,
      food_name: i.food_name, calories: i.calories || 0,
      protein_g: i.protein_g || 0, carbs_g: i.carbs_g || 0, fat_g: i.fat_g || 0
    }))
    const { error } = await supabase.from('food_entries').insert(rows)
    if (error) throw error
    await loadUserData()
    toast(`${meal.name} logged 🍽️`)
    renderTodayTab()
  } catch (err) {
    toast('Failed to log meal. Try again.', false)
    console.error(err)
  }
}

window.deleteSavedFood = async (id) => {
  try {
    const { error } = await supabase.from('saved_foods').delete().eq('id', id)
    if (error) throw error
    S.savedFoods = S.savedFoods.filter(f => f.id !== id)
    renderFoodSearchPanel()
    toast('Removed from saved foods.')
  } catch (err) {
    toast('Failed to remove. Try again.', false)
    console.error(err)
  }
}

window.deleteMeal = async (id) => {
  try {
    const { error } = await supabase.from('meals').delete().eq('id', id)
    if (error) throw error
    S.savedMeals = S.savedMeals.filter(m => m.id !== id)
    renderFoodSearchPanel()
    toast('Meal deleted.')
  } catch (err) {
    toast('Failed to delete meal. Try again.', false)
    console.error(err)
  }
}

// Save an AI-analyzed food item (from analyzeFood's confirm modal) into the saved_foods library
window.saveFoodToLibrary = async (idx) => {
  const item = lastAnalyzedFoodItems[idx]
  if (!item) return
  try {
    const { error } = await supabase.from('saved_foods').upsert({
      user_id: S.user.id,
      food_name: item.food_name,
      calories: item.calories || 0,
      protein_g: item.protein_g || 0,
      carbs_g: item.carbs_g || 0,
      fat_g: item.fat_g || 0
    }, { onConflict: 'user_id,food_name' })
    if (error) throw error
    const btn = document.getElementById(`save-food-${idx}`)
    if (btn) { btn.textContent = '✓ Saved'; btn.disabled = true }
    toast(`${item.food_name} saved to your library 💾`)
  } catch (err) {
    toast('Failed to save food. Try again.', false)
    console.error(err)
  }
}

// Save today's food entries as a named, re-loggable meal
window.openSaveMealModal = () => {
  if (!S.foodEntries.length) { toast('No food logged today to save.', false); return }
  const rows = S.foodEntries.map(f => `
    <label class="flex items-center gap-2.5 py-1.5">
      <input type="checkbox" class="sm-item-check w-4 h-4 accent-cyan-500" value="${f.id}" checked/>
      <span class="text-sm text-gray-200 flex-1 truncate">${f.food_name}</span>
      <span class="text-xs text-gray-500">${fmt(f.calories)} kcal</span>
    </label>`).join('')

  const bodyHtml = `
    <div class="space-y-3">
      <div>
        <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Meal name</label>
        <input id="sm-name" type="text" placeholder="e.g. My usual breakfast"
          class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors placeholder-gray-500"/>
      </div>
      <div>
        <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Include</label>
        <div class="mt-1 bg-gray-800 rounded-xl px-3 py-1 divide-y divide-gray-700">${rows}</div>
      </div>
    </div>`

  confirmModal('Save as Meal', bodyHtml, async () => {
    const name = document.getElementById('sm-name').value.trim()
    if (!name) { toast('Meal name is required.', false); return }
    const checked = [...document.querySelectorAll('.sm-item-check:checked')].map(el => el.value)
    if (!checked.length) { toast('Select at least one food item.', false); return }
    try {
      const { data: meal, error: mealErr } = await supabase.from('meals')
        .insert({ user_id: S.user.id, name }).select().single()
      if (mealErr) throw mealErr

      const items = S.foodEntries.filter(f => checked.includes(f.id)).map(f => ({
        meal_id: meal.id, user_id: S.user.id,
        food_name: f.food_name, calories: f.calories || 0,
        protein_g: f.protein_g || 0, carbs_g: f.carbs_g || 0, fat_g: f.fat_g || 0
      }))
      const { error: itemsErr } = await supabase.from('meal_items').insert(items)
      if (itemsErr) throw itemsErr

      foodSearchLoaded = false // force reload of quick-add data next time it's opened
      toast(`"${name}" saved as a meal 💾`)
    } catch (err) {
      toast('Failed to save meal. Try again.', false)
      console.error(err)
    }
  }, 'Save Meal')
}

window.logWater = async (ml) => {
  try {
    const log = await getOrCreateLog()
    const newVal = (log.water_ml || 0) + ml
    const { error } = await supabase.from('daily_logs')
      .update({ water_ml: newVal })
      .eq('id', log.id)
    if (error) throw error
    S.todayLog = { ...log, water_ml: newVal }
    toast(`+${ml}ml water logged 💧`)
    renderTodayTab()
  } catch (err) {
    toast('Failed to log water. Try again.', false)
    console.error(err)
  }
}

async function handleFitnessFile(file) {
  showSpinner('AI is reading your screenshot…')
  try {
    const b64 = await toBase64(file)
    const res = await fetch(ANALYZE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'fitness', image: b64, mimeType: file.type })
    })
    const parsed = await res.json()
    hideSpinner()

    if (parsed.error) { toast('Could not read screenshot. Try again.', false); return }

    const { steps = 0, active_calories_burned = 0, resting_calories = 0, water_ml = 0 } = parsed

    const bodyHtml = `
      <div class="bg-gray-800 rounded-2xl p-4 space-y-2.5 text-sm">
        <div class="flex justify-between"><span class="text-gray-400">Steps</span><span class="font-bold text-cyan-400">${fmt(steps)}</span></div>
        <div class="flex justify-between"><span class="text-gray-400">Active calories</span><span class="font-bold text-amber-400">${fmt(active_calories_burned)} kcal</span></div>
        <div class="flex justify-between"><span class="text-gray-400">Resting calories</span><span class="font-bold text-emerald-400">${fmt(resting_calories)} kcal</span></div>
        <div class="flex justify-between"><span class="text-gray-400">Water</span><span class="font-bold text-blue-400">${fmt(water_ml)} ml</span></div>
      </div>
      <p class="text-xs text-gray-500">This will update today's fitness metrics.</p>`

    confirmModal('AI Detected Metrics', bodyHtml, async () => {
      try {
        const log = await getOrCreateLog()
        // Use screenshot values; if resting=0 from screenshot, keep existing BMR
        const newResting = resting_calories > 0 ? resting_calories : (log.resting_calories || S.settings?.bmr_kcal || 0)
        const { error } = await supabase.from('daily_logs').update({
          steps, active_calories_burned, resting_calories: newResting, water_ml
        }).eq('id', log.id)
        if (error) throw error
        S.todayLog = { ...log, steps, active_calories_burned, resting_calories: newResting, water_ml }
        toast('Fitness metrics saved! 🎯')
        renderTodayTab()
      } catch (err) {
        toast('Failed to save. Try again.', false)
        console.error(err)
      }
    }, 'Save Metrics')
  } catch (err) {
    hideSpinner()
    toast('Failed to contact AI. Check your connection.', false)
    console.error(err)
  }
}

async function analyzeFood(file, mimeType, text) {
  showSpinner('AI is analyzing your food…')
  try {
    const body = { type: 'food', userContext: buildUserContext() }
    if (file) { body.image = await toBase64(file); body.mimeType = mimeType }
    else body.text = text

    const res = await fetch(ANALYZE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const items = await res.json()
    hideSpinner()

    if (!Array.isArray(items) || items.length === 0) {
      toast('No food items detected. Try again.', false); return
    }

    lastAnalyzedFoodItems = items

    const rows = items.map((i, idx) => `
      <div class="flex justify-between items-center gap-2 py-2 border-b border-gray-800 last:border-0 text-sm">
        <div class="flex-1 min-w-0">
          <div class="font-medium truncate">${i.food_name}</div>
          <div class="text-gray-400 text-xs">${fmt(i.calories)} kcal · ${(i.protein_g||0).toFixed(1)}P / ${(i.carbs_g||0).toFixed(1)}C / ${(i.fat_g||0).toFixed(1)}F</div>
        </div>
        <button id="save-food-${idx}" onclick="saveFoodToLibrary(${idx})"
          class="shrink-0 text-xs px-2.5 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-gray-300 transition-colors">💾 Save</button>
      </div>`).join('')
    const total = items.reduce((s, i) => s + (i.calories || 0), 0)
    const totalP = items.reduce((s, i) => s + (i.protein_g || 0), 0)
    const totalC = items.reduce((s, i) => s + (i.carbs_g || 0), 0)
    const totalF = items.reduce((s, i) => s + (i.fat_g || 0), 0)

    const bodyHtml = `
      <div class="bg-gray-800 rounded-2xl p-3 max-h-56 overflow-y-auto">${rows}</div>
      <div class="flex justify-between text-sm pt-1">
        <span class="text-gray-400">Total</span>
        <span class="font-bold text-amber-400">${fmt(total)} kcal</span>
      </div>
      <div class="text-xs text-gray-500 text-right">${totalP.toFixed(1)}g protein · ${totalC.toFixed(1)}g carbs · ${totalF.toFixed(1)}g fat</div>`

    confirmModal('🍎 AI Found These Items', bodyHtml, async () => {
      try {
        const log = await getOrCreateLog()
        const rows = items.map(i => ({
          log_id: log.id, user_id: S.user.id,
          food_name: i.food_name, calories: i.calories || 0, protein_g: i.protein_g || 0,
          carbs_g: i.carbs_g || 0, fat_g: i.fat_g || 0
        }))
        const { error } = await supabase.from('food_entries').insert(rows)
        if (error) throw error
        await loadUserData()
        toast('Food logged! 🥗')
        renderTodayTab()
      } catch (err) {
        toast('Failed to save food. Try again.', false)
        console.error(err)
      }
    }, 'Add to Log')
  } catch (err) {
    hideSpinner()
    toast('Failed to analyze food.', false)
    console.error(err)
  }
}

// ─── ═══════════════════════════════════════════════════════ ─
//     HISTORY TAB
// ─── ═══════════════════════════════════════════════════════ ─
async function renderHistoryTab() {
  const content = document.getElementById('tab-content')
  content.innerHTML = `<div class="max-w-lg mx-auto px-5 pt-5 flex items-center justify-center h-40">
    <div class="w-8 h-8 border-4 border-cyan-400 border-t-transparent rounded-full animate-spin"></div></div>`

  await Promise.all([loadHistoryData(), loadWeightData()])

  const logs = S.historyLogs
  const food = S.historyFood
  const weightCard = renderWeightCard()
  const trendsCard = renderTrendsCard()

  if (logs.length === 0) {
    content.innerHTML = `<div class="max-w-lg mx-auto px-5 pt-5 pb-4 space-y-4">
      ${weightCard}
      ${trendsCard}
      <div class="text-center text-gray-500 pt-6">
        <div class="text-4xl mb-3">📭</div><p>No history yet. Start logging today!</p>
      </div>
    </div>`
    initWeightChart()
    await loadAndRenderTrends()
    return
  }

  const cards = logs.map(log => {
    const logFood = food.filter(f => f.log_id === log.id)
    const consumed = logFood.reduce((s, f) => s + (f.calories || 0), 0)
    const protein  = logFood.reduce((s, f) => s + (f.protein_g || 0), 0)
    const carbsG   = logFood.reduce((s, f) => s + (f.carbs_g || 0), 0)
    const fatG     = logFood.reduce((s, f) => s + (f.fat_g || 0), 0)
    const totalBurned = (log.active_calories_burned || 0) + (log.resting_calories || 0)
    const net = totalBurned - consumed
    const isToday = log.date === getToday()

    return `
    <div class="bg-gray-900 border border-gray-800 rounded-3xl p-5 space-y-3">
      <div class="flex justify-between items-start">
        <div>
          <p class="font-bold text-sm">${fmtShortDate(log.date)}</p>
          ${isToday ? '<span class="text-xs text-cyan-400 font-semibold">Today</span>' : ''}
        </div>
        <span class="text-sm font-bold ${net >= 0 ? 'text-emerald-400' : 'text-amber-400'}">${net >= 0 ? '+' : ''}${fmt(net)} kcal net</span>
      </div>
      <div class="grid grid-cols-4 gap-2 text-center text-xs">
        <div class="bg-gray-800 rounded-xl p-2">
          <div class="font-bold text-cyan-400 text-sm">${fmt(log.steps)}</div>
          <div class="text-gray-500">steps</div>
        </div>
        <div class="bg-gray-800 rounded-xl p-2">
          <div class="font-bold text-amber-400 text-sm">${fmt(log.active_calories_burned)}</div>
          <div class="text-gray-500">active cal</div>
        </div>
        <div class="bg-gray-800 rounded-xl p-2">
          <div class="font-bold text-gray-200 text-sm">${fmt(consumed)}</div>
          <div class="text-gray-500">consumed</div>
        </div>
        <div class="bg-gray-800 rounded-xl p-2">
          <div class="font-bold text-emerald-400 text-sm">${log.water_ml >= 1000 ? (log.water_ml/1000).toFixed(1)+'L' : (log.water_ml||0)+'ml'}</div>
          <div class="text-gray-500">water</div>
        </div>
      </div>
      ${logFood.length > 0 ? `
      <div class="border-t border-gray-800 pt-3 space-y-1">
        ${logFood.slice(0,4).map(f => `
          <div class="flex justify-between text-xs text-gray-400">
            <span>${f.food_name}</span><span>${fmt(f.calories)} kcal · ${(f.protein_g||0).toFixed(1)}P / ${(f.carbs_g||0).toFixed(1)}C / ${(f.fat_g||0).toFixed(1)}F</span>
          </div>`).join('')}
        ${logFood.length > 4 ? `<p class="text-xs text-gray-600">+${logFood.length - 4} more items</p>` : ''}
        <div class="flex justify-between text-xs text-gray-500 border-t border-gray-800 pt-1.5 mt-1.5">
          <span>Day total macros</span>
          <span>${protein.toFixed(1)}g P · ${carbsG.toFixed(1)}g C · ${fatG.toFixed(1)}g F</span>
        </div>
      </div>` : ''}
    </div>`
  }).join('')

  content.innerHTML = `<div class="max-w-lg mx-auto px-5 pt-5 pb-4 space-y-4">
    ${weightCard}
    ${trendsCard}
    <p class="text-xs text-gray-500 font-medium">Last 7 days</p>${cards}</div>`
  initWeightChart()
  await loadAndRenderTrends()
}

// ─── Trend charts (steps / calories in vs out / net balance) ─
function renderTrendsCard() {
  return `
  <div class="bg-gray-900 border border-gray-800 rounded-3xl p-5">
    <div class="flex items-center justify-between mb-3">
      <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Trends</p>
      <div class="flex gap-1.5">
        ${[7, 30, 90].map(d => `
          <button onclick="setTrendsRange(${d})" data-range="${d}"
            class="trends-range-btn px-2.5 py-1 text-xs font-semibold rounded-lg transition-colors
                   ${trendsRangeDays === d ? 'bg-cyan-500 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}">
            ${d}D
          </button>`).join('')}
      </div>
    </div>
    <div id="trends-charts">
      <p class="text-xs text-gray-500 text-center py-8">Loading…</p>
    </div>
  </div>`
}

function chartAxisOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: '#9ca3af', font: { size: 10 }, boxWidth: 10 } } },
    scales: {
      x: { ticks: { color: '#6b7280', font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 }, grid: { color: '#1f2937' } },
      y: { ticks: { color: '#6b7280', font: { size: 9 } }, grid: { color: '#1f2937' } },
    },
  }
}

async function loadAndRenderTrends() {
  const container = document.getElementById('trends-charts')
  if (!container) return

  const rows = await loadTrendsData(trendsRangeDays)

  if (rows.length < 2) {
    container.innerHTML = `<p class="text-xs text-gray-600 text-center py-8">Not enough data yet for this range.</p>`
    return
  }

  container.innerHTML = `
    <div class="space-y-4">
      <div>
        <p class="text-[11px] text-gray-500 mb-1">👟 Steps</p>
        <div class="h-36"><canvas id="steps-chart-canvas"></canvas></div>
      </div>
      <div>
        <p class="text-[11px] text-gray-500 mb-1">🍽️ Calories In vs Out</p>
        <div class="h-36"><canvas id="calorie-chart-canvas"></canvas></div>
      </div>
      <div>
        <p class="text-[11px] text-gray-500 mb-1">⚖️ Net Balance</p>
        <div class="h-36"><canvas id="net-chart-canvas"></canvas></div>
      </div>
    </div>`

  drawTrendCharts(rows)
}

function drawTrendCharts(rows) {
  if (typeof Chart === 'undefined') return

  if (stepsChartInstance)   { stepsChartInstance.destroy();   stepsChartInstance = null }
  if (calorieChartInstance) { calorieChartInstance.destroy(); calorieChartInstance = null }
  if (netChartInstance)     { netChartInstance.destroy();     netChartInstance = null }

  const labels = rows.map(r => fmtShortDate(r.date))
  const thin = rows.length > 30 ? 0 : 2 // hide point markers on dense (30/90-day) ranges

  const stepsCanvas = document.getElementById('steps-chart-canvas')
  if (stepsCanvas) {
    stepsChartInstance = new Chart(stepsCanvas.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Steps', data: rows.map(r => r.steps),
          borderColor: '#22D3EE', backgroundColor: '#22D3EE',
          pointRadius: thin, tension: 0.25,
        }],
      },
      options: chartAxisOptions(),
    })
  }

  const calCanvas = document.getElementById('calorie-chart-canvas')
  if (calCanvas) {
    calorieChartInstance = new Chart(calCanvas.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Consumed', data: rows.map(r => r.consumed), borderColor: '#FBBF24', backgroundColor: '#FBBF24', pointRadius: thin, tension: 0.25 },
          { label: 'Burned',   data: rows.map(r => r.burned),   borderColor: '#34D399', backgroundColor: '#34D399', pointRadius: thin, tension: 0.25 },
        ],
      },
      options: chartAxisOptions(),
    })
  }

  const netCanvas = document.getElementById('net-chart-canvas')
  if (netCanvas) {
    netChartInstance = new Chart(netCanvas.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Net (burned − consumed)', data: rows.map(r => r.net), borderColor: '#A78BFA', backgroundColor: '#A78BFA', pointRadius: thin, tension: 0.25 },
        ],
      },
      options: chartAxisOptions(),
    })
  }
}

// Switches the trends range without reloading the rest of the History tab.
window.setTrendsRange = (days) => {
  trendsRangeDays = days
  document.querySelectorAll('.trends-range-btn').forEach(btn => {
    const active = +btn.dataset.range === days
    btn.classList.toggle('bg-cyan-500', active)
    btn.classList.toggle('text-white', active)
    btn.classList.toggle('bg-gray-800', !active)
    btn.classList.toggle('text-gray-400', !active)
  })
  loadAndRenderTrends()
}

// ─── Weight trend card + chart ────────────────────────────────
function renderWeightCard() {
  const rows = S.weightHistory || []
  const latest = rows[rows.length - 1]
  return `
  <div class="bg-gray-900 border border-gray-800 rounded-3xl p-5">
    <div class="flex items-center justify-between mb-3 gap-2">
      <div>
        <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Weight Trend</p>
        ${latest ? `<p class="text-lg font-black text-white mt-1">${latest.weight_kg}kg <span class="text-xs text-gray-500 font-normal">on ${fmtShortDate(latest.date)}</span></p>` : ''}
      </div>
      <button onclick="openLogWeightModal()"
        class="shrink-0 px-3 py-1.5 text-xs bg-violet-500/10 hover:bg-violet-500/20 border border-violet-500/30 hover:border-violet-500/60
               rounded-xl font-semibold text-violet-400 transition-colors">
        ⚖️ Log Weight
      </button>
    </div>
    ${rows.length >= 2
      ? `<div class="h-48"><canvas id="weight-chart-canvas"></canvas></div>`
      : `<p class="text-xs text-gray-600 text-center py-6">Log weight on at least 2 different days to see your trend line.</p>`}
  </div>`
}

// Trailing moving average over the last N *logged entries* (not calendar days —
// weight is often logged sporadically, so we average over the last N data points
// actually on record rather than assuming an entry exists for every day).
function movingAverage(values, windowSize = 7) {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - windowSize + 1), i + 1)
    return slice.reduce((s, v) => s + v, 0) / slice.length
  })
}

function initWeightChart() {
  const canvas = document.getElementById('weight-chart-canvas')
  if (!canvas || typeof Chart === 'undefined') return
  if (weightChartInstance) { weightChartInstance.destroy(); weightChartInstance = null }

  const rows = S.weightHistory || []
  const labels = rows.map(r => fmtShortDate(r.date))
  const weights = rows.map(r => r.weight_kg)
  const avg = movingAverage(weights, 7)

  weightChartInstance = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Weight (kg)',
          data: weights,
          borderColor: '#22D3EE',
          backgroundColor: '#22D3EE',
          pointRadius: 3,
          pointHoverRadius: 5,
          tension: 0.25,
        },
        {
          label: '7-entry avg',
          data: avg,
          borderColor: '#FBBF24',
          backgroundColor: '#FBBF24',
          borderDash: [5, 4],
          pointRadius: 0,
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#9ca3af', font: { size: 11 }, boxWidth: 12 } },
      },
      scales: {
        x: { ticks: { color: '#6b7280', font: { size: 10 } }, grid: { color: '#1f2937' } },
        y: { ticks: { color: '#6b7280', font: { size: 10 } }, grid: { color: '#1f2937' } },
      },
    },
  })
}

// Opens a modal to log body weight for a given date (defaults to today).
// Upserts on (user_id, date) so re-logging the same day overwrites, not duplicates.
window.openLogWeightModal = () => {
  const today = getToday()
  const rows = S.weightHistory || []
  const lastWeight = rows.length ? rows[rows.length - 1].weight_kg : (S.settings?.weight_kg || '')

  const bodyHtml = `
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Date</label>
        <input id="wl-date" type="date" max="${today}" value="${today}"
          class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors"/>
      </div>
      <div>
        <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Weight (kg)</label>
        <input id="wl-weight" type="number" min="1" step="0.1" inputmode="decimal" value="${lastWeight}"
          class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors"/>
      </div>
    </div>`

  confirmModal('Log Weight', bodyHtml, async () => {
    const date = document.getElementById('wl-date').value || today
    const weight_kg = +document.getElementById('wl-weight').value

    if (!weight_kg || weight_kg <= 0) {
      toast('Enter a valid weight.', false); return
    }

    try {
      const { error } = await supabase.from('weight_logs')
        .upsert({ user_id: S.user.id, date, weight_kg }, { onConflict: 'user_id,date' })
      if (error) throw error

      toast('Weight logged ⚖️')
      if (activeTab === 'history') await renderHistoryTab()
    } catch (err) {
      toast('Failed to log weight. Try again.', false)
      console.error(err)
    }
  }, 'Save')
}

// ─── ═══════════════════════════════════════════════════════ ─
//     ADMIN VIEW
// ─── ═══════════════════════════════════════════════════════ ─
window.showAdminView = async () => {
  mount(`<div class="min-h-screen bg-gray-950 flex items-center justify-center">
    <div class="w-10 h-10 border-4 border-violet-500 border-t-transparent rounded-full animate-spin"></div></div>`)
  const data = await loadAdminData()
  renderAdmin(data)
}

function renderAdmin({ profiles, settings, logs, food }) {
  const today = getToday()
  const cards = profiles.map(p => {
    const log = logs.find(l => l.user_id === p.id) || {}
    const sts = settings.find(s => s.user_id === p.id)
    const logFood = food.filter(f => {
      const ml = logs.find(l => l.user_id === p.id)
      return ml && f.log_id === ml.id
    })
    const consumed    = logFood.reduce((s, f) => s + (f.calories || 0), 0)
    const proteinG    = logFood.reduce((s, f) => s + (f.protein_g || 0), 0)
    const carbsG      = logFood.reduce((s, f) => s + (f.carbs_g || 0), 0)
    const fatG        = logFood.reduce((s, f) => s + (f.fat_g || 0), 0)
    const totalBurned = (log.active_calories_burned || 0) + (log.resting_calories || 0)
    const net = totalBurned - consumed

    return `
    <div class="bg-gray-900 border border-gray-800 rounded-3xl p-5 space-y-3">
      <div class="flex justify-between items-center">
        <div>
          <p class="font-bold">${p.display_name}</p>
          ${p.role==='admin'?'<span class="text-xs text-violet-400 font-semibold">Admin</span>':''}
          ${sts ? `<p class="text-xs text-gray-500">${sts.goal} · ${sts.activity_level}</p>` : ''}
        </div>
        <div class="text-right">
          <div class="text-xs text-gray-500">Net today</div>
          <div class="font-bold ${net>=0?'text-emerald-400':'text-amber-400'}">${net>=0?'+':''}${fmt(net)} kcal</div>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-2 text-sm">
        <div class="bg-gray-800 rounded-xl p-3"><div class="text-xs text-gray-400">Steps</div>
          <div class="font-bold text-cyan-400">${fmt(log.steps)}</div>
          <div class="w-full bg-gray-700 rounded-full h-1 mt-1"><div class="bg-cyan-400 h-1 rounded-full" style="width:${Math.min(100,(log.steps||0)/TARGETS.steps*100)}%"></div></div></div>
        <div class="bg-gray-800 rounded-xl p-3"><div class="text-xs text-gray-400">Active cal</div>
          <div class="font-bold text-amber-400">${fmt(log.active_calories_burned)} kcal</div></div>
        <div class="bg-gray-800 rounded-xl p-3"><div class="text-xs text-gray-400">Consumed</div>
          <div class="font-bold text-gray-200">${fmt(consumed)} kcal</div></div>
        <div class="bg-gray-800 rounded-xl p-3"><div class="text-xs text-gray-400">Water</div>
          <div class="font-bold text-emerald-400">${(log.water_ml||0)>=1000?((log.water_ml||0)/1000).toFixed(1)+'L':(log.water_ml||0)+'ml'}</div>
          <div class="w-full bg-gray-700 rounded-full h-1 mt-1"><div class="bg-emerald-400 h-1 rounded-full" style="width:${Math.min(100,(log.water_ml||0)/TARGETS.water_ml*100)}%"></div></div></div>
      </div>
      ${logFood.length>0?`<div class="border-t border-gray-800 pt-3 space-y-1">
        ${logFood.map(f=>`<div class="flex justify-between text-xs text-gray-400"><span>${f.food_name}</span><span>${fmt(f.calories)} kcal · ${(f.protein_g||0).toFixed(1)}P/${(f.carbs_g||0).toFixed(1)}C/${(f.fat_g||0).toFixed(1)}F</span></div>`).join('')}
        <div class="flex justify-between text-xs text-gray-500 border-t border-gray-800 pt-1.5 mt-1.5">
          <span>Day total macros</span><span>${proteinG.toFixed(1)}g P · ${carbsG.toFixed(1)}g C · ${fatG.toFixed(1)}g F</span>
        </div></div>`
        :'<p class="text-xs text-gray-600 text-center">No food logged today.</p>'}
    </div>`
  }).join('')

  mount(`
  <div class="min-h-screen bg-gray-950 text-white pb-8">
    <div class="sticky top-0 bg-gray-950/90 backdrop-blur-md border-b border-gray-800 px-5 py-4 flex items-center justify-between">
      <div><p class="text-xs text-gray-400">${fmtDate()}</p>
        <h1 class="font-bold text-base">Family Overview 👨‍👩‍👧‍👦</h1></div>
      <div class="flex gap-2">
        <button onclick="showAdminView()" class="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 rounded-xl font-semibold">Refresh ↻</button>
        <button onclick="backToDashboard()" class="px-3 py-1.5 text-xs bg-cyan-600 hover:bg-cyan-500 rounded-xl font-semibold">My Dashboard</button>
      </div>
    </div>
    <div class="max-w-lg mx-auto px-5 pt-5 space-y-4">
      <p class="text-xs text-gray-500">${profiles.length} member${profiles.length!==1?'s':''} · today</p>
      ${cards || '<p class="text-gray-500 text-center py-12">No family members yet.</p>'}
    </div>
  </div>`)
}

window.backToDashboard = async () => {
  await loadUserData()
  renderLayout()
}

// ─── ═══════════════════════════════════════════════════════ ─
//     SETTINGS (personalized daily targets)
// ─── ═══════════════════════════════════════════════════════ ─
// ─── Data export (CSV) ──────────────────────────────────────
function rowsToCSV(rows) {
  if (!rows.length) return ''
  const headers = Object.keys(rows[0])
  const escape = (val) => {
    if (val === null || val === undefined) return ''
    const s = String(val)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [headers.join(',')]
  for (const row of rows) lines.push(headers.map(h => escape(row[h])).join(','))
  return lines.join('\n')
}

function downloadCSV(filename, rows) {
  const csv = rowsToCSV(rows)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  URL.revokeObjectURL(url)
}

// Exports the user's full history (not just what's cached in S, which is
// windowed for performance) as three CSV files, generated entirely
// client-side — no server endpoint needed.
window.exportMyData = async () => {
  showSpinner('Preparing your export…')
  try {
    const uid = S.user.id
    const [{ data: logs, error: e1 }, { data: food, error: e2 }, { data: weights, error: e3 }] = await Promise.all([
      supabase.from('daily_logs').select('*').eq('user_id', uid).order('date', { ascending: true }),
      supabase.from('food_entries').select('*').eq('user_id', uid).order('created_at', { ascending: true }),
      supabase.from('weight_logs').select('*').eq('user_id', uid).order('date', { ascending: true }),
    ])
    if (e1 || e2 || e3) throw (e1 || e2 || e3)

    if (!logs?.length && !food?.length && !weights?.length) {
      hideSpinner()
      toast('No data to export yet.', false)
      return
    }

    const stamp = getToday()
    if (logs?.length) downloadCSV(`daily_logs_${stamp}.csv`, logs)
    if (food?.length) downloadCSV(`food_entries_${stamp}.csv`, food)
    if (weights?.length) downloadCSV(`weight_logs_${stamp}.csv`, weights)

    hideSpinner()
    toast('Export ready — check your downloads 📁')
  } catch (err) {
    hideSpinner()
    toast(err.message || 'Failed to export data. Try again.', false)
    console.error(err)
  }
}

window.showSettingsView = async () => {
  if (S.profile?.role === 'admin') {
    showSpinner('Loading members…')
    familyMembers = await loadMembersForSettings()
    hideSpinner()
  }
  renderSettings()
}

// Kept in sync with the option sets used during onboarding (same ids/labels).
const ACTIVITY_LEVELS = [
  { id: 'sedentary',   label: 'Sedentary' },
  { id: 'light',       label: 'Lightly Active' },
  { id: 'moderate',    label: 'Moderately Active' },
  { id: 'active',      label: 'Very Active' },
  { id: 'very_active', label: 'Extremely Active' },
]
const GOALS = [
  { id: 'lose',     label: 'Lose Fat' },
  { id: 'maintain', label: 'Maintain Weight' },
  { id: 'build',    label: 'Build Muscle' },
]

function renderSettings() {
  const t = getTargets()
  const st = S.settings || {}

  mount(`
  <div class="min-h-screen bg-gray-950 text-white pb-8">
    <div class="sticky top-0 bg-gray-950/90 backdrop-blur-md border-b border-gray-800 px-5 py-4 flex items-center justify-between">
      <div>
        <p class="text-xs text-gray-400">Settings</p>
        <h1 class="font-bold text-base">Profile & Targets ⚙️</h1>
      </div>
      <button onclick="backToDashboard()" class="px-3 py-1.5 text-xs bg-cyan-600 hover:bg-cyan-500 rounded-xl font-semibold">My Dashboard</button>
    </div>

    <div class="max-w-lg mx-auto px-5 pt-5 space-y-4">

      <!-- Profile & Biometrics -->
      <div class="bg-gray-900 border border-gray-800 rounded-3xl p-5 space-y-4">
        <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Profile & Biometrics</p>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Age</label>
            <input id="prof-age" type="number" min="1" max="119" value="${st.age || ''}"
              class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors"/>
          </div>
          <div>
            <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Sex</label>
            <select id="prof-sex"
              class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors">
              ${['male','female','other'].map(s => `<option value="${s}" ${st.sex === s ? 'selected' : ''}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Height (cm)</label>
            <input id="prof-height" type="number" min="100" max="250" value="${st.height_cm || ''}"
              class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors"/>
          </div>
          <div>
            <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Weight (kg)</label>
            <input id="prof-weight" type="number" min="20" max="300" value="${st.weight_kg || ''}"
              class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors"/>
          </div>
        </div>
        <div>
          <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Activity level</label>
          <select id="prof-activity"
            class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors">
            ${ACTIVITY_LEVELS.map(l => `<option value="${l.id}" ${st.activity_level === l.id ? 'selected' : ''}>${l.label}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Goal</label>
          <select id="prof-goal"
            class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors">
            ${GOALS.map(g => `<option value="${g.id}" ${st.goal === g.id ? 'selected' : ''}>${g.label}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Dietary notes</label>
          <textarea id="prof-notes" rows="2" placeholder="e.g. vegetarian, no nuts"
            class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors resize-none placeholder-gray-500">${st.dietary_notes || ''}</textarea>
        </div>

        ${st.bmr_kcal ? `<p class="text-xs text-gray-600">Current: BMR ${fmt(st.bmr_kcal)} kcal/day · TDEE ${fmt(st.tdee_kcal)} kcal/day</p>` : ''}

        <button onclick="saveProfileSettings()"
          class="w-full py-3 bg-violet-600 hover:bg-violet-500 text-white font-semibold rounded-2xl text-sm transition-colors">
          Save Profile
        </button>
      </div>

      <p class="text-xs text-gray-500">Personalize the goals used on your Today tab. Leave defaults if unsure.</p>

      <div class="bg-gray-900 border border-gray-800 rounded-3xl p-5 space-y-4">
        <div>
          <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">👟 Daily steps target</label>
          <input id="set-steps" type="number" min="1" inputmode="numeric" value="${t.steps}"
            class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors"/>
        </div>
        <div>
          <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">🔥 Active calories target (kcal)</label>
          <input id="set-active" type="number" min="0" inputmode="numeric" value="${t.active_calories}"
            class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors"/>
        </div>
        <div>
          <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">💧 Water target (ml)</label>
          <input id="set-water" type="number" min="0" inputmode="numeric" value="${t.water_ml}"
            class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors"/>
        </div>
        <div>
          <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">🎯 Daily calorie-intake budget (kcal)</label>
          <input id="set-intake" type="number" min="0" inputmode="numeric" value="${t.intake_kcal || 0}"
            class="w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors"/>
          ${S.settings?.tdee_kcal ? `<p class="text-xs text-gray-600 mt-1">Your TDEE is ${fmt(S.settings.tdee_kcal)} kcal/day.</p>` : ''}
        </div>

        <button onclick="saveSettingsTargets()"
          class="w-full py-3 bg-cyan-500 hover:bg-cyan-400 text-white font-semibold rounded-2xl text-sm transition-colors">
          Save Targets
        </button>
      </div>

      <div class="bg-gray-900 border border-gray-800 rounded-3xl p-5 space-y-3">
        <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Your Data</p>
        <p class="text-xs text-gray-500">Download your full activity, food, and weight history as CSV files you can open in Excel or Google Sheets.</p>
        <button onclick="exportMyData()"
          class="w-full py-3 bg-gray-800 hover:bg-gray-700 text-white font-semibold rounded-2xl text-sm transition-colors">
          ⬇️ Export My Data (CSV)
        </button>
      </div>

      ${S.profile?.role === 'admin' ? renderFamilyManagementCard() : ''}
    </div>
  </div>`)
}

// Admin-only: invite link + members list with promote/demote. Rendered inside
// Settings so admins don't need the Supabase table editor to manage roles.
function renderFamilyManagementCard() {
  const inviteUrl = window.location.origin

  const rows = familyMembers.map(m => {
    const isAdmin = m.role === 'admin'
    const isSelf = m.id === S.user.id
    const joined = m.created_at ? new Date(m.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : ''
    return `
      <div class="flex items-center justify-between gap-3 py-3 border-b border-gray-800 last:border-0">
        <div class="min-w-0">
          <p class="text-sm font-semibold truncate">${m.display_name}${isSelf ? ' <span class="text-gray-500 font-normal">(you)</span>' : ''}</p>
          <p class="text-xs text-gray-500">Joined ${joined}</p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <span class="text-xs font-semibold px-2.5 py-1 rounded-full ${isAdmin ? 'bg-violet-500/20 text-violet-300' : 'bg-gray-800 text-gray-400'}">
            ${isAdmin ? 'Admin' : 'Member'}
          </span>
          <button onclick="toggleMemberRole('${m.id}', '${m.role}')"
            class="px-3 py-1.5 text-xs font-semibold rounded-xl transition-colors ${isAdmin ? 'bg-gray-800 hover:bg-gray-700 text-gray-300' : 'bg-violet-600 hover:bg-violet-500 text-white'}">
            ${isAdmin ? 'Demote' : 'Promote'}
          </button>
        </div>
      </div>`
  }).join('')

  return `
  <div class="bg-gray-900 border border-gray-800 rounded-3xl p-5 space-y-4">
    <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Family Management</p>

    <div class="space-y-2">
      <p class="text-xs text-gray-400">Invite a family member</p>
      <div class="flex gap-2">
        <input id="invite-link" type="text" readonly value="${inviteUrl}"
          class="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-xs text-gray-300 outline-none"/>
        <button onclick="copyInviteLink()" class="px-4 py-2.5 bg-cyan-600 hover:bg-cyan-500 rounded-xl text-xs font-semibold transition-colors">Copy</button>
      </div>
      <p class="text-xs text-gray-500">Share this link — they sign up with their own email/password and start on the "user" role. Promote them below once they've joined.</p>
    </div>

    <div>
      <p class="text-xs text-gray-400 mb-1">Members (${familyMembers.length})</p>
      <div class="max-h-80 overflow-y-auto">
        ${rows || '<p class="text-xs text-gray-500 py-2">No members yet.</p>'}
      </div>
      <p class="text-xs text-gray-600 mt-2">Email addresses aren't shown here — Supabase keeps them in the protected auth system, separate from this app's data.</p>
    </div>
  </div>`
}

window.copyInviteLink = async () => {
  const url = document.getElementById('invite-link')?.value || window.location.origin
  try {
    await navigator.clipboard.writeText(url)
    toast('Invite link copied 🔗')
  } catch (err) {
    toast('Could not copy — copy it manually.', false)
    console.error(err)
  }
}

window.toggleMemberRole = (id, currentRole) => {
  const newRole = currentRole === 'admin' ? 'user' : 'admin'
  const member = familyMembers.find(m => m.id === id)
  if (!member) return

  if (currentRole === 'admin') {
    const adminCount = familyMembers.filter(m => m.role === 'admin').length
    if (adminCount <= 1) {
      toast("Can't demote the last remaining admin.", false)
      return
    }
  }

  const verb = newRole === 'admin' ? 'promote' : 'demote'
  confirmModal(
    `${newRole === 'admin' ? 'Promote' : 'Demote'} ${member.display_name}?`,
    `<p class="text-sm text-gray-400">
      ${newRole === 'admin'
        ? `${member.display_name} will be able to view all family activity and manage member roles.`
        : `${member.display_name} will lose admin access and become a regular member.`}
    </p>`,
    async () => {
      showSpinner('Updating role…')
      try {
        const { error } = await supabase.from('profiles').update({ role: newRole }).eq('id', id)
        if (error) throw error
        member.role = newRole
        hideSpinner()
        toast(`${member.display_name} ${verb}d ✅`)
        renderSettings()
      } catch (err) {
        hideSpinner()
        toast(err.message || 'Failed to update role. Try again.', false)
        console.error(err)
      }
    },
    newRole === 'admin' ? 'Promote' : 'Demote'
  )
}

window.saveProfileSettings = async () => {
  const age = Math.round(+document.getElementById('prof-age').value) || 0
  const sex = document.getElementById('prof-sex').value
  const height_cm = +document.getElementById('prof-height').value || 0
  const weight_kg = +document.getElementById('prof-weight').value || 0
  const activity_level = document.getElementById('prof-activity').value
  const goal = document.getElementById('prof-goal').value
  const dietary_notes = document.getElementById('prof-notes').value.trim()

  if (!age || age <= 0 || age >= 120 || !height_cm || !weight_kg) {
    toast('Please fill in a valid age, height, and weight.', false); return
  }

  const bmr_kcal = calculateBMR(age, sex, height_cm, weight_kg)
  const tdee_kcal = calculateTDEE(bmr_kcal, activity_level)

  showSpinner('Updating profile…')
  try {
    const { error } = await supabase.from('user_settings').upsert({
      user_id: S.user.id,
      age, sex, height_cm, weight_kg, activity_level, goal, dietary_notes,
      bmr_kcal, tdee_kcal,
    }, { onConflict: 'user_id' })
    if (error) throw error

    S.settings = { ...S.settings, age, sex, height_cm, weight_kg, activity_level, goal, dietary_notes, bmr_kcal, tdee_kcal }
    hideSpinner()
    toast('Profile updated 🔄')
    renderLayout()
  } catch (err) {
    hideSpinner()
    toast('Failed to update profile. Try again.', false)
    console.error(err)
  }
}

window.saveSettingsTargets = async () => {
  const target_steps = Math.max(1, Math.round(+document.getElementById('set-steps').value) || 0)
  const target_active_kcal = Math.max(0, Math.round(+document.getElementById('set-active').value) || 0)
  const target_water_ml = Math.max(0, Math.round(+document.getElementById('set-water').value) || 0)
  const target_intake_kcal = Math.max(0, Math.round(+document.getElementById('set-intake').value) || 0)

  showSpinner('Saving targets…')
  try {
    const { error } = await supabase.from('user_settings')
      .update({ target_steps, target_active_kcal, target_water_ml, target_intake_kcal })
      .eq('user_id', S.user.id)
    if (error) throw error

    S.settings = { ...S.settings, target_steps, target_active_kcal, target_water_ml, target_intake_kcal }
    hideSpinner()
    toast('Targets updated 🎯')
    renderLayout()
  } catch (err) {
    hideSpinner()
    toast('Failed to save targets. Try again.', false)
    console.error(err)
  }
}

// ─── ═══════════════════════════════════════════════════════ ─
//     CHAT / AI COACH
// ─── ═══════════════════════════════════════════════════════ ─
function renderChatMessages() {
  const el = document.getElementById('chat-messages')
  if (!el) return

  if (chatHistory.length === 0) {
    el.innerHTML = `
      <div class="flex items-start gap-3">
        <div class="w-8 h-8 rounded-full bg-violet-600 flex items-center justify-center text-sm shrink-0">🤖</div>
        <div class="bg-gray-800 rounded-2xl rounded-tl-sm px-4 py-3 text-sm max-w-[80%]">
          Hi ${S.profile?.display_name?.split(' ')[0] || 'there'}! I know your stats for today. Ask me anything about your nutrition, fitness goals, or how you're tracking. 💪
        </div>
      </div>`
    return
  }

  el.innerHTML = chatHistory.map(m => {
    const isUser = m.role === 'user'
    return `<div class="flex items-start gap-3 ${isUser ? 'flex-row-reverse' : ''}">
      <div class="w-8 h-8 rounded-full ${isUser ? 'bg-cyan-600' : 'bg-violet-600'} flex items-center justify-center text-sm shrink-0">
        ${isUser ? '👤' : '🤖'}
      </div>
      <div class="rounded-2xl px-4 py-3 text-sm max-w-[80%] ${isUser ? 'bg-cyan-500/20 text-cyan-100 rounded-tr-sm' : 'bg-gray-800 rounded-tl-sm'}">
        ${m.text}
      </div>
    </div>`
  }).join('')

  el.scrollTop = el.scrollHeight
}

window.openChat = () => {
  chatOpen = true
  const overlay = document.getElementById('chat-overlay')
  if (overlay) {
    overlay.classList.remove('translate-y-full')
    renderChatMessages()
    document.getElementById('chat-input')?.focus()
  }
}

window.closeChat = () => {
  chatOpen = false
  const overlay = document.getElementById('chat-overlay')
  if (overlay) overlay.classList.add('translate-y-full')
}

window.sendChat = async () => {
  const input = document.getElementById('chat-input')
  const text = input?.value.trim()
  if (!text) return

  input.value = ''
  chatHistory.push({ role: 'user', text })
  renderChatMessages()

  // Show typing indicator
  const el = document.getElementById('chat-messages')
  el.innerHTML += `<div id="typing" class="flex items-start gap-3">
    <div class="w-8 h-8 rounded-full bg-violet-600 flex items-center justify-center text-sm shrink-0">🤖</div>
    <div class="bg-gray-800 rounded-2xl rounded-tl-sm px-4 py-3 text-sm">
      <div class="flex gap-1"><div class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay:0s"></div>
        <div class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay:.15s"></div>
        <div class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay:.3s"></div>
      </div>
    </div></div>`
  el.scrollTop = el.scrollHeight

  try {
    const res = await fetch(CHAT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: chatHistory,
        userContext: buildUserContext()
      })
    })
    const data = await res.json()
    document.getElementById('typing')?.remove()

    const reply = data.reply || "Sorry, I couldn't get a response. Try again."
    chatHistory.push({ role: 'model', text: reply })
    renderChatMessages()
  } catch (err) {
    document.getElementById('typing')?.remove()
    chatHistory.push({ role: 'model', text: "Sorry, I'm having trouble connecting right now. Try again in a moment." })
    renderChatMessages()
    console.error(err)
  }
}

// ─── ═══════════════════════════════════════════════════════ ─
//     PASSWORD RESET — landing view for the emailed reset link
// ─── ═══════════════════════════════════════════════════════ ─
function renderResetPassword() {
  mount(`
  <div class="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-6 py-12">
    <div class="w-full max-w-sm space-y-8">
      <div class="text-center space-y-2">
        <div class="text-5xl">🔒</div>
        <h1 class="text-3xl font-black tracking-tight">Set a new password</h1>
        <p class="text-gray-400 text-sm">Choose a new password for your account.</p>
      </div>
      <div class="bg-gray-900 border border-gray-800 rounded-3xl p-7 space-y-4">
        <div class="space-y-1">
          <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">New password</label>
          <input id="reset-pass" type="password" placeholder="••••••••" autocomplete="new-password"
            class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors placeholder-gray-500"/>
        </div>
        <div class="space-y-1">
          <label class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Confirm password</label>
          <input id="reset-pass-confirm" type="password" placeholder="••••••••" autocomplete="new-password"
            class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm outline-none focus:border-cyan-500 transition-colors placeholder-gray-500"/>
        </div>
        <button id="reset-btn" onclick="handlePasswordReset()"
          class="w-full py-3.5 bg-cyan-500 hover:bg-cyan-400 text-white font-bold rounded-xl text-sm transition-colors">
          Update Password
        </button>
      </div>
    </div>
  </div>`)
}

window.handlePasswordReset = async () => {
  const pass = document.getElementById('reset-pass').value
  const confirmPass = document.getElementById('reset-pass-confirm').value
  const btn = document.getElementById('reset-btn')

  if (!pass || pass.length < 6) { toast('Password must be at least 6 characters.', false); return }
  if (pass !== confirmPass) { toast('Passwords do not match.', false); return }

  btn.disabled = true; btn.textContent = 'Updating…'
  try {
    const { error } = await supabase.auth.updateUser({ password: pass })
    if (error) throw error

    // Clean the recovery token out of the URL so a refresh doesn't re-trigger this view.
    history.replaceState(null, '', window.location.pathname)
    toast('Password updated ✅')

    const { data: { session } } = await supabase.auth.getSession()
    if (session?.user) {
      S.user = session.user
      await loadUserData()
      if (!S.profile?.onboarding_complete) {
        OB = { step: 1, data: {} }
        renderOnboarding()
      } else {
        renderLayout()
      }
    } else {
      authMode = 'login'
      renderAuth()
    }
  } catch (err) {
    toast(err.message || 'Failed to update password. Try again.', false)
    btn.disabled = false
    btn.textContent = 'Update Password'
  }
}

// ─── ═══════════════════════════════════════════════════════ ─
//     BOOT
// ─── ═══════════════════════════════════════════════════════ ─
async function boot() {
  mount(`<div class="min-h-screen bg-gray-950 flex items-center justify-center">
    <div class="text-center space-y-4">
      <div class="text-5xl">🏃</div>
      <div class="w-8 h-8 border-4 border-cyan-400 border-t-transparent rounded-full animate-spin mx-auto"></div>
    </div></div>`)

  // Password-reset links land here with a recovery token in the URL hash.
  // supabase-js parses it automatically (detectSessionInUrl) and establishes
  // a temporary recovery session — show the "set new password" view instead
  // of the normal signed-in flow.
  const isRecovery = window.location.hash.includes('type=recovery')

  const { data: { session } } = await supabase.auth.getSession()

  if (isRecovery && session?.user) {
    renderResetPassword()
  } else if (session?.user) {
    S.user = session.user
    await loadUserData()
    if (!S.profile?.onboarding_complete) {
      OB = { step: 1, data: {} }
      renderOnboarding()
    } else {
      renderLayout()
    }
  } else {
    renderAuth()
  }

  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      renderResetPassword()
    } else if (event === 'SIGNED_IN' && session?.user) {
      S.user = session.user
      await loadUserData()
      if (!S.profile?.onboarding_complete) {
        OB = { step: 1, data: {} }
        renderOnboarding()
      } else {
        renderLayout()
      }
    } else if (event === 'SIGNED_OUT') {
      S = { user: null, profile: null, settings: null, todayLog: null, foodEntries: [], historyLogs: [], historyFood: [], savedFoods: [], recentFoods: [], savedMeals: [], weightHistory: [], streakInfo: null }
      chatHistory = []
      lastAnalyzedFoodItems = []
      foodSearchLoaded = false
      authMode = 'login'
      renderAuth()
    }
  })
}

boot()
