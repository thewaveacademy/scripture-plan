'use client'

import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

export default function Home() {
  const [themes, setThemes] = useState([])
  const [selectedThemeId, setSelectedThemeId] = useState('')
  const [matchedThemeIds, setMatchedThemeIds] = useState([])
  const [passages, setPassages] = useState([])

  const [mode, setMode] = useState('situation') // 'situation' | 'theology'
  const [situationText, setSituationText] = useState('')
  const [theologyText, setTheologyText] = useState('')

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

  const quickTheology = [
    'What does the Bible say about salvation?',
    'What does the Bible teach about faith?',
    'What does scripture say about baptism?',
    'What does the Bible say about forgiveness?',
    'What does the Bible teach about grace?',
    'What does the Bible say about suffering?',
  ]

  function themeDisplayName(t) {
    return t?.name ?? t?.label ?? t?.title ?? `Theme ${t?.id ?? ''}`
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

    const rows = json.results ?? json.passages ?? []
    return Array.isArray(rows) ? rows : []
  }

  async function theologySearch(input, matchCount = 10) {
    const res = await fetch('/api/theology', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input,
        match_count: matchCount,
      }),
    })

    const json = await res.json()
    if (!res.ok) throw new Error(json?.error ?? 'Theology search failed')

    const rows = json.results ?? json.passages ?? []
    return Array.isArray(rows) ? rows : []
  }

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

  async function runTheologySearch() {
    try {
      setLoadingPassages(true)
      setError(null)
      setStatus('Searching theology passages…')
      setPassages([])
      setMatchedThemeIds([])

      if (!theologyText.trim()) {
        setStatus('Type a theology question first.')
        return
      }

      const results = await theologySearch(theologyText, 10)
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

  function resetTheology() {
    setTheologyText('')
    setMatchedThemeIds([])
    setPassages([])
    setStatus('')
    setError(null)
  }

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
      'Bible Tool — Scripture Guidance',
      `Generated: ${dt}`,
      mode === 'situation'
        ? `Situation input: ${situationText || ''}`
        : `Theology question: ${theologyText || ''}`,
      themeNames ? `Matched themes: ${themeNames}` : '',
      '',
    ]
      .filter(Boolean)
      .join('\n')

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

  async function copyShareLink() {
    try {
      setShareBusy(true)
      setError(null)
      setStatus('Creating share link…')

      const payload = {
        mode,
        input: mode === 'situation' ? situationText || null : theologyText || null,
        matched_theme_ids: matchedThemeIds?.map((x) => String(x)) ?? [],
        theme_id: null,
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
          Theology Mode
        </button>
      </div>

      {mode === 'situation' && (
        <section style={{ marginTop: 16 }}>
          <h2 style={{ margin: 0 }}>Describe what you’re facing</h2>
          <p style={{ marginTop: 6, opacity: 0.8 }}>
            We map your input to a theme, then return the most relevant passages.
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

      {mode === 'theology' && (
        <section style={{ marginTop: 16 }}>
          <h2 style={{ margin: 0 }}>Ask a theology question</h2>
          <p style={{ marginTop: 6, opacity: 0.8 }}>
            Ask a doctrinal or Bible teaching question and get relevant passages.
          </p>

          <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
            <input
              value={theologyText}
              onChange={(e) => setTheologyText(e.target.value)}
              placeholder="Example: What does the Bible say about salvation?"
              style={{ padding: 10, borderRadius: 10, border: '1px solid #ddd', minWidth: 320 }}
            />

            <button
              onClick={runTheologySearch}
              disabled={loadingPassages || !theologyText.trim()}
              style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #ddd' }}
            >
              {loadingPassages ? 'Loading…' : 'Get theology passages'}
            </button>

            <button
              onClick={resetTheology}
              disabled={loadingPassages}
              style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #ddd' }}
            >
              Reset
            </button>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {quickTheology.map((q) => (
              <button
                key={q}
                onClick={() => setTheologyText(q)}
                style={{ padding: '6px 10px', borderRadius: 999, border: '1px solid #ddd' }}
              >
                {q}
              </button>
            ))}
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
            Exports your input + selected passages.
          </span>
        </section>
      )}

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