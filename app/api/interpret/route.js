import OpenAI from 'openai'

export const runtime = 'nodejs'

export async function POST(req) {
  try {
    const { input, themes } = await req.json()

    if (!input || !Array.isArray(themes) || themes.length === 0) {
      return Response.json({ error: 'Missing input/themes' }, { status: 400 })
    }

    // Build a strict allow-list of IDs as STRINGS
    const allowedIds = themes.map((t) => String(t.id))
    const idToName = Object.fromEntries(themes.map((t) => [String(t.id), String(t.name ?? '')]))

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

    const system = `
You are a classifier for a Bible reference tool.
Given a user's situation and a list of themes with IDs, pick the BEST matching themes.
Return ONLY valid JSON and ONLY IDs from the provided list.

Rules:
- Return 1 to 3 theme_ids
- Each theme_id MUST be a string exactly matching one of the provided IDs
- If none match, return {"theme_ids":[]}
`.trim()

    // We purposely quote the IDs here so the model learns they are strings.
    const themeLines = themes
      .map((t) => `"${String(t.id)}": ${String(t.name ?? '')}`)
      .join('\n')

    const prompt = `
User input:
${input}

Available themes (id: name):
${themeLines}

Return JSON in this exact shape:
{"theme_ids":["<id>","<id>","<id>"]}
`.trim()

    const resp = await client.responses.create({
      model: 'gpt-4o-mini',
      input: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    })

    const text = (resp.output_text ?? '').trim()

    let parsed = { theme_ids: [] }
    try {
      parsed = JSON.parse(text)
    } catch {
      const match = text.match(/\{[\s\S]*\}/)
      if (match) parsed = JSON.parse(match[0])
    }

    // Normalize to strings + validate against allow-list
    const raw = Array.isArray(parsed.theme_ids) ? parsed.theme_ids : []
    const normalized = raw.map((x) => String(x)).slice(0, 3)
    const valid = normalized.filter((id) => allowedIds.includes(id))

    // If the model returns nothing valid, return empty array (don’t guess).
    return Response.json({
      theme_ids: valid,
      debug: {
        returned_raw: raw,
        returned_text: text,
        valid_ids: valid,
        allowed_count: allowedIds.length,
        // Helpful to see mismatches:
        invalid_ids: normalized.filter((id) => !allowedIds.includes(id)),
      },
    })
  } catch (err) {
    return Response.json(
      { error: err?.message ?? 'Unknown error' },
      { status: 500 }
    )
  }
}