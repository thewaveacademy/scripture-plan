import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'

/**
 * 900-passage seeding strategy (no JSON file):
 * - Mix of doctrinal anchors + pastoral + wisdom + narrative + psalms
 * - Uses ASV text via bible-api.com
 * - Upserts by ref_key
 * - Fills pd_text + embedding if missing
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const TRANSLATION = process.env.BIBLE_TRANSLATION || 'asv'
const BIBLE_API_BASE = process.env.BIBLE_API_BASE || 'https://bible-api.com'

if (!supabaseUrl) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL')
if (!serviceKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')
if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY')

const supabase = createClient(supabaseUrl, serviceKey)
const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --------- Single-chapter books normalization (prevents Jude 20-25 bug) ----------
function normalizeRefForApi(ref) {
  const r = String(ref ?? '').trim()

  // Convert "Jude 20-25" -> "Jude 1:20-25" (and similar)
  const m = r.match(/^(Obadiah|Philemon|2 John|3 John|Jude)\s+(\d+)(?:-(\d+))?$/i)
  if (m) {
    const book = m[1].replace(/\s+/g, ' ').trim()
    const v1 = m[2]
    const v2 = m[3]
    return v2 ? `${book} 1:${v1}-${v2}` : `${book} 1:${v1}`
  }

  // Also handle "Jude 20" -> "Jude 1:20"
  const m2 = r.match(/^(Obadiah|Philemon|2 John|3 John|Jude)\s+(\d+)$/i)
  if (m2) {
    const book = m2[1].replace(/\s+/g, ' ').trim()
    const v1 = m2[2]
    return `${book} 1:${v1}`
  }

  return r
}

function encodeRef(ref) {
  return encodeURIComponent(String(ref ?? '').trim())
}

/** Make stable ref_key like: "rom3_21_26" or "1cor15_3_4" or "ps23" */
function makeRefKey(ref) {
  const trimmed = String(ref ?? '').trim()

  // Normalize for single-chapter books before keying
  const safe = normalizeRefForApi(trimmed)

  const m = safe.match(/^(.*)\s+(\d+)(?::(\d+))?(?:-(\d+))?$/)
  if (!m) {
    const m2 = safe.match(/^(.*)\s+(\d+)$/)
    if (!m2) return slugBook(safe)
    const book = slugBook(m2[1])
    const ch = m2[2]
    return `${book}${ch}`
  }

  const bookRaw = m[1]
  const ch = m[2]
  const v1 = m[3]
  const v2 = m[4]

  const book = slugBook(bookRaw)

  if (!v1) return `${book}${ch}`
  if (!v2) return `${book}${ch}_${v1}`
  return `${book}${ch}_${v1}_${v2}`
}

