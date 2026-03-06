'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

export default function Home() {
  const [themes, setThemes] = useState([])
  const [matchedThemeIds, setMatchedThemeIds] = useState([])
  const [passages, setPassages] = useState([])
  const [mode, setMode] = useState('situation') // 'situation' | 'theology'

  const [situationText, setSituationText] = useState('')

  const [theologyQuestion, setTheologyQuestion] = useState('')
  const [theologyTopic, setTheologyTopic] = useState('')
  const [theologySteps, setTheologySteps] = useState([])

  const [loadingThemes, setLoadingThemes] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [status, setStatus] = useState('')

  const quickSituations = [
    'I feel anxious about the future',
    'I need guidance for a decision',
    'I’m struggling with temptation',
    'I’m grieving and need comfort',
    'I’m angry and need self-control',
    'I feel lonely',
  ]

  const quickTheology = [
    'What is the gospel?',
    'What is repentance?',
    'What is justification?',
    'What is sanctification?',
    'What is the Trinity?',
    'Can a Christian lose salvation?',
  ]

  const ARC_LABELS = {
    GOD: 'God',
    HUMANITY: 'Humanity (sin / need)',
    CHRIST: 'Christ',
    APOSTOLIC: 'Apostolic Instruction',
    GOSPEL: 'Gospel (redemption + hope)',
    RESPONSE: 'Response (faith + obedience)',
    WISDOM: 'Wisdom',
    NARRATIVE: 'OT Narrative',
    OTHER: 'Other',
  }

  const ARC_ORDER = ['GOD', 'HUMANITY', 'CHRIST', 'APOSTOLIC', 'GOSPEL', 'RESPONSE', 'WISDOM', 'NARRATIVE', 'OTHER']

  function themeDisplayName(t) {
    return t.name ?? t.label ?? t.title ?? `Theme ${t.id}`
  }

  useEffect(() => {
    async function loadThemes() {
      setLoadingThemes(true)
      setError(null)

      const res = await supabase.from('themes').select('*').order('id', { ascending: true })

      if (res.error) {
        setError(res.error)
        setThemes([])
      } else {
        setThemes(res.data ?? [])
      }

      setLoadingThemes(false)
    }

    loadThemes()
  }, [])

  async function llmPickThemes(input) {
    const themeList = themes.map((t) => ({
      id: String(t.id),
      name: themeDisplayName(t),
    }))

    const res = await fetch('/api/interpret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, themes: themeList }),
    })

    const json = await res.json()
    if (!res.ok) throw new Error(json?.error ?? 'LLM interpret failed')

    const ids = Array.isArray(json.theme_ids) ? json.theme_ids : []
    return ids.map((x) => String(x)).slice(0, 3)
  }

  async function semanticSearch(themeId, input, matchCount = 25) {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        theme_id: String(themeId),
        input,
        match_count: matchCount,
      }),
    })

    const json = await res.json()
    if (!res.ok) throw new Error(json?.error ?? 'Semantic search failed')

    const rows = json.results ?? json.passages ?? []
    return Array.isArray(rows) ? rows : []
  }

  async function curatePassages(input, candidates, extra = {}) {
    const res = await fetch('/api/curate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, candidates, ...extra }),
    })

    const json = await res.json()
    if (!res.ok) throw new Error(json?.error ?? 'Curation failed')

    const selected = Array.isArray(json.selected) ? json.selected : []
    return selected
  }

  function groupByArc(rows) {
    const grouped = (rows ?? []).reduce((acc, p) => {
      const raw = p?.arc ? String(p.arc) : ''
      const normalized = raw.trim().toUpperCase()
      const key = ARC_ORDER.includes(normalized) ? normalized : 'OTHER'

      if (!acc[key]) acc[key] = []
      acc[key].push({ ...p, arc: key })
      return acc
    }, {})
    return grouped
  }

  async function runSituationSearch() {
    try {
      setLoading(true)
      setError(null)
      setStatus('Interpreting input…')
      setPassages([])
      setMatchedThemeIds([])

      if (!situationText.trim()) {
        setStatus('Type something first.')
        return
      }

      if (themes.length === 0) {
        setStatus('Themes not loaded yet.')
        return
      }

      const ids = await llmPickThemes(situationText)
      const validIds = ids.filter((id) => themes.some((t) => String(t.id) === String(id)))
      setMatchedThemeIds(validIds)

      const primaryThemeId = validIds[0]
      if (!primaryThemeId) {
        setStatus('No matching themes found. Try different wording.')
        return
      }

      setStatus('Searching candidates…')
      const candidates = await semanticSearch(primaryThemeId, situationText, 25)

      setStatus('Curating…')
      const curated = await curatePassages(situationText, candidates, { mode: 'situation' })

      const byId = new Map(candidates.map((p) => [p.id, p]))
      const finalRows = curated
        .map((c) => {
          const base = byId.get(c.id)
          if (!base) return null
          return { ...base, ...c }
        })
        .filter(Boolean)

      const rowsToShow = finalRows.length > 0 ? finalRows : candidates.slice(0, 10)

      setPassages(rowsToShow)
      setStatus(`Loaded ${rowsToShow.length} passages`)
    } catch (e) {
      setError({ message: e?.message ?? String(e) })
      setPassages([])
      setStatus('ERROR')
    } finally {
      setLoading(false)
    }
  }

  function resetSituation() {
    setSituationText('')
    setMatchedThemeIds([])
    setPassages([])
    setStatus('')
    setError(null)
  }

  async function runTheology() {
    try {
      setLoading(true)
      setError(null)
      setStatus('Generating theology plan…')
      setTheologyTopic('')
      setTheologySteps([])
      setPassages([])

      if (!theologyQuestion.trim()) {
        setStatus('Type a question first.')
        return
      }

      const res = await fetch('/api/theology', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: theologyQuestion }),
      })

      const text = await res.text()
      let json
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error(`Non-JSON response (${res.status}). First 200 chars: ${text.slice(0, 200)}`)
      }

      if (!res.ok) throw new Error(json?.error ?? 'Theology mode failed')

      setTheologyTopic(json.topic ?? '')
      setTheologySteps(Array.isArray(json.steps) ? json.steps : [])
      setStatus(`Loaded plan: ${json.topic ?? 'Theology'}`)
    } catch (e) {
      setError({ message: e?.message ?? String(e) })
      setStatus('ERROR')
    } finally {
      setLoading(false)
    }
  }

  function resetTheology() {
    setTheologyQuestion('')
    setTheologyTopic('')
    setTheologySteps([])
    setStatus('')
    setError(null)
  }

  function PassageCard({ p }) {
    return (
      <div
        key={p.id ?? `${p.ref}-${p.esv_url}`}
        style={{ border: '1px solid #ddd', borderRadius: 12, padding: 16 }}
      >
        <div style={{ fontWeight: 800, fontSize: 16 }}>{p.ref}</div>

        <div style={{ marginTop: 6, fontSize: 13, opacity: 0.8 }}>
          {(p.genre ?? '—')} • {(p.unit ?? '—')} • {(p.ref_key ?? '—')}
          {typeof p.distance === 'number' ? ` • dist: ${p.distance.toFixed(3)}` : ''}
          {typeof p.similarity === 'number' ? ` • sim: ${p.similarity.toFixed(3)}` : ''}
        </div>

        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.9 }}>
          <b>Arc:</b> {ARC_LABELS[p.arc] ?? p.arc ?? 'Other'}
        </div>

        {p.primary_category ? (
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.9 }}>
            <b>{p.primary_category}</b>
            {Array.isArray(p.secondary_categories) && p.secondary_categories.length > 0
              ? ` • ${p.secondary_categories.join(', ')}`
              : ''}
          </div>
        ) : null}

        {p.why ? <div style={{ marginTop: 8, fontSize: 13, opacity: 0.9 }}>{p.why}</div> : null}

        <div style={{ marginTop: 10 }}>
          {p.esv_url ? (
            <a href={p.esv_url} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
              Open in ESV
            </a>
          ) : (
            <em>(No ESV link)</em>
          )}
        </div>

        {p.notes && (
          <div style={{ marginTop: 10 }}>
            <b>Notes:</b> {p.notes}
          </div>
        )}
      </div>
    )
  }

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui' }}>
      <h1>Bible Tool</h1>

      <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
        <button
          onClick={() => setMode('situation')}
          style={{
            padding: '8px 12px',
            borderRadius: 10,
            border: '1px solid #ddd',
            fontWeight: mode === 'situation' ? 800 : 500,
          }}
        >
          Situation Mode
        </button>

        <button
          onClick={() => setMode('theology')}
          style={{
            padding: '8px 12px',
            borderRadius: 10,
            border: '1px solid #ddd',
            fontWeight: mode === 'theology' ? 800 : 500,
          }}
        >
          Theology Mode (Plans)
        </button>
      </div>

      {mode === 'situation' && (
        <section style={{ marginTop: 16 }}>
          <h2 style={{ margin: 0 }}>Describe what you’re facing</h2>
          <p style={{ marginTop: 6, opacity: 0.8 }}>
            We map your input to a theme, pull candidates, then curate along a Christ-centered arc.
          </p>

          <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
            <input
              value={situationText}
              onChange={(e) => setSituationText(e.target.value)}
              placeholder="Example: I’m anxious about money and the future"
              style={{ padding: 10, borderRadius: 10, border: '1px solid #ddd', minWidth: 320 }}
            />

            <button
              onClick={runSituationSearch}
              disabled={loadingThemes || loading || !situationText.trim()}
              style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #ddd' }}
            >
              {loading ? 'Loading…' : 'Get passages'}
            </button>

            <button
              onClick={resetSituation}
              disabled={loading}
              style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #ddd' }}
            >
              Reset
            </button>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {quickSituations.map((s) => (
              <button
                key={s}
                onClick={() => setSituationText(s)}
                style={{ padding: '6px 10px', borderRadius: 999, border: '1px solid #ddd' }}
              >
                {s}
              </button>
            ))}
          </div>

          {matchedThemeIds.length > 0 && (
            <div style={{ marginTop: 10, opacity: 0.85 }}>
              <b>Matched themes:</b>{' '}
              {matchedThemeIds
                .map((id) => themes.find((t) => String(t.id) === String(id)))
                .filter(Boolean)
                .map((t) => themeDisplayName(t))
                .join(', ')}
            </div>
          )}

          <div style={{ display: 'grid', gap: 18, marginTop: 16 }}>
            {(() => {
              const grouped = groupByArc(passages)
              const arcsToShow = ARC_ORDER.filter((arc) => (grouped[arc] ?? []).length > 0)
              if (arcsToShow.length === 0) return null

              return arcsToShow.map((arc) => (
                <section key={arc} style={{ display: 'grid', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                    <h2 style={{ margin: 0, fontSize: 16 }}>{ARC_LABELS[arc] ?? arc}</h2>
                    <span style={{ opacity: 0.7, fontSize: 12 }}>{(grouped[arc] ?? []).length}</span>
                  </div>

                  <div style={{ display: 'grid', gap: 12 }}>
                    {(grouped[arc] ?? []).map((p) => (
                      <PassageCard key={p.id ?? `${p.ref}-${p.esv_url}`} p={p} />
                    ))}
                  </div>
                </section>
              ))
            })()}
          </div>
        </section>
      )}

      {mode === 'theology' && (
        <section style={{ marginTop: 16 }}>
          <h2 style={{ margin: 0 }}>Ask a theological question</h2>
          <p style={{ marginTop: 6, opacity: 0.8 }}>
            We generate a study plan, retrieve passages, then curate for: God, humanity/sin, Christ, apostolic teaching, gospel.
          </p>

          <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
            <input
              value={theologyQuestion}
              onChange={(e) => setTheologyQuestion(e.target.value)}
              placeholder="Example: What is justification?"
              style={{ padding: 10, borderRadius: 10, border: '1px solid #ddd', minWidth: 320 }}
            />

            <button
              onClick={runTheology}
              disabled={loading || !theologyQuestion.trim()}
              style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #ddd' }}
            >
              {loading ? 'Loading…' : 'Generate plan'}
            </button>

            <button
              onClick={resetTheology}
              disabled={loading}
              style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #ddd' }}
            >
              Reset
            </button>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {quickTheology.map((q) => (
              <button
                key={q}
                onClick={() => setTheologyQuestion(q)}
                style={{ padding: '6px 10px', borderRadius: 999, border: '1px solid #ddd' }}
              >
                {q}
              </button>
            ))}
          </div>

          {theologyTopic ? (
            <div style={{ marginTop: 12, opacity: 0.9 }}>
              <b>Topic:</b> {theologyTopic}
            </div>
          ) : null}

          <div style={{ display: 'grid', gap: 18, marginTop: 16 }}>
            {(theologySteps ?? [])
              .filter((step) => (step.passages ?? []).length > 0) // ✅ hide empty steps
              .map((step, idx) => {
                const grouped = groupByArc(step.passages ?? [])
                const arcsToShow = ARC_ORDER.filter((arc) => (grouped[arc] ?? []).length > 0)

                if (arcsToShow.length === 0) return null // ✅ safety

                const count = (step.passages ?? []).length

                return (
                  <section
                    key={`${step.step_title}-${idx}`}
                    style={{ border: '1px solid #ddd', borderRadius: 12, padding: 16 }}
                  >
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                      <div>
                        <div style={{ fontWeight: 900, fontSize: 16 }}>{step.step_title ?? `Step ${idx + 1}`}</div>
                        {step.step_goal ? <div style={{ marginTop: 6, opacity: 0.85 }}>{step.step_goal}</div> : null}
                      </div>

                      <div style={{ opacity: 0.7, fontSize: 12 }}>{count} passages</div>
                    </div>

                    <div style={{ display: 'grid', gap: 18, marginTop: 14 }}>
                      {arcsToShow.map((arc) => (
                        <div key={`${idx}-${arc}`} style={{ display: 'grid', gap: 10 }}>
                          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                            <h3 style={{ margin: 0, fontSize: 14 }}>{ARC_LABELS[arc] ?? arc}</h3>
                            <span style={{ opacity: 0.65, fontSize: 12 }}>{(grouped[arc] ?? []).length}</span>
                          </div>

                          <div style={{ display: 'grid', gap: 12 }}>
                            {(grouped[arc] ?? []).map((p) => (
                              <PassageCard key={p.id ?? `${p.ref}-${p.esv_url}`} p={p} />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )
              })}
          </div>
        </section>
      )}

      {status && (
        <p style={{ marginTop: 16 }}>
          <b>Status:</b> {status}
        </p>
      )}

      {error && (
        <pre style={{ marginTop: 12, background: '#fee', padding: 12, borderRadius: 8, overflowX: 'auto' }}>
          {JSON.stringify(error, null, 2)}
        </pre>
      )}
    </main>
  )
}