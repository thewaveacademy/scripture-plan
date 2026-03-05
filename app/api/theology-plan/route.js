import OpenAI from 'openai'

export const runtime = 'nodejs'
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const ARC = ['GOD', 'HUMANITY', 'CHRIST', 'GOSPEL', 'RESPONSE', 'WISDOM', 'NARRATIVE']

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
  - desired_arc (one of: ${ARC.join(', ')}) OR null if not applicable
- Keep queries general and Bible-forward (e.g., "justified by faith", "atonement Christ blood", "Trinity Father Son Spirit").
- Do not include commentary, only the plan.
Schema:
{
  "topic": "<string>",
  "plan": [
    { "step_title": "<string>", "step_goal": "<string>", "desired_arc": "<ARC>|null", "search_queries": ["..."] }
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

    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      const match = text.match(/\{[\s\S]*\}/)
      parsed = match ? JSON.parse(match[0]) : null
    }

    if (!parsed?.plan || !Array.isArray(parsed.plan)) {
      return Response.json({ error: 'Invalid plan output', raw: text }, { status: 500 })
    }

    // Normalize
    const plan = parsed.plan.slice(0, 6).map((s) => ({
      step_title: String(s.step_title ?? '').slice(0, 80) || 'Step',
      step_goal: String(s.step_goal ?? '').slice(0, 160) || '',
      desired_arc: ARC.includes(s.desired_arc) ? s.desired_arc : null,
      search_queries: Array.isArray(s.search_queries)
        ? s.search_queries.map((q) => String(q).slice(0, 80)).filter(Boolean).slice(0, 5)
        : [],
    }))

    const topic = String(parsed.topic ?? 'Theological Question').slice(0, 80)

    return Response.json({ topic, plan })
  } catch (err) {
    return Response.json({ error: err?.message ?? 'Unknown error' }, { status: 500 })
  }
}