function slugBook(bookRaw) {
  const b = String(bookRaw ?? '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim()

  const map = {
    'genesis': 'gen',
    'exodus': 'ex',
    'leviticus': 'lev',
    'numbers': 'num',
    'deuteronomy': 'dt',
    'joshua': 'jos',
    'judges': 'judg',
    'ruth': 'ruth',
    '1 samuel': '1sam',
    '2 samuel': '2sam',
    '1 kings': '1kgs',
    '2 kings': '2kgs',
    '1 chronicles': '1chr',
    '2 chronicles': '2chr',
    'ezra': 'ezra',
    'nehemiah': 'neh',
    'esther': 'est',
    'job': 'job',
    'psalm': 'ps',
    'psalms': 'ps',
    'proverbs': 'prov',
    'ecclesiastes': 'ecc',
    'song of solomon': 'song',
    'song of songs': 'song',
    'isaiah': 'isa',
    'jeremiah': 'jer',
    'lamentations': 'lam',
    'ezekiel': 'ez',
    'daniel': 'dan',
    'hosea': 'hos',
    'joel': 'joel',
    'amos': 'amos',
    'obadiah': 'obad',
    'jonah': 'jonah',
    'micah': 'mic',
    'nahum': 'nah',
    'habakkuk': 'hab',
    'zephaniah': 'zeph',
    'haggai': 'hag',
    'zechariah': 'zech',
    'malachi': 'mal',

    'matthew': 'mt',
    'mark': 'mk',
    'luke': 'lk',
    'john': 'jn',
    'acts': 'acts',
    'romans': 'rom',
    '1 corinthians': '1cor',
    '2 corinthians': '2cor',
    'galatians': 'gal',
    'ephesians': 'eph',
    'philippians': 'phil',
    'colossians': 'col',
    '1 thessalonians': '1thess',
    '2 thessalonians': '2thess',
    '1 timothy': '1tim',
    '2 timothy': '2tim',
    'titus': 'titus',
    'philemon': 'phlm',
    'hebrews': 'heb',
    'james': 'jas',
    '1 peter': '1pet',
    '2 peter': '2pet',
    '1 john': '1jn',
    '2 john': '2jn',
    '3 john': '3jn',
    'jude': 'jude',
    'revelation': 'rev',
  }

  return map[b] ?? b.replace(/[^a-z0-9]+/g, '')
}

function normalizeVector(v) {
  if (Array.isArray(v)) return `[${v.join(',')}]`
  return v
}

async function fetchAsvText(ref, maxRetries = 6) {
  const safeRef = normalizeRefForApi(ref)
  const url = `${BIBLE_API_BASE}/${encodeRef(safeRef)}?translation=${encodeURIComponent(TRANSLATION)}`

  let attempt = 0
  while (true) {
    attempt += 1
    const res = await fetch(url)

    if (res.ok) {
      const json = await res.json()
      const text =
        (json?.text && String(json.text)) ||
        (Array.isArray(json?.verses) ? json.verses.map((v) => v.text).join(' ') : '') ||
        ''
      return text.trim()
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= maxRetries) {
        const body = await res.text().catch(() => '')
        throw new Error(`Bible API failed after ${attempt} tries (${res.status}): ${body.slice(0, 200)}`)
      }
      const backoff = Math.min(30000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500)
      await sleep(backoff)
      continue
    }

    const body = await res.text().catch(() => '')
    throw new Error(`Bible API error (${res.status}): ${body.slice(0, 200)}`)
  }
}

async function embedText(ref, pdText) {
  const input = `${ref}\n${pdText}`.slice(0, 12000)
  const resp = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input,
  })
  return resp.data?.[0]?.embedding ?? null
}

