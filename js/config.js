// ============================================================
// ⚠️  YOU MUST FILL THESE IN BEFORE THE APP WILL WORK
// ============================================================
//
// 1. Go to: supabase.com → your project → Project Settings → API
// 2. Copy "Project URL"  →  paste below as SUPABASE_URL
// 3. Copy "anon public"  →  paste below as SUPABASE_ANON_KEY
//
// ❌ WRONG:  'https://your_project_id.supabase.co'
// ✅ RIGHT:  'https://abcdefghijklmnop.supabase.co'

export const SUPABASE_URL     = 'https://iuilqkjdynygxqcwqaha.supabase.co'
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1aWxxa2pkeW55Z3hxY3dxYWhhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM3MDAwMzksImV4cCI6MjA5OTI3NjAzOX0.gGsJJAE2BsDj7SYZLV4ZfPrYK99lZ72pODOH6zaLyCs'

// Netlify Function endpoints (no changes needed)
export const ANALYZE_ENDPOINT = '/.netlify/functions/analyze'
export const CHAT_ENDPOINT    = '/.netlify/functions/chat'

// Daily Goals (edit freely)
export const TARGETS = {
  steps:            10_000,
  water_ml:          2_000,
  active_calories:     500,
}

// ─── Runtime config check ────────────────────────────────────
// This runs on boot and shows a clear error if credentials are missing.
if (
  SUPABASE_URL.includes('YOUR_PROJECT_ID') ||
  SUPABASE_ANON_KEY.includes('YOUR_ANON_KEY')
) {
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('app').innerHTML = `
      <div style="min-height:100vh;background:#030712;display:flex;align-items:center;justify-content:center;padding:2rem;font-family:system-ui">
        <div style="max-width:480px;background:#111827;border:1px solid #374151;border-radius:1.5rem;padding:2rem;color:#f9fafb">
          <div style="font-size:2.5rem;margin-bottom:1rem">⚠️</div>
          <h1 style="font-size:1.25rem;font-weight:700;margin:0 0 0.75rem">Supabase not configured</h1>
          <p style="color:#9ca3af;font-size:0.875rem;line-height:1.6;margin:0 0 1rem">
            Open <code style="background:#1f2937;padding:0.125rem 0.375rem;border-radius:0.375rem;color:#22d3ee">js/config.js</code>
            and replace the placeholder values with your real Supabase credentials.
          </p>
          <div style="background:#1f2937;border-radius:1rem;padding:1rem;font-size:0.8rem;color:#6b7280;font-family:monospace;line-height:1.8">
            SUPABASE_URL → Project Settings → API → Project URL<br/>
            SUPABASE_ANON_KEY → Project Settings → API → anon public
          </div>
        </div>
      </div>`
  })
}
