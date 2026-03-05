// app/api/search/route.js
import OpenAI from 'openai'

export const runtime = 'nodejs'

export async function POST(req) {
  try {
    const body = await req.json()
    const theme_id = String(body.theme_id ?? '').trim()
    const input = String(body.input ?? '').trim()
    const match_count = Math.min(Number(body.match_count ?? 30), 20)

    if (!theme_id || !input) {
      return Response.json(
        { error: 'Missing theme_id or input' },
        { status: 400 }
      )
    }

    // 1) Embed the user's input
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const emb = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input,
    })

    const query_embedding = emb.data?.[0]?.embedding
    if (!query_embedding) {
      return Response.json(
        { error: 'Failed to create embedding for input' },
        { status: 500 }
      )
    }

    // 2) Call Supabase RPC: match_theme_passages
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    if (!supabaseUrl) {
      return Response.json(
        { error: 'Missing NEXT_PUBLIC_SUPABASE_URL' },
        { status: 500 }
      )
    }
    if (!supabaseKey) {
      return Response.json(
        { error: 'Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY' },
        { status: 500 }
      )
    }

    const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/match_theme_passages`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query_embedding,
        theme_id_input: theme_id, // your function expects text
        match_count,
      }),
    })

    const data = await rpcRes.json()

    if (!rpcRes.ok) {
      return Response.json(
        { error: data?.message ?? data ?? 'Supabase RPC failed' },
        { status: 500 }
      )
    }

    // page.js expects `results`
    return Response.json({ results: Array.isArray(data) ? data : [] })
  } catch (e) {
    return Response.json(
      { error: e?.message ?? 'Unknown server error' },
      { status: 500 }
    )
  }
}