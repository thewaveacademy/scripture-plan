import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'

// -------------------- CONFIG --------------------
const PD_TRANSLATION = (process.env.BIBLE_TRANSLATION || 'asv').toLowerCase()

// OpenAI embedding model
const EMBED_MODEL = 'text-embedding-3-small'

// Tune these to reduce 429s
const BATCH = 5           // how many passages to embed per OpenAI call
const SLEEP_MS = 1300      // delay between Bible API fetches (ms)
const MAX_PER_RUN = 5000  // safety cap; >120 is fine

// Retry/backoff for 429
const MAX_RETRIES = 7
const BACKOFF_START_MS = 600
const BACKOFF_MAX_MS = 12000

// -------------------- HELPERS --------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function envOrThrow(name, val) {
  if (!val) throw new Error(`Missing ${name} in .env.local`)
  return val
}

// -------------------- OPENAI --------------------
const OPENAI_API_KEY = envOrThrow('OPENAI_API_KEY', process.env.OPENAI_API_KEY)
const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

// -------------------- SUPABASE --------------------
const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

envOrThrow('SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)', SUPABASE_URL)
envOrThrow('SUPABASE_SERVICE_ROLE_KEY (recommended) or NEXT_PUBLIC_SUPABASE_ANON_KEY', SUPABASE_KEY)

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// -------------------- BIBLE TEXT FETCH --------------------
async function fetchBibleText(ref) {
  const url = `https://bible-api.com/${encodeURIComponent(ref)}?translation=${encodeURIComponent(PD_TRANSLATION)}`

  let wait = BACKOFF_START_MS

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url)

    if (res.status === 429) {
      console.log(`429 rate limit for "${ref}" — waiting ${wait}ms (attempt ${attempt}/${MAX_RETRIES})`)
      await sleep(wait)
      wait = Math.min(wait * 2, BACKOFF_MAX_MS)
      continue
    }

    if (!res.ok) {
      throw new Error(`Bible API error ${res.status} for ${ref}`)
    }

    const json = await res.json()
    const text = (json?.text ?? '').trim()
    if (!text) throw new Error(`No text returned for ${ref}`)

    return text
  }

  throw new Error(`Bible API still rate-limited after ${MAX_RETRIES} retries for ${ref}`)
}

// -------------------- MAIN --------------------
async function main() {
  console.log(`PD translation: ${PD_TRANSLATION}`)
  console.log(`Embedding model: ${EMBED_MODEL}`)
  console.log(`Batch: ${BATCH}, Sleep: ${SLEEP_MS}ms`)

  // Pull passages missing embeddings
  const { data: passages, error } = await supabase
    .from('passages')
    .select('id, ref')
    .is('embedding', null)
    .order('id', { ascending: true })
    .limit(MAX_PER_RUN)

  if (error) throw error

  if (!passages?.length) {
    console.log('No passages missing embeddings. Done.')
    return
  }

  console.log(`Passages needing embeddings: ${passages.length}`)

  for (let i = 0; i < passages.length; i += BATCH) {
    const batch = passages.slice(i, i + BATCH)

    // 1) Fetch text (with throttling + retry)
    const rows = []
    for (const p of batch) {
      try {
        const text = await fetchBibleText(p.ref)
        rows.push({ id: p.id, ref: p.ref, text })
      } catch (e) {
        console.log(`WARN: fetch failed for ${p.ref} (id=${p.id}): ${e.message}`)
      }

      // throttle between calls
      await sleep(SLEEP_MS)
    }

    if (rows.length === 0) {
      console.log(`Batch starting at index ${i}: no texts fetched, skipping embedding.`)
      continue
    }

    // 2) Embed texts
    const inputs = rows.map((r) => r.text)

    let emb
    try {
      emb = await openai.embeddings.create({
        model: EMBED_MODEL,
        input: inputs,
      })
    } catch (e) {
      console.log(`ERROR: embedding call failed for batch starting at ${i}: ${e.message}`)
      // Don't crash the whole run; continue to next batch.
      continue
    }

    if (!emb?.data?.length || emb.data.length !== rows.length) {
      console.log(`ERROR: embedding response size mismatch. expected=${rows.length} got=${emb?.data?.length ?? 0}`)
      continue
    }

    // 3) Write back to Supabase
    for (let j = 0; j < rows.length; j++) {
      const r = rows[j]
      const vector = emb.data[j].embedding

      const { error: upErr } = await supabase
        .from('passages')
        .update({
          pd_translation: PD_TRANSLATION,
          pd_text: r.text,
          embedding: vector,
        })
        .eq('id', r.id)

      if (upErr) {
        console.log(`ERROR: failed to update passage id=${r.id} ref=${r.ref}: ${upErr.message}`)
      }
    }

    const done = Math.min(i + BATCH, passages.length)
    console.log(`Progress: processed ${done}/${passages.length} (some may have failed fetch/update)`)
  }

  console.log('Done indexing run.')

  // Optional: print how many are embedded now
  const { data: counts, error: cErr } = await supabase
    .from('passages')
    .select('id, embedding', { count: 'exact', head: false })

  if (!cErr && counts) {
    // This select returns rows; not ideal. Use SQL for counts if you want.
    // Leaving as-is to avoid extra complexity.
  }

  console.log('Tip: Re-run this script; it will continue where it left off (embedding IS NULL).')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})