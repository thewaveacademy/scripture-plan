import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL')
if (!serviceKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')

const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false },
})

export async function POST(req) {
  try {
    const payload = await req.json()

    // Minimal validation (avoid storing empty junk)
    const passages = Array.isArray(payload?.passages) ? payload.passages : []
    const input = typeof payload?.input === 'string' ? payload.input : ''
    const mode = typeof payload?.mode === 'string' ? payload.mode : 'situation'

    if (!passages.length) {
      return Response.json({ error: 'No passages to share' }, { status: 400 })
    }

    // Keep payload small + safe
    const cleaned = {
      mode,
      input: input.slice(0, 2000),
      matched_theme_ids: Array.isArray(payload?.matched_theme_ids) ? payload.matched_theme_ids.slice(0, 10) : [],
      theme_id: payload?.theme_id ?? null,
      passages: passages.slice(0, 200).map((p) => ({
        ref: p?.ref ?? null,
        ref_key: p?.ref_key ?? null,
        esv_url: p?.esv_url ?? null,
        arc_label: p?.arc_label ?? null,
        step_label: p?.step_label ?? null,
        similarity: typeof p?.similarity === 'number' ? p.similarity : null,
      })),
      created_client_ts: new Date().toISOString(),
    }

    const { data, error } = await supabaseAdmin
      .from('shared_plans')
      .insert({ payload: cleaned })
      .select('id')
      .single()

    if (error) throw error

    return Response.json({ share_id: data.id })
  } catch (err) {
    return Response.json({ error: err?.message ?? 'Unknown error' }, { status: 500 })
  }
}