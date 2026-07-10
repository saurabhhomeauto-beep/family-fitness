// netlify/functions/analyze.js
// Secure proxy between the PWA and the Gemini API.
// The GEMINI_API_KEY env var is set in Netlify → Site Settings → Environment Variables.

const GEMINI_MODEL = 'gemini-3.1-flash-lite'
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`

const FITNESS_PROMPT = `You are a fitness data extraction assistant.
Analyze the provided health or fitness app screenshot and extract these metrics.
Return ONLY a single valid JSON object — no markdown, no code fences, no explanation:

{
  "steps": <integer>,
  "active_calories_burned": <integer>,
  "resting_calories": <integer>,
  "water_ml": <integer>
}

Rules:
- steps: total step count (integer, 0 if not visible)
- active_calories_burned: active/exercise calories or "Active Energy" (integer, 0 if not visible)
- resting_calories: resting energy burned, "Resting Energy", or BMR calories (integer, 0 if not visible)
- water_ml: hydration in millilitres — multiply litres by 1000 (integer, 0 if not visible)
- Output ONLY the JSON object. Nothing else.`

const FOOD_PROMPT = (userContext) => `You are a nutrition analysis assistant with context about this specific user.

USER CONTEXT (use this to calibrate portion estimates):
${userContext || 'No user context provided.'}

Analyze the provided food image or description and estimate nutritional content.
Return ONLY a valid JSON array — no markdown, no code fences, no explanation:

[
  {
    "food_name": "<specific name of the food item>",
    "calories": <integer estimate>,
    "protein_g": <float to 1 decimal>,
    "carbs_g": <float to 1 decimal>,
    "fat_g": <float to 1 decimal>
  }
]

Rules:
- List every distinct food item as a separate object.
- Use realistic portion sizes based on what's visible/described AND the user's profile above.
- Consider the user's goal (lose/maintain/build) when estimating typical serving sizes.
- carbs_g: total carbohydrates in grams (float to 1 decimal, 0 if genuinely none)
- fat_g: total fat in grams (float to 1 decimal, 0 if genuinely none)
- Output ONLY the JSON array. Nothing else.`

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
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

  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed. Use POST.' })
  }

  const API_KEY = process.env.GEMINI_API_KEY
  if (!API_KEY) {
    return respond(500, { error: 'GEMINI_API_KEY environment variable is not set.' })
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return respond(400, { error: 'Invalid JSON body.' })
  }

  const { type, image, mimeType, text, userContext = '' } = body

  if (!type || !['fitness', 'food'].includes(type)) {
    return respond(400, { error: 'Field "type" must be "fitness" or "food".' })
  }
  if (!image && !text) {
    return respond(400, { error: 'Provide either "image" (base64) or "text".' })
  }

  const prompt = type === 'fitness' ? FITNESS_PROMPT : FOOD_PROMPT(userContext)
  const parts = []

  if (image) {
    parts.push({ inline_data: { mime_type: mimeType || 'image/jpeg', data: image } })
  }
  parts.push({ text: image ? prompt : `${prompt}\n\nFood description: ${text}` })

  try {
    const geminiRes = await fetch(`${GEMINI_ENDPOINT}?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.05,
          responseMimeType: 'application/json',
        },
      }),
    })

    if (!geminiRes.ok) {
      const errBody = await geminiRes.text()
      console.error('[Gemini] API error:', errBody)
      return respond(502, { error: `Gemini API error: ${geminiRes.status}` })
    }

    const geminiData = await geminiRes.json()
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text

    if (!rawText) {
      return respond(502, { error: 'Gemini returned an empty response.' })
    }

    const clean = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()

    let parsed
    try {
      parsed = JSON.parse(clean)
    } catch {
      console.error('[Gemini] Non-JSON response:', rawText)
      return respond(502, { error: 'Could not parse AI response as JSON.', raw: rawText })
    }

    return respond(200, parsed)
  } catch (err) {
    console.error('[Gemini] Network error:', err)
    return respond(500, { error: err.message || 'Internal server error.' })
  }
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  }
}
