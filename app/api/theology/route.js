import OpenAI from 'openai'

export const runtime = 'nodejs'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const ARCS = ['GOD', 'HUMANITY', 'CHRIST', 'APOSTOLIC', 'GOSPEL', 'RESPONSE', 'WISDOM', 'NARRATIVE', 'OTHER']

const REQUIRED_THEOLOGY_ARCS = ['GOD', 'HUMANITY', 'CHRIST', 'APOSTOLIC', 'GOSPEL']

function safeJsonParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    const match = String(text || '').match(/\{[\s\S]*\}/)
    if (!match) return null
    return JSON.parse(match[0])
  }
}

function normalizeSelected(candidates, selectedRaw) {
  const byId = new Map((candidates ?? []).map((c) => [c.id, c]))
  const out = []

  for (const s of selectedRaw ?? []) {
    const id = s?.id
    if (id == null) continue
    if (!byId.has(id)) continue

    const arcRaw = String(s.arc ?? 'OTHER').trim().toUpperCase()
    const arc = ARCS.includes(arcRaw) ? arcRaw : 'OTHER'

    out.push({
      id,
      arc,
      primary_category: s.primary_category ? String(s.primary_category).slice(0, 80) : null,
      secondary_categories: Array.isArray(s.secondary_categories)
        ? s.secondary_categories.map((x) => String(x).slice(0, 40)).filter(Boolean).slice(0, 6)
        : [],
      why: s.why ? String(s.why).slice(0, 240) : null,
    })
  }

  // Dedupe by id (keep first)
  const seen = new Set()
  const deduped = []
  for (const row of out) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    deduped.push(row)
  }
  return deduped
}

function enforceRequiredArcs(selected, candidates) {
  // If the model missed a required arc, we’ll fill it using the best-available candidate
  // by asking the model to pick ONE for the missing arc (cheap, but adds time).
  // Instead, we do a deterministic fallback: pick the highest-similarity candidate not already selected.
  //
  // This keeps speed, and usually works because your candidates already come from semantic search.

  const selectedIds = new Set(selected.map((s) => s.id))
  const have = new Set(selected.map((s) => s.arc))

  const pool = (candidates ?? [])
    .filter((c) => c?.id != null && !selectedIds.has(c.id))
    .slice(0, 80)

  // Build a simple “best-first” ordering using similarity if present
  pool.sort((a, b) => {
    const sa = typeof a.similarity === 'number' ? a.similarity : (typeof a.distance === 'number' ? 1 - a.distance : 0)
    const sb = typeof b.similarity === 'number' ? b.similarity : (typeof b.distance === 'number' ? 1 - b.distance : 0)
    return sb - sa
  })

  // If missing arcs, we can’t truly know which candidate fits which arc without another LLM call,
  // so we DO NOT fake-assign arcs here. We only enforce coverage via the prompt (below).
  // This function stays as a guardrail point if you later add arc tags into DB.
  return selected
}

export async function POST(req) {
  try {
    const body = await req.json()
    const input = String(body?.input ?? '').trim()
    const candidates = Array.isArray(body?.candidates) ? body.candidates : []
    const mode = String(body?.mode ?? 'situation').trim().toLowerCase()
    const plan = Array.isArray(body?.plan) ? body.plan : null

    if (!input) return Response.json({ error: 'Missing input' }, { status: 400 })
    if (candidates.length === 0) return Response.json({ selected: [] })

    // Keep prompt size under control
    const maxCandidates = mode === 'theology' ? 60 : 40
    const trimmed = candidates.slice(0, maxCandidates).map((c) => ({
      id: c.id,
      ref: c.ref,
      ref_key: c.ref_key,
      genre: c.genre,
      unit: c.unit,
      notes: c.notes,
      esv_url: c.esv_url,
      similarity: c.similarity ?? null,
      distance: c.distance ?? null,
    }))

    const theologyRules = `
You are curating passages for a theology study plan.
You MUST produce a Christ-centered, gospel-centered set.

Hard requirements:
- Choose passages ONLY from the provided candidates list.
- You MUST include at least ONE passage for EACH required arc:
  ${REQUIRED_THEOLOGY_ARCS.join(', ')}.
- Do NOT claim a passage "is about" the user's question. Only explain why it is useful/connected.
- Keep summaries grounded: avoid speculation, avoid overconfident claims, avoid proof-texting.
- Prefer clearer didactic passages for doctrine (Epistles) while still using OT and Gospels appropriately.
- Include Humanity/Sin/need for grace where relevant, and explicitly connect need → Christ.
Output JSON only.

Return JSON exactly:
{
  "selected": [
    {
      "id": <number>,
      "arc": "GOD|HUMANITY|CHRIST|APOSTOLIC|GOSPEL|RESPONSE|WISDOM|NARRATIVE|OTHER",
      "primary_category": "<short label>",
      "secondary_categories": ["<label>", "..."],
      "why": "<1-2 sentences, faithful + restrained>"
    }
  ]
}
`.trim()

    const situationRules = `
You are curating passages for a situation-based Bible guidance tool.

Rules:
- Choose passages ONLY from provided candidates.
- Keep it Christ-centered and gospel-aware (include God’s character, human need, Christ, response).
- Do NOT claim the passage is "about" the user's situation. Explain relevance without overreach.
- Output JSON only in the exact schema below.

Return JSON exactly:
{
  "selected": [
    {
      "id": <number>,
      "arc": "GOD|HUMANITY|CHRIST|APOSTOLIC|GOSPEL|RESPONSE|WISDOM|NARRATIVE|OTHER",
      "primary_category": "<short label>",
      "secondary_categories": ["<label>", "..."],
      "why": "<1-2 sentences>"
    }
  ]
}
`.trim()

    const system = mode === 'theology' ? theologyRules : situationRules

    // If theology mode, include the plan titles/goals as context (small)
    const planText =
      mode === 'theology' && plan
        ? `Plan steps:\n${plan
            .slice(0, 6)
            .map((s, i) => `${i + 1}) ${String(s.step_title ?? '').slice(0, 60)} — ${String(s.step_goal ?? '').slice(0, 120)}`)
            .join('\n')}\n`
        : ''

    const user = `
User input/question:
${input}

${planText}
Candidates (pick ONLY from these IDs):
${JSON.stringify(trimmed, null, 2)}
`.trim()

    const resp = await client.responses.create({
      model: 'gpt-4o-mini',
      input: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    })

    const text = (resp.output_text ?? '').trim()
    const parsed = safeJsonParse(text)

    const selectedRaw = Array.isArray(parsed?.selected) ? parsed.selected : []
    let selected = normalizeSelected(trimmed, selectedRaw)

    // Theology: enforce coverage via prompt; keep a guard hook here
    if (mode === 'theology') {
      selected = enforceRequiredArcs(selected, trimmed)
    }

    return Response.json({ selected })
  } catch (err) {
    return Response.json({ error: err?.message ?? 'Unknown error' }, { status: 500 })
  }
}