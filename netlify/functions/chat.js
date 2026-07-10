// netlify/functions/chat.js
// AI coach chatbot — injects user's full profile/stats as context on every call.

const GEMINI_MODEL = 'gemini-3.1-flash-lite'
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`

const SYSTEM_PROMPT = `You are a personal fitness and nutrition coach embedded in the Family Fitness Hub app.
You have been given the user's profile, biometrics, daily goals, and today's activity data.
Always be:
- Concise (2-4 sentences unless asked to elaborate)
- Encouraging and positive
- Specific to their actual numbers — mention their real stats, not generics
- Practical — give actionable advice
Do NOT give medical diagnoses or prescriptions. 
Do NOT repeat the user's data back to them verbatim unless they ask.
Address the user by their first name occasionally.`

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return corsOk()
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' })
  }

  const API_KEY = process.env.GEMINI_API_KEY
  if (!API_KEY) return respond(500, { error: 'GEMINI_API_KEY not configured.' })

  let body
  try { body = JSON.parse(event.body || '{}') }
  catch { return respond(400, { error: 'Invalid JSON.' }) }

  const { messages = [], userContext = '' } = body

  if (!messages.length) return respond(400, { error: 'messages array is empty.' })

  // Build Gemini multi-turn conversation.
  // Gemini requires alternating user/model roles, so we seed the context
  // as the very first user turn, acknowledged by a model turn, then append
  // the real conversation.
  const seedUserTurn = `${SYSTEM_PROMPT}\n\nHere is this user's current data:\n\n${userContext}\n\nYou now have full context. When I send my first message, respond as their personal coach.`

  const firstName = extractFirstName(userContext)

  const contents = [
    { role: 'user',  parts: [{ text: seedUserTurn }] },
    { role: 'model', parts: [{ text: `Got it! I have your stats for today, ${firstName}. What would you like to work on?` }] },
    // Real conversation history
    ...messages.map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.text }],
    })),
  ]

  try {
    const res = await fetch(`${GEMINI_ENDPOINT}?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 400,
        },
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      console.error('[Chat] Gemini error:', err)
      return respond(502, { error: `Gemini API error: ${res.status}` })
    }

    const data = await res.json()
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "I couldn't generate a response. Try again."

    return respond(200, { reply })
  } catch (err) {
    console.error('[Chat] Network error:', err)
    return respond(500, { error: err.message })
  }
}

function extractFirstName(ctx) {
  const match = ctx.match(/Name:\s*([^\s|]+)/)
  return match ? match[1] : 'there'
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  }
}

function corsOk() {
  return {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: '',
  }
}
