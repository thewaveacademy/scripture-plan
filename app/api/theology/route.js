import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const ARC = ['GOD', 'HUMANITY', 'CHRIST', 'GOSPEL', 'RESPONSE', 'WISDOM', 'NARRATIVE']

async function embedText(input) {
  const resp = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input,
  })

  return resp.data?.[0]?.embedding
}

async function semanticSearch(input, matchCount = 20) {
  const embedding = await embedText(input)

  if (!embedding) {
    throw new Error('Failed to generate embedding')
  }

  const { data, error } = await supabase.rpc('match_passages', {
    query_embedding: embedding,
    match_count: matchCount,
  })

  if (error) {
    throw new Error(error.message)
  }

  return Array.isArray(data) ? data : []
}

function extractJsonObject(text) {
  const match = text.match(/\{[\s\S]*\}/)
  return match ? match[0] : null
}

function cleanJsonText(text) {
  let cleaned = text.trim()

  cleaned = cleaned.replace(/```json\s*/gi, '').replace(/```/g, '').trim()

  cleaned = cleaned.replace(
    /"desired_arc"\s*:\s*(GOD|HUMANITY|CHRIST|GOSPEL|RESPONSE|WISDOM|NARRATIVE|null)/g,
    (_, val) => `"desired_arc": ${val === 'null' ? 'null' : `"${val}"`}`
  )

  return cleaned
}

function parseLooseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    const extracted = extractJsonObject(text)
    if (!extracted) return null

    const cleaned = cleanJsonText(extracted)
    return JSON.parse(cleaned)
  }
}

async function curatePassages(input, candidates, extra = {}) {
  const system = `
You curate Bible passages for a theology study step.
Return ONLY valid JSON.

Rules:
- Select the best 3 to 8 passages.
- Prefer passages that directly answer the step goal.
- Preserve a Christ-centered biblical arc when possible.
- Use arc values only from: ${ARC.join(', ')}.
- All string values must use double quotes.
- desired_arc must always be either a JSON string or null.

Add these fields for each selected passage:
- id
- arc
- primary_category
- secondary_categories
- why

Schema:
{
  "selected": [
    {
      "id": "<candidate id>",
      "arc": "<ARC>",
      "primary_category": "<short label>",
      "secondary_categories": ["<short label>"],
      "why": "<1-2 short sentences>"
    }
  ]
}
`.trim()

  const user = JSON.stringify({
    input,
    extra,
    candidates: candidates.map((c) => ({
      id: c.id,
      ref: c.ref,
      ref_key: c.ref_key,
      notes: c.notes ?? null,
      genre: c.genre ?? null,
      unit: c.unit ?? null,
      similarity: c.similarity ?? null,
      distance: c.distance ?? null,
    })),
  })

  const resp = await client.responses.create({
    model: 'gpt-4o-mini',
    input: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  })

  const text = (resp.output_text ?? '').trim()
  const parsed = parseLooseJson(text)

  const selected = Array.isArray(parsed?.selected) ? parsed.selected : []
  return selected
}

export async function POST(req) {
  try {
    const { question } = await req.json()

    if (!question || !String(question).trim()) {
      return Response.json({ error: 'Missing question' }, { status: 400 })
    }

    const system = `
You create a Bible study plan for theological questions.
Return ONLY valid JSON.

Requirements:
- Identify the main topic in a short title.
- Produce a plan with 4 to 6 steps.
- Each step must include:
  - step_title (string)
  - step_goal (1 short sentence)
  - search_queries (2 to 5 short phrases for semantic search)
  - desired_arc must be a JSON string using one of these exact values:
    "GOD", "HUMANITY", "CHRIST", "GOSPEL", "RESPONSE", "WISDOM", "NARRATIVE"
    or null
- Keep queries general and Bible-forward.
- Do not include commentary, only the plan.
- All string values must be wrapped in double quotes.
- Return strict valid JSON only.

Schema:
{
  "topic": "<string>",
  "plan": [
    {
      "step_title": "<string>",
      "step_goal": "<string>",
      "desired_arc": "<ARC>|null",
      "search_queries": ["..."]
    }
  ]
}
`.trim()

    const prompt = `Question: ${String(question).trim()}`

    const resp = await client.responses.create({
      model: 'gpt-4o-mini',
      input: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    })

    const text = (resp.output_text ?? '').trim()
    const parsed = parseLooseJson(text)

    if (!parsed?.plan || !Array.isArray(parsed.plan)) {
      return Response.json(
        { error: 'Invalid plan output', raw: text },
        { status: 500 }
      )
    }

    const plan = parsed.plan.slice(0, 6).map((s) => ({
      step_title: String(s.step_title ?? '').slice(0, 80) || 'Step',
      step_goal: String(s.step_goal ?? '').slice(0, 160) || '',
      desired_arc: ARC.includes(s.desired_arc) ? s.desired_arc : null,
      search_queries: Array.isArray(s.search_queries)
        ? s.search_queries.map((q) => String(q).slice(0, 80)).filter(Boolean).slice(0, 5)
        : [],
    }))

    const topic = String(parsed.topic ?? 'Theological Question').slice(0, 80)

    const steps = []

    for (const step of plan) {
      const queryText =
        step.search_queries.length > 0
          ? step.search_queries.join(' | ')
          : `${topic} ${step.step_title} ${step.step_goal}`

      const candidates = await semanticSearch(queryText, 20)

      const curated = await curatePassages(question, candidates, {
        mode: 'theology',
        topic,
        step_title: step.step_title,
        step_goal: step.step_goal,
        desired_arc: step.desired_arc,
      })

      const byId = new Map(candidates.map((p) => [String(p.id), p]))

      const finalRows = curated
        .map((c) => {
          const base = byId.get(String(c.id))
          if (!base) return null
          return { ...base, ...c }
        })
        .filter(Boolean)

      steps.push({
        step_title: step.step_title,
        step_goal: step.step_goal,
        desired_arc: step.desired_arc,
        passages: finalRows.length > 0 ? finalRows : candidates.slice(0, 8),
      })
    }

    return Response.json({ topic, steps })
  } catch (err) {
    return Response.json(
      { error: err?.message ?? 'Unknown error' },
      { status: 500 }
    )
  }
}