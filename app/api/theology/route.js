import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL')
if (!serviceKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')

const supabase = createClient(supabaseUrl, serviceKey)

// --------------------
// Simple in-memory caches (dev-friendly)
// --------------------
const planCache = globalThis.__theologyPlanCache ?? new Map()
globalThis.__theologyPlanCache = planCache

const embedCache = globalThis.__embedCache ?? new Map()
globalThis.__embedCache = embedCache

// --------------------
// Helpers
// --------------------
function normalizeVector(v) {
  if (Array.isArray(v)) return `[${v.join(',')}]`
  return v
}

async function embed(text) {
  const key = String(text || '').trim()
  if (!key) return null
  if (embedCache.has(key)) return embedCache.get(key)

  const resp = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: key,
  })
  const emb = resp.data?.[0]?.embedding ?? null
  embedCache.set(key, emb)
  return emb
}

async function matchPassagesGlobal(queryEmbedding, matchCount = 10) {
  const { data, error } = await supabase.rpc('match_passages_global', {
    query_embedding: normalizeVector(queryEmbedding),
    match_count: matchCount,
  })
  if (error) throw error
  return Array.isArray(data) ? data : []
}

async function buildPlan(question) {
  const q = String(question || '').trim()
  if (planCache.has(q)) return planCache.get(q)

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
- Keep queries Bible-forward (e.g., "justified by faith", "atonement Christ blood", "Trinity Father Son Spirit").
Schema:
{
  "topic": "<string>",
  "plan": [
    { "step_title": "<string>", "step_goal": "<string>", "search_queries": ["..."] }
  ]
}
`.trim()

  const resp = await openai.responses.create({
    model: 'gpt-4o-mini',
    input: [
      { role: 'system', content: system },
      { role: 'user', content: `Question: ${q}` },
    ],
  })

  const text = (resp.output_text ?? '').trim()

  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    parsed = match ? JSON.parse(match[0]) : null
  }

  const topic = String(parsed?.topic ?? 'Theological Question').slice(0, 80)
  const rawPlan = Array.isArray(parsed?.plan) ? parsed.plan.slice(0, 6) : []

  if (rawPlan.length === 0) throw new Error('Plan generation failed')

  const plan = rawPlan.map((s, i) => ({
    step_title: String(s.step_title ?? `Step ${i + 1}`).slice(0, 80),
    step_goal: String(s.step_goal ?? '').slice(0, 180),
    search_queries: Array.isArray(s.search_queries)
      ? s.search_queries.map((x) => String(x).trim()).filter(Boolean).slice(0, 5)
      : [],
  }))

  const out = { topic, plan }
  planCache.set(q, out)
  return out
}

function dedupeById(rows) {
  const map = new Map()
  for (const r of rows || []) {
    if (r?.id == null) continue
    if (!map.has(r.id)) map.set(r.id, r)
  }
  return Array.from(map.values())
}

export async function POST(req) {
  try {
    const { question } = await req.json()
    const q = String(question || '').trim()
    if (!q) return Response.json({ error: 'Missing question' }, { status: 400 })

    // 1) Build plan (cached)
    const { topic, plan } = await buildPlan(q)

    // 2) Retrieve candidates per step (parallel)
    // passageBestStep: id -> { stepIndex, score }
    const passageBestStep = new Map()
    const allCandidates = []

    await Promise.all(
      plan.map(async (step, stepIndex) => {
        const queries = step.search_queries ?? []
        if (queries.length === 0) return

        const embs = await Promise.all(queries.map((qq) => embed(qq)))
        const validEmbs = embs.filter(Boolean)

        const matchLists = await Promise.all(validEmbs.map((e) => matchPassagesGlobal(e, 10)))

        const flat = matchLists.flat()
        const unique = dedupeById(flat).slice(0, 30)

        for (const p of unique) {
          allCandidates.push(p)
          if (p?.id == null) continue

          const score =
            typeof p.similarity === 'number'
              ? p.similarity
              : (typeof p.distance === 'number' ? 1 - p.distance : 0)

          const prev = passageBestStep.get(p.id)
          if (!prev) {
            passageBestStep.set(p.id, { stepIndex, score })
          } else {
            if (score > prev.score) passageBestStep.set(p.id, { stepIndex, score })
          }
        }
      })
    )

    const candidates = dedupeById(allCandidates).slice(0, 120)

    if (candidates.length === 0) {
      return Response.json({
        topic,
        steps: plan.map((s) => ({
          step_title: s.step_title,
          step_goal: s.step_goal,
          passages: [],
        })),
      })
    }

    // 3) Single curation call for the whole theology question
    const baseUrl = new URL(req.url).origin
    const curateRes = await fetch(`${baseUrl}/api/curate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: q,
        candidates,
        mode: 'theology',
        plan,
      }),
    })

    const curateText = await curateRes.text()
    let curateJson
    try {
      curateJson = JSON.parse(curateText)
    } catch {
      throw new Error(`Curate returned non-JSON (${curateRes.status}): ${curateText.slice(0, 200)}`)
    }

    if (!curateRes.ok) throw new Error(curateJson?.error ?? 'Curation failed')

    const selected = Array.isArray(curateJson.selected) ? curateJson.selected : []

    // 4) Merge curated metadata back onto base candidate rows
    const byId = new Map(candidates.map((p) => [p.id, p]))
    const curatedRows = selected
      .map((s) => (byId.get(s.id) ? { ...byId.get(s.id), ...s } : null))
      .filter(Boolean)

    // 5) Assign each curated row to exactly ONE step (best step)
    const stepBuckets = plan.map(() => [])
    for (const p of curatedRows) {
      const best = passageBestStep.get(p.id)
      const idx = best?.stepIndex ?? 0
      if (stepBuckets[idx]) stepBuckets[idx].push(p)
    }

    const steps = plan.map((s, idx) => ({
      step_title: s.step_title,
      step_goal: s.step_goal,
      passages: stepBuckets[idx] ?? [],
    }))

    // 6) Fallback: fill empty steps with UNUSED passages only (no repeats)
    const used = new Set()
    for (const st of steps) for (const p of st.passages ?? []) if (p?.id != null) used.add(p.id)

    let cursor = 0
    const finalSteps = steps.map((st) => {
      if ((st.passages?.length ?? 0) > 0) return st

      const fill = []
      while (cursor < curatedRows.length && fill.length < 6) {
        const p = curatedRows[cursor++]
        if (!p?.id) continue
        if (used.has(p.id)) continue
        used.add(p.id)
        fill.push(p)
      }

      return { ...st, passages: fill }
    })

    return Response.json({ topic, steps: finalSteps })
  } catch (err) {
    return Response.json({ error: err?.message ?? 'Unknown error' }, { status: 500 })
  }
}