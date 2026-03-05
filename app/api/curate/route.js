import OpenAI from 'openai'

export const runtime = 'nodejs'

const MODEL = 'gpt-4o-mini'

// --- Redemptive Arc Layer ---
const ARC = ['GOD', 'HUMANITY', 'CHRIST', 'GOSPEL', 'RESPONSE', 'WISDOM', 'NARRATIVE']

const ARC_ORDER = {
  GOD: 1,
  HUMANITY: 2,
  CHRIST: 3,
  GOSPEL: 4,
  RESPONSE: 5,
  WISDOM: 6,
  NARRATIVE: 7,
}

// Categories you want
const CATEGORIES = [
  'GOD_CHARACTER',
  'CHRIST_LIFE_WORK',
  'APOSTOLIC_INSTRUCTION',
  'GOSPEL_TIE_IN',
  'WISDOM',
  'OT_NARRATIVE',
]

export async function POST(req) {
  try {
    const { input, candidates } = await req.json()

    if (!input || !Array.isArray(candidates) || candidates.length === 0) {
      return Response.json({ error: 'Missing input/candidates' }, { status: 400 })
    }

    // Keep payload small (cost control)
    const slim = candidates.slice(0, 40).map((p) => ({
      id: p.id,
      ref: p.ref,
      genre: p.genre ?? null,
      unit: p.unit ?? null,
      esv_url: p.esv_url ?? null,
      notes: p.notes ?? null,
      // Use pd_text if present; otherwise null
      pd_text: p.pd_text ?? null,
      // Distance if present (lower = more similar)
      distance: typeof p.distance === 'number' ? p.distance : null,
    }))

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

    const system = `
You are a Christ-centered scripture curator.
Given a user's situation and a list of candidate passages, return a curated set.

Primary goal:
- Relevance-first: choose passages that are most helpful for the user's situation.

Structure goal (Redemptive Arc Layer):
- Organize the final set along this arc:
  GOD → HUMANITY → CHRIST → GOSPEL → RESPONSE
- HUMANITY means: sin, fallenness, unbelief, idolatry, weakness, death, need for mercy/redemption, and the brokenness of a fallen world.
- Include WISDOM when it materially helps practical response.
- Include NARRATIVE when it materially helps by example/encouragement.
- Dynamic size: return between 6 and 15 passages. Do NOT force a fixed count.

Coverage requirements:
- Ensure the final set contains at least one passage with arc=GOD.
- Ensure the final set contains at least one passage with arc=CHRIST or arc=GOSPEL.
- Include at least one passage with arc=HUMANITY when appropriate.
  - If the situation is clearly suffering/affliction (grief, tragedy, illness, persecution), HUMANITY should emphasize human frailty + the fallen world, not blame.
- Include arc=RESPONSE when there are clear imperatives appropriate to the user's situation.

Hermeneutic standards (MUST follow):
- Context & genre: respect genre; do not treat wisdom as unconditional promise; do not treat narrative as direct command.
- Indicative before imperative: ground guidance in who God is / what God has done before what the reader must do.
- Christ-centered: read the Bible as one story fulfilled in Christ; avoid moralism; when using OT narrative, highlight God's faithfulness and redemptive purposes.
- Covenant/audience care: do not apply OT national covenant promises as direct personal guarantees unless the NT clearly applies them.
- Avoid proof-texting: select passages that stand in context; prefer coherent pericope units; avoid out-of-context one-liners.
- No speculation: do not invent details or claims beyond the text.
- HUMANITY framing: describe sin/fallenness as Scripture describes it; do not accuse the user; do not speculate about motives.

Classification rules:
Each selected passage MUST have:
- id (from candidates)
- primary_category (one of: ${CATEGORIES.join(', ')})
- secondary_categories (0+ from the same set; may be empty)
- arc (one of: ${ARC.join(', ')})
- why (1 short sentence; see rules below)

Rules for "why" (IMPORTANT):
- DO NOT say: "this passage is about X", "this relates to your question", "because you are feeling X", or similar.
- DO NOT restate the user's situation.
- Instead, write what the passage asserts in its own terms (1 sentence):
  - what it reveals about God / Christ
  - what it says about humanity’s sin/need (general, not as an accusation)
  - what the gospel secures
  - what the passage promises/warns/comforts
  - what response it calls for (if applicable)
- Keep it concrete and biblical; no therapeutic commentary; no preachy tone.

Output rules:
- Return ONLY valid JSON.
- Exact schema:
{
  "selected": [
    {
      "id": <number>,
      "primary_category": "<CATEGORY>",
      "secondary_categories": ["<CATEGORY>"],
      "arc": "<ARC>",
      "why": "<string>"
    }
  ]
}
`.trim()

    const prompt = `
User situation:
${input}

Candidates (some have pd_text; if missing, infer from ref/genre/unit):
${JSON.stringify(slim, null, 2)}
`.trim()

    const resp = await client.responses.create({
      model: MODEL,
      input: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    })

    const text = (resp.output_text ?? '').trim()

    let parsed = { selected: [] }
    try {
      parsed = JSON.parse(text)
    } catch {
      const match = text.match(/\{[\s\S]*\}/)
      parsed = match ? JSON.parse(match[0]) : { selected: [] }
    }

    // Validate IDs exist in candidates
    const allowedIds = new Set(slim.map((x) => x.id))
    const selectedRaw = Array.isArray(parsed.selected) ? parsed.selected : []

    const selected = selectedRaw
      .filter((x) => allowedIds.has(x.id))
      .slice(0, 20) // hard cap
      .map((x) => ({
        id: x.id,
        primary_category: CATEGORIES.includes(x.primary_category) ? x.primary_category : 'GOSPEL_TIE_IN',
        secondary_categories: Array.isArray(x.secondary_categories)
          ? x.secondary_categories.filter((c) => CATEGORIES.includes(c))
          : [],
        why: String(x.why ?? '').slice(0, 220),
      }))

    return Response.json({
      selected,
      debug: {
        model_text: text,
        candidates_count: slim.length,
        selected_count: selected.length,
      },
    })
  } catch (err) {
    return Response.json({ error: err?.message ?? 'Unknown error' }, { status: 500 })
  }
}