function buildSeeds() {
  const seeds = []

  const add = (ref, genre, unit) => {
    const safeRef = normalizeRefForApi(ref)
    seeds.push({
      ref: safeRef,                 // store normalized ref
      ref_key: makeRefKey(safeRef), // key off normalized ref
      genre,
      unit,
    })
  }

  for (let i = 1; i <= 72; i++) add(`Psalm ${i}`, 'Psalm', 'Psalm')

  const psExtras = [
    73, 84, 86, 90, 91, 92, 94, 95, 96, 97, 98, 100, 101, 102, 103, 104, 107,
    110, 111, 112, 113, 116, 118, 119, 120, 121, 122, 126, 127, 128, 130, 131,
    136, 139, 145, 146, 147, 148, 149, 150,
  ]
  for (const n of psExtras) add(`Psalm ${n}`, 'Psalm', 'Psalm')

  const provChunks = [
    'Proverbs 1:7-19', 'Proverbs 2:1-11', 'Proverbs 3:1-12', 'Proverbs 3:13-26',
    'Proverbs 4:20-27', 'Proverbs 6:16-19', 'Proverbs 8:22-36', 'Proverbs 9:10-12',
    'Proverbs 10:12-21', 'Proverbs 11:2-5', 'Proverbs 12:1-7', 'Proverbs 13:1-12',
    'Proverbs 14:26-35', 'Proverbs 15:1-4', 'Proverbs 16:1-9', 'Proverbs 17:1-6',
    'Proverbs 18:10-24', 'Proverbs 19:11-21', 'Proverbs 20:1-7', 'Proverbs 21:1-8',
    'Proverbs 22:1-9', 'Proverbs 23:17-26', 'Proverbs 24:10-20', 'Proverbs 25:21-28',
    'Proverbs 26:4-12', 'Proverbs 27:1-10', 'Proverbs 28:13-14', 'Proverbs 29:23-27',
    'Proverbs 30:7-9', 'Proverbs 31:10-31',
  ]
  for (const ref of provChunks) add(ref, 'Wisdom', 'Pericope')

  const otAnchors = [
    'Genesis 1:26-27', 'Genesis 2:15-17', 'Genesis 3:1-7', 'Genesis 3:14-19', 'Genesis 3:15',
    'Genesis 6:5-8', 'Genesis 12:1-3', 'Genesis 15:1-6', 'Genesis 22:1-14', 'Genesis 50:15-21',
    'Exodus 3:13-15', 'Exodus 12:1-14', 'Exodus 19:3-6', 'Exodus 20:1-17', 'Exodus 34:6-7',
    'Leviticus 16:29-34', 'Deuteronomy 6:4-9', 'Deuteronomy 30:15-20',
    'Joshua 1:7-9', 'Judges 2:10-19', 'Ruth 1:16-17',
    '2 Samuel 7:12-16', '1 Kings 8:27-30',
    'Nehemiah 9:6-21',
    'Job 19:25-27',
    'Ecclesiastes 12:13-14',
    'Isaiah 6:1-7', 'Isaiah 9:6-7', 'Isaiah 40:28-31', 'Isaiah 53:3-6', 'Isaiah 55:6-9',
    'Jeremiah 17:5-10', 'Jeremiah 31:31-34',
    'Ezekiel 36:25-27',
    'Daniel 7:13-14',
    'Micah 6:6-8', 'Habakkuk 2:4',
    'Malachi 3:1-4',
  ]
  for (const ref of otAnchors) add(ref, 'Narrative', 'Pericope')

  const gospels = [
    'Matthew 3:13-17', 'Matthew 4:1-11', 'Matthew 5:1-16', 'Matthew 5:17-20',
    'Matthew 6:5-15', 'Matthew 6:25-34', 'Matthew 7:7-11', 'Matthew 11:28-30',
    'Matthew 16:13-20', 'Matthew 16:24-26', 'Matthew 18:21-35', 'Matthew 22:34-40',
    'Matthew 26:26-29', 'Matthew 27:45-54', 'Matthew 28:18-20',
    'Mark 1:14-20', 'Mark 2:1-12', 'Mark 4:35-41', 'Mark 8:27-38',
    'Mark 10:17-27', 'Mark 10:45', 'Mark 14:22-25', 'Mark 15:33-39',
    'Luke 1:46-55', 'Luke 2:8-14', 'Luke 4:16-21', 'Luke 5:17-26',
    'Luke 7:36-50', 'Luke 10:25-37', 'Luke 15:11-24', 'Luke 18:9-14',
    'Luke 19:1-10', 'Luke 22:19-20', 'Luke 23:33-43', 'Luke 24:1-7',
    'John 1:1-14', 'John 3:1-21', 'John 6:35-40', 'John 8:31-36',
    'John 10:27-30', 'John 11:25-26', 'John 13:1-17', 'John 14:1-7',
    'John 15:1-11', 'John 17:1-5', 'John 19:16-30', 'John 20:24-29',
  ]
  for (const ref of gospels) add(ref, 'Gospel', 'Pericope')

  const acts = [
    'Acts 2:36-41', 'Acts 4:10-12', 'Acts 10:34-43', 'Acts 13:38-39', 'Acts 17:30-31',
  ]
  for (const ref of acts) add(ref, 'Narrative', 'Pericope')

  const epistles = [
    'Romans 1:18-23', 'Romans 3:9-20', 'Romans 3:21-26', 'Romans 4:1-8', 'Romans 5:1-11',
    'Romans 6:1-14', 'Romans 6:20-23', 'Romans 7:14-25', 'Romans 8:1-11', 'Romans 8:28-39',
    'Romans 10:9-13', 'Romans 12:1-2', 'Romans 12:9-21',
    '1 Corinthians 1:18-25', '1 Corinthians 6:9-11', '1 Corinthians 10:13', '1 Corinthians 13:1-13',
    '1 Corinthians 15:1-8', '1 Corinthians 15:20-28',
    '2 Corinthians 4:7-18', '2 Corinthians 5:17-21', '2 Corinthians 12:7-10',
    'Galatians 2:15-21', 'Galatians 3:10-14', 'Galatians 5:16-26',
    'Ephesians 1:3-14', 'Ephesians 2:1-10', 'Ephesians 2:11-22', 'Ephesians 4:17-32', 'Ephesians 6:10-18',
    'Philippians 2:5-11', 'Philippians 3:7-11', 'Philippians 4:4-9',
    'Colossians 1:15-20', 'Colossians 2:13-15', 'Colossians 3:1-17',
    '1 Thessalonians 4:13-18', '2 Thessalonians 2:13-17',
    '1 Timothy 1:12-17', '1 Timothy 2:5-6', '2 Timothy 2:8-13', '2 Timothy 3:14-17', 'Titus 3:3-7',
    'Hebrews 1:1-4', 'Hebrews 2:14-18', 'Hebrews 4:14-16', 'Hebrews 9:11-14', 'Hebrews 10:19-25',
    'Hebrews 12:1-3',
    'James 1:2-5', 'James 1:19-27', 'James 2:14-26', 'James 4:6-10',
    '1 Peter 1:13-21', '1 Peter 2:21-25', '1 Peter 5:6-10', '2 Peter 1:3-11',
    '1 John 1:5-10', '1 John 2:1-2', '1 John 3:1-10', '1 John 4:7-12', '1 John 5:11-13',
    // FIXED: Jude ref normalized
    'Jude 1:20-25', 'Revelation 21:1-4', 'Revelation 22:1-5',
  ]
  for (const ref of epistles) add(ref, 'Epistle', 'Pericope')

  const chapterBlocks = [
    'Romans 1', 'Romans 2', 'Romans 3', 'Romans 4', 'Romans 5', 'Romans 6', 'Romans 7', 'Romans 8',
    'John 1', 'John 3', 'John 6', 'John 10', 'John 14', 'John 15', 'John 17',
    'Ephesians 1', 'Ephesians 2', 'Ephesians 4', 'Ephesians 6',
    'Hebrews 1', 'Hebrews 2', 'Hebrews 4', 'Hebrews 9', 'Hebrews 10', 'Hebrews 12',
  ]
  for (const ref of chapterBlocks) add(ref, 'Epistle', 'Chapter')

  // Deduplicate by ref_key
  const seen = new Set()
  const out = []
  for (const s of seeds) {
    if (!s.ref_key) continue
    if (seen.has(s.ref_key)) continue
    seen.add(s.ref_key)
    out.push(s)
  }

  return out
}

async function main() {
  const seeds = buildSeeds()
  console.log(`Seeds generated: ${seeds.length}`)

  const upsertPayload = seeds.map((r) => ({
    ref: r.ref,
    ref_key: r.ref_key,
    genre: r.genre ?? null,
    unit: r.unit ?? null,
    notes: r.notes ?? null,
    esv_url: r.esv_url ?? (r.ref ? `https://www.esv.org/${encodeURIComponent(r.ref)}/` : null),
  }))

  console.log('Upserting passage rows...')
  {
    const { error } = await supabase.from('passages').upsert(upsertPayload, { onConflict: 'ref_key' })
    if (error) throw error
  }

  const refKeys = seeds.map((s) => s.ref_key)

  const chunkSize = 200
  const dbRows = []
  for (let i = 0; i < refKeys.length; i += chunkSize) {
    const chunk = refKeys.slice(i, i + chunkSize)
    const { data, error } = await supabase
      .from('passages')
      .select('id, ref, ref_key, pd_text, embedding')
      .in('ref_key', chunk)
    if (error) throw error
    dbRows.push(...(data ?? []))
  }

  const todo = (dbRows ?? []).filter((p) => !p.pd_text || !p.embedding)
  console.log(`Rows needing pd_text and/or embedding: ${todo.length}`)

  for (let i = 0; i < todo.length; i++) {
    const p = todo[i]
    console.log(`\n[${i + 1}/${todo.length}] ${p.ref} (${p.ref_key})`)

    let pdText = p.pd_text

    if (!pdText) {
      console.log('  fetching ASV text...')

      // IMPORTANT: don't crash the whole run on one bad ref
      try {
        pdText = await fetchAsvText(p.ref)
      } catch (e) {
        console.log(`  WARNING: fetch failed for "${p.ref}": ${e?.message ?? e}`)
        console.log('  Skipping this passage. Fix the ref and rerun anytime.')
        continue
      }

      if (!pdText) {
        console.log('  WARNING: empty text; skipping')
        continue
      }

      const { error } = await supabase.from('passages').update({ pd_text: pdText }).eq('id', p.id)
      if (error) throw error

      await sleep(350)
    } else {
      console.log('  pd_text OK')
    }

    if (!p.embedding) {
      console.log('  embedding...')
      const emb = await embedText(p.ref, pdText)
      if (!emb) {
        console.log('  WARNING: null embedding; skipping')
        continue
      }
      const { error } = await supabase.from('passages').update({ embedding: normalizeVector(emb) }).eq('id', p.id)
      if (error) throw error

      await sleep(150)
    } else {
      console.log('  embedding OK')
    }
  }

  console.log('\nDONE.')
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})