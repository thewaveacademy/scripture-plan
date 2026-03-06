'use client'

import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

export default function Home() {
  const [themes, setThemes] = useState([])
  const [selectedThemeId, setSelectedThemeId] = useState('')
  const [matchedThemeIds, setMatchedThemeIds] = useState([])
  const [passages, setPassages] = useState([])

  const [mode, setMode] = useState('situation') // 'situation' | 'manual'
  const [situationText, setSituationText] = useState('')

  const [loadingThemes, setLoadingThemes] = useState(true)
  const [loadingPassages, setLoadingPassages] = useState(false)
  const [error, setError] = useState(null)
  const [status, setStatus] = useState('')

  const [shareBusy, setShareBusy] = useState(false)

  const quickSituations = [
    'I feel anxious about the future',
    'I need guidance for a decision',
    'I’m struggling with temptation',
    'I’m grieving and need comfort',
    'I’m angry and need self-control',
    'I feel lonely',
  ]

  function themeDisplayName(t) {
    return t?.name ?? t?.label ?? t?.title ?? `Theme ${t?.id ?? ''}`
  }

  // Load themes for dropdown + LLM choices
  useEffect(() => {
    async function loadThemes() {
      setLoadingThemes(true)
      setError(null)

      const res = await supabase.from('themes').select('*').order('id', { ascending: true })

      if (res.error) {
        setError(res.error)
        setThemes([])
      } else {
        const data = res.data ?? []
        setThemes(data)
        if (!selectedThemeId && data.length > 0) {
          setSelectedThemeId(String(data[0].id))
        }
      }

      setLoadingThemes(false)
    }

    loadThemes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectedTheme = useMemo(() => {
    return themes.find((t) => String(t.id) === String(selectedThemeId))
  }, [themes, selectedThemeId])

  // --------- LLM → Theme(s) ----------
  async function llmPickThemes(input) {
    const themeList = themes.map((t) => ({
      id: t.id,
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

  // --------- Embedding Search (server route) ----------
  async function semanticSearch(themeId, input, matchCount = 10) {
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

    // route returns { results: [...] } OR { passages: [...] }
    const rows = json.results ?? json.passages ?? []
    return Array.isArray(rows) ? rows : []
  }

  // --------- Situation Mode ----------
  async function runSituationSearch() {
    try {
      setLoadingPassages(true)
      setError(null)
      setStatus('Interpreting input…')
      setPassages([])
      setMatchedThemeIds([])

      if (!situationText.trim()) {
        setStatus('Type something first.')
        return
      }

      const ids = await llmPickThemes(situationText)
      setMatchedThemeIds(ids)

      if (ids.length === 0) {
        setStatus('No matching themes found. Try different wording.')
        return
      }

      const primaryThemeId = ids[0]
      setStatus('Searching most relevant passages…')

      const results = await semanticSearch(primaryThemeId, situationText, 10)
      setPassages(results)

      setStatus(`Loaded ${results.length} passages`)
    } catch (e) {
      setError({ message: e?.message ?? String(e) })
      setPassages([])
      setStatus('ERROR')
    } finally {
      setLoadingPassages(false)
    }
  }

  function resetSituation() {
    setSituationText('')
    setMatchedThemeIds([])
    setPassages([])
    setStatus('')
    setError(null)
  }

  // --------- Manual Mode ----------
  useEffect(() => {
    if (mode !== 'manual') return
    if (!selectedThemeId) return

    async function run() {
      try {
        setLoadingPassages(true)
        setError(null)
        setStatus('Searching passages for selected theme…')
        setMatchedThemeIds([])

        // Default query so vector search can rank within the theme.
        const q = themeDisplayName(selectedTheme ?? { id: selectedThemeId })

        const results = await semanticSearch(selectedThemeId, q, 10)
        setPassages(results)
        setStatus(`Loaded ${results.length} passages`)
      } catch (e) {
        setError({ message: e?.message ?? String(e) })
        setPassages([])
        setStatus('ERROR')
      } finally {
        setLoadingPassages(false)
      }
    }

    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedThemeId, mode])

  // --------- Export / Share ----------
  function buildShareText() {
    const dt = new Date().toLocaleString()

    const themeNames =
      matchedThemeIds?.length > 0
        ? matchedThemeIds
            .map((id) => themes.find((t) => String(t.id) === String(id)))
            .filter(Boolean)
            .map((t) => themeDisplayName(t))
            .join(', ')
        : ''

    const header = [
      'Super Bible Tool — Scripture Guidance',
      `Generated: ${dt}`,
      mode === 'situation'
        ? `Input: ${situationText || ''}`
        : `Theme: ${themeDisplayName(selectedTheme ?? { id: selectedThemeId })}`,
      themeNames ? `Matched themes: ${themeNames}` : '',
      '',
    ]
      .filter(Boolean)
      .join('\n')

    // Supports optional arc fields if present (arc_label, step_label)
    const body = (passages ?? [])
      .map((p) => {
        const lines = []
        lines.push(`• ${p.ref ?? '(no ref)'}`)

        const arc = p.arc_label ?? p.arc ?? p.role ?? null
        const step = p.step_label ?? p.step ?? null

        if (arc) lines.push(`  - Arc: ${arc}`)
        if (step) lines.push(`  - Step: ${step}`)
        if (p.esv_url) lines.push(`  - Link: ${p.esv_url}`)
        if (p.notes) lines.push(`  - Notes: ${p.notes}`)
        return lines.join('\n')
      })
      .join('\n\n')

    return `${header}\n${body}\n`
  }

  async function copyToClipboard() {
    try {
      const text = buildShareText()
      await navigator.clipboard.writeText(text)
      setStatus('Copied to clipboard ✅')
    } catch (e) {
      setError({ message: e?.message ?? String(e) })
      setStatus('Copy failed ❌')
    }
  }

  function downloadTxt() {
    try {
      const text = buildShareText()
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `bible-tool-${new Date().toISOString().slice(0, 10)}.txt`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      setStatus('Downloaded .txt ✅')
    } catch (e) {
      setError({ message: e?.message ?? String(e) })
      setStatus('Download failed ❌')
    }
  }

  async function shareNative() {
    try {
      const text = buildShareText()
      if (!navigator.share) {
        setStatus('Native share not supported on this device.')
        return
      }
      await navigator.share({
        title: 'Bible Tool — Scripture Guidance',
        text,
      })
      setStatus('Shared ✅')
    } catch (e) {
      const msg = e?.message ?? String(e)
      if (!/abort|cancel/i.test(msg)) {
        setError({ message: msg })
        setStatus('Share failed ❌')
      }
    }
  }

  // Creates a share link by calling /api/share
  // Expect response: { share_id: "abc123" } or { id: "abc123" }
  async function copyShareLink() {
    try {
      setShareBusy(true)
      setError(null)
      setStatus('Creating share link…')

      const payload = {
        mode,
        input: situationText || null,
        matched_theme_ids: matchedThemeIds?.map((x) => String(x)) ?? [],
        theme_id: mode === 'manual' ? String(selectedThemeId || '') : null,
        // Keep the stored payload small + stable
        passages: (passages ?? []).map((p) => ({
          ref: p.ref ?? null,
          ref_key: p.ref_key ?? null,
          esv_url: p.esv_url ?? null,
          arc_label: p.arc_label ?? p.arc ?? p.role ?? null,
          step_label: p.step_label ?? p.step ?? null,
          similarity: typeof p.similarity === 'number' ? p.similarity : null,
        })),
      }

      const res = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.error ?? 'Share API failed')

      const shareId = json.share_id ?? json.id
      if (!shareId) throw new Error('Share API returned no share_id')

      const link = `${window.location.origin}/share/${shareId}`

      // Clipboard may fail on insecure context; fallback to prompt
      try {
        await navigator.clipboard.writeText(link)
        setStatus('Share link copied ✅')
      } catch {
        window.prompt('Copy this share link:', link)
        setStatus('Share link ready ✅')
      }
    } catch (e) {
      setError({ message: e?.message ?? String(e) })
      setStatus('Share link failed ❌')
    } finally {
      setShareBusy(false)
    }
  }

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui' }}>
      <h1>Bible Tool</h1>

      {/* Mode toggle */}
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
          Situation Mode (LLM + Semantic Search)
        </button>

        <button
          onClick={() => setMode('manual')}
          style={{
            padding: '8px 12px',
            borderRadius: 10,
            border: '1px solid #ddd',
            fontWeight: mode === 'manual' ? 800 : 500,
          }}
        >
          Manual Theme Mode (Semantic Search)
        </button>
      </div>

      {/* Situation Mode */}
      {mode === 'situation' && (
        <section style={{ marginTop: 16 }}>
          <h2 style={{ margin: 0 }}>Describe what you’re facing</h2>
          <p style={{ marginTop: 6, opacity: 0.8 }}>
            We map your input to a theme, then return the most relevant passages (links only).
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
              disabled={loadingThemes || loadingPassages || !situationText.trim()}
              style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #ddd' }}
            >
              {loadingPassages ? 'Loading…' : 'Get passages'}
            </button>

            <button
              onClick={resetSituation}
              disabled={loadingPassages}
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
        </section>
      )}

      {/* Manual Mode */}
      {mode === 'manual' && (
        <section style={{ marginTop: 16 }}>
          <h2 style={{ margin: 0 }}>Browse by theme</h2>

          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
            <label style={{ fontWeight: 700 }}>Theme</label>

            {loadingThemes ? (
              <span>Loading themes…</span>
            ) : (
              <select
                value={selectedThemeId}
                onChange={(e) => setSelectedThemeId(e.target.value)}
                style={{ padding: 8, borderRadius: 8 }}
              >
                {themes.map((t) => (
                  <option key={t.id} value={String(t.id)}>
                    {themeDisplayName(t)}
                  </option>
                ))}
              </select>
            )}

            {selectedTheme && (
              <span style={{ opacity: 0.75 }}>
                Showing: <b>{themeDisplayName(selectedTheme)}</b>
              </span>
            )}
          </div>
        </section>
      )}

      {/* Status + Errors */}
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

      {/* Export / Share */}
      {passages.length > 0 && (
        <section style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            onClick={copyToClipboard}
            style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #ddd' }}
          >
            Copy
          </button>

          <button
            onClick={downloadTxt}
            style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #ddd' }}
          >
            Download .txt
          </button>

          <button
            onClick={shareNative}
            style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #ddd' }}
          >
            Share…
          </button>

          <button
            onClick={copyShareLink}
            disabled={shareBusy}
            style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #ddd' }}
            title="Creates a shareable link via /api/share"
          >
            {shareBusy ? 'Creating link…' : 'Copy share link'}
          </button>

          <span style={{ opacity: 0.7, alignSelf: 'center' }}>
            Exports your input + selected passages (links only).
          </span>
        </section>
      )}

      {/* Results */}
      <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
        {passages.map((p) => (
          <div key={p.id ?? `${p.ref}-${p.esv_url}`} style={{ border: '1px solid #ddd', borderRadius: 12, padding: 16 }}>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{p.ref}</div>

            <div style={{ marginTop: 6, fontSize: 13, opacity: 0.8 }}>
              {(p.genre ?? '—')} • {(p.unit ?? '—')} • {(p.ref_key ?? '—')}
              {typeof p.similarity === 'number' ? ` • sim: ${p.similarity.toFixed(3)}` : ''}
              {(p.arc_label ?? p.arc ?? p.role) ? ` • arc: ${p.arc_label ?? p.arc ?? p.role}` : ''}
              {(p.step_label ?? p.step) ? ` • step: ${p.step_label ?? p.step}` : ''}
            </div>

            <div style={{ marginTop: 10 }}>
              {p.esv_url ? (
                <a href={p.esv_url} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
                  Open in ESV
                </a>
              ) : (
                <em>(No link)</em>
              )}
            </div>

            {p.notes && (
              <div style={{ marginTop: 10 }}>
                <b>Notes:</b> {p.notes}
              </div>
            )}
          </div>
        ))}
      </div>
    </main>
  )
}