import './firebaseExt'
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { generateSusDeck, warmUpOnDeviceModel, type SusRound } from '../../src/ai/susGenerator'
import { readStudyFile, renderPdfPages, ScannedPdfError } from '../../src/ai/readFile'
import { Highlighted } from '../../src/components/ui'
import { HANDOFF_KEY, PENDING_KEY, SITE_URL, type Handoff, type PendingQuiz } from './messages'
import '../../src/index.css'
import '../../src/App.css'
import './sidepanel.css'

type NanoState = 'checking' | 'available' | 'downloadable' | 'downloading' | 'unavailable'
type Phase = 'idle' | 'reading' | 'thinking' | 'scanned' | 'done' | 'error'

interface PageNotes {
  text: string
  title: string
  kind: 'selection' | 'page' | 'pdf'
}

const MIN_CHARS = 80
/** Scanned pages handed to the website for fast cloud reading. */
const SCAN_PAGES_FOR_WEBSITE = 4

function isPdfUrl(url: string | undefined): boolean {
  return !!url && /\.pdf($|[?#])/i.test(url)
}

/** Injected into the page: the selection if there is one, otherwise the main readable text. */
function extractPage() {
  // Chrome's built-in PDF viewer: hand back the file's address so the panel can parse the PDF itself.
  if (document.contentType === 'application/pdf') return { kind: 'pdf', text: '', title: document.title, url: location.href }
  const sel = String(getSelection() ?? '').trim()
  if (sel.length >= 80) return { kind: 'selection', text: sel, title: document.title }
  const root = document.querySelector('article, main, [role="main"]') ?? document.body
  const text = (root as HTMLElement).innerText.replace(/\n{3,}/g, '\n\n').trim()
  return { kind: 'page', text, title: document.title }
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return tab
}

function originPattern(url: string | undefined): string | null {
  if (!url) return null
  if (url.startsWith('file:')) return 'file:///*'
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? `${u.origin}/*` : null
  } catch {
    return null
  }
}

class NeedsAccess extends Error {}

/** A scanned PDF: we stop and let the student choose fast (cloud, website) or private (slow, here). */
class ScannedTab extends Error {
  readonly file: File
  readonly title: string
  readonly totalPages: number
  constructor(file: File, title: string, totalPages: number) {
    super('scanned')
    this.file = file
    this.title = title
    this.totalPages = totalPages
  }
}

async function readTab(selection: string | undefined, onStatus: (s: string) => void): Promise<PageNotes> {
  const tab = await activeTab()
  if (!tab?.id) throw new Error('Open a page first.')
  if (selection && selection.length >= MIN_CHARS) return { text: selection, title: tab.title ?? 'Selection', kind: 'selection' }
  if (/^(chrome|edge|about|chrome-extension):/.test(tab.url ?? '')) {
    throw new Error("Chrome doesn't let extensions read this page. Open your notes, slides or an article.")
  }

  if (isPdfUrl(tab.url)) return readPdfTab(tab.url!, tab.title, onStatus)

  onStatus('Reading this page…')
  let data: (PageNotes & { url?: string }) | undefined
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPage })
    data = res?.result as (PageNotes & { url?: string }) | undefined
  } catch {
    throw new NeedsAccess()
  }
  if (data?.kind === 'pdf' && data.url) return readPdfTab(data.url, data.title, onStatus)
  if (!data?.text) throw new Error("Couldn't find any text on this page. Try selecting a paragraph first.")
  return data
}

/** fetch() can't read file:// addresses, but XHR can once "Allow access to file URLs" is on. */
function loadBlob(url: string): Promise<Blob> {
  if (!url.startsWith('file:')) {
    return fetch(url).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.blob()
    })
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', url)
    xhr.responseType = 'blob'
    xhr.onload = () => (xhr.response instanceof Blob && xhr.response.size > 0 ? resolve(xhr.response) : reject(new Error('empty')))
    xhr.onerror = () => reject(new Error('blocked'))
    xhr.send()
  })
}

async function readPdfTab(url: string, title: string | undefined, onStatus: (s: string) => void): Promise<PageNotes> {
  onStatus('Opening PDF…')
  let blob: Blob
  try {
    blob = await loadBlob(url)
  } catch {
    if (url.startsWith('file:')) {
      throw new Error('To read PDFs from your computer, turn on "Allow access to file URLs" for Sus in chrome://extensions → Details.')
    }
    throw new NeedsAccess()
  }
  const name = decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() || title || 'notes.pdf')
  const file = new File([blob], name, { type: 'application/pdf' })
  try {
    // Text PDFs are read instantly; scanned ones make us stop and ask.
    const result = await readStudyFile(file, 'device', onStatus, { scanned: 'ask' })
    return { text: result.text, title: title || name, kind: 'pdf' }
  } catch (e) {
    if (e instanceof ScannedPdfError) throw new ScannedTab(file, title || name, e.totalPages)
    throw e
  }
}

function SidePanel() {
  const [nano, setNano] = useState<NanoState>('checking')
  const [phase, setPhase] = useState<Phase>('idle')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [needsAccess, setNeedsAccess] = useState<string | null>(null)
  const [scanned, setScanned] = useState<ScannedTab | null>(null)
  const [notes, setNotes] = useState<PageNotes | null>(null)
  const [rounds, setRounds] = useState<SusRound[]>([])
  const [expected, setExpected] = useState(0)
  const [roundCount, setRoundCount] = useState(3)
  const [picks, setPicks] = useState<Record<number, boolean>>({})
  const [elapsed, setElapsed] = useState(0)
  // Each run gets an id; "Stop" bumps it so a slow on-device answer that arrives later is ignored.
  const runId = useRef(0)

  useEffect(() => {
    const lm = (globalThis as { LanguageModel?: { availability: () => Promise<string> } }).LanguageModel
    if (!lm) return setNano('unavailable')
    lm.availability()
      .then((a) => setNano((a as NanoState) ?? 'unavailable'))
      .catch(() => setNano('unavailable'))
  }, [])

  const busy = phase === 'reading' || phase === 'thinking'
  useEffect(() => {
    if (!busy) return
    const started = Date.now()
    setElapsed(0)
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(t)
  }, [busy])

  /** Reads notes with `getNotes`, then makes the deck on-device. */
  const run = useCallback(
    async (getNotes: (onStatus: (s: string) => void) => Promise<PageNotes>) => {
      const id = ++runId.current
      const live = () => id === runId.current
      setError('')
      setNeedsAccess(null)
      setScanned(null)
      setRounds([])
      setPicks({})
      setPhase('reading')
      // Start (or download) Gemini Nano while we still have the click.
      warmUpOnDeviceModel((p) => live() && p < 1 && setStatus(`Downloading Gemini Nano: ${Math.round(p * 100)}%`)).catch(
        () => {},
      )
      try {
        const page = await getNotes((s) => live() && setStatus(s))
        if (!live()) return
        if (page.text.length < MIN_CHARS) throw new Error("There isn't enough text here. Select a paragraph or open your notes.")
        setNotes(page)
        setPhase('thinking')
        setStatus('Finding the key facts…')
        setExpected(roundCount)
        await generateSusDeck(page.text, roundCount, 'device', {
          onFacts: (count) => {
            if (!live()) return
            setExpected(count)
            setStatus('Hiding a lie in each fact…')
          },
          onRound: (round) => live() && setRounds((prev) => [...prev, round]),
        })
        if (live()) setPhase('done')
      } catch (e) {
        if (!live()) return
        if (e instanceof ScannedTab) {
          setScanned(e)
          setPhase('scanned')
          return
        }
        if (e instanceof NeedsAccess) {
          const tab = await activeTab()
          // Without access Chrome may hide the tab's address; then ask once for the pages you quiz.
          setNeedsAccess(originPattern(tab?.url) ?? '<all_urls>')
          setError('To quiz this page, Sus needs your permission to read it.')
        } else {
          setError(e instanceof Error ? e.message : String(e))
        }
        setPhase('error')
      }
    },
    [roundCount],
  )

  const quiz = useCallback((selection?: string) => run((onStatus) => readTab(selection, onStatus)), [run])

  function stop() {
    runId.current++
    setStatus('')
    setPhase(rounds.length ? 'done' : 'idle')
  }

  // Right-click "Quiz me on this with Sus" leaves a request for us in session storage.
  useEffect(() => {
    const take = (pending: PendingQuiz | undefined) => {
      if (!pending || Date.now() - pending.at > 60_000) return
      void chrome.storage.session.remove(PENDING_KEY)
      void quiz(pending.selection)
    }
    chrome.storage.session.get(PENDING_KEY).then((d) => take(d[PENDING_KEY] as PendingQuiz | undefined))
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes[PENDING_KEY]?.newValue) take(changes[PENDING_KEY].newValue as PendingQuiz)
    }
    chrome.storage.onChanged.addListener(onChange)
    return () => chrome.storage.onChanged.removeListener(onChange)
  }, [quiz])

  function allowSite() {
    if (!needsAccess) return
    // Called directly in the click: Chrome only shows permission prompts for user gestures.
    chrome.permissions.request({ origins: [needsAccess] }).then((ok) => {
      if (ok) void quiz()
    })
  }

  async function openOnWebsite(route: 'host' | 'practice', handoff: Omit<Handoff, 'at'>) {
    await chrome.storage.session.set({ [HANDOFF_KEY]: { ...handoff, at: Date.now() } satisfies Handoff })
    await chrome.tabs.create({ url: `${SITE_URL}/#/${route}/handoff` })
  }

  /** Slow device: stop here and let the website make the deck from the same notes with cloud AI. */
  async function fastOnWebsite() {
    if (!notes) return
    const page = notes
    stop()
    await openOnWebsite('practice', { notes: page.text, title: page.title, fast: true })
  }

  /** Scanned PDF, fast path: render pages here (no AI), let the website read them with cloud AI. */
  async function scannedFast(route: 'host' | 'practice') {
    if (!scanned) return
    setPhase('reading')
    try {
      const images = await renderPdfPages(scanned.file, SCAN_PAGES_FOR_WEBSITE, setStatus)
      await openOnWebsite(route, { notes: '', title: scanned.title, images })
      setPhase('scanned')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }

  /** Scanned PDF, private path: read page 1 with Gemini Nano here (slow on CPU-only laptops). */
  function scannedHere() {
    if (!scanned) return
    const { file, title } = scanned
    void run(async (onStatus) => {
      const result = await readStudyFile(file, 'device', onStatus, { scanned: 'read', maxScannedPages: 1 })
      return { text: result.text, title, kind: 'pdf' }
    })
  }

  const caught = Object.values(picks).filter(Boolean).length
  const answered = Object.keys(picks).length
  const pending = phase === 'thinking' ? Math.max(0, expected - rounds.length) : 0

  return (
    <main className="panel-shell">
      <header className="sp-brand">
        <span className="logo" aria-hidden="true">
          ?!
        </span>
        <div>
          <h1>Sus</h1>
          <p>Spot the lie, learn the fact.</p>
        </div>
      </header>

      {nano === 'unavailable' ? (
        <section className="sp-card">
          <h2>This device can't run on-device AI</h2>
          <p className="muted">
            Sus in the side panel uses Gemini Nano, which needs desktop Chrome with enough memory (16 GB RAM or a 4 GB+
            GPU). You can still play on the Sus website with cloud AI.
          </p>
          <a className="primary" href={SITE_URL} target="_blank" rel="noreferrer">
            Open Sus website
          </a>
        </section>
      ) : (
        <section className="sp-card">
          {busy ? (
            <button type="button" className="secondary big-secondary" onClick={stop}>
              ⏹ Stop
            </button>
          ) : (
            <button type="button" className="primary big" onClick={() => void quiz()}>
              {rounds.length ? '🔁 Quiz me again' : '📄 Quiz me on this page'}
            </button>
          )}
          <div className="sp-row">
            <label className="muted">
              Rounds{' '}
              <select value={roundCount} disabled={busy} onChange={(e) => setRoundCount(Number(e.target.value))}>
                {[3, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <span className="chip device">🔒 on-device</span>
          </div>
          <p className="muted small">
            Works on articles, lecture PDFs and selected text. Gemini Nano runs on this laptop, so the page never leaves
            your browser.
            {nano === 'downloadable' && ' The first quiz downloads the AI model (a few minutes, once).'}
          </p>
        </section>
      )}

      {busy && (
        <p className="sp-status" role="status">
          <span className="spinner" aria-hidden="true" /> {status}
          {elapsed >= 3 && <span className="muted"> {elapsed}s</span>}
        </p>
      )}
      {phase === 'thinking' && elapsed >= 15 && notes && (
        <section className="sp-card sp-scanned">
          <p className="muted small">
            {rounds.length === 0
              ? 'On laptops without a graphics card, on-device AI needs a minute or two for the first card.'
              : 'More cards are on the way.'}
          </p>
          <button type="button" className="secondary" onClick={() => void fastOnWebsite()}>
            ⚡ Too slow? Make it in seconds on the Sus website
          </button>
          <p className="muted small">Sends these notes to Google's cloud AI instead of keeping them on this laptop.</p>
        </section>
      )}

      {phase === 'scanned' && scanned && (
        <section className="sp-card sp-scanned">
          <h2>📄 This PDF is scanned</h2>
          <p className="muted small">
            Its pages are pictures, so the AI has to read them like photos. On this laptop that takes about 5 minutes
            per page.
          </p>
          <button type="button" className="primary" onClick={() => void scannedFast('practice')}>
            ⚡ Read it fast on the Sus website
          </button>
          <button type="button" className="secondary" onClick={() => void scannedFast('host')}>
            🎉 Read it fast and play with friends
          </button>
          <p className="muted small">
            Uses Google's cloud AI on the first {Math.min(SCAN_PAGES_FOR_WEBSITE, scanned.totalPages)} pages (takes
            seconds). The page images are sent to Gemini.
          </p>
          <button type="button" className="link small" onClick={scannedHere}>
            🔒 Keep it private: read page 1 here (slow)
          </button>
        </section>
      )}

      {error && (
        <div className="sp-error">
          <p>{error}</p>
          {needsAccess && (
            <>
              <button type="button" className="secondary" onClick={allowSite}>
                {needsAccess === '<all_urls>' ? 'Allow Sus to read pages you quiz' : 'Allow Sus to read this site'}
              </button>
              <p className="muted small">
                Sus only reads a page when you click "Quiz me", and the text stays on your laptop.
              </p>
            </>
          )}
        </div>
      )}

      {notes && (rounds.length > 0 || phase === 'thinking') && (
        <p className="muted small sp-source">
          From <strong>{notes.title}</strong> ({notes.kind === 'selection' ? 'your selection' : notes.kind === 'pdf' ? 'PDF' : 'this page'})
        </p>
      )}

      <div className="sp-rounds">
        {rounds.map((r, i) => (
          <MiniRound key={i} index={i} round={r} onPick={(ok) => setPicks((p) => ({ ...p, [i]: ok }))} />
        ))}
        {Array.from({ length: pending }, (_, i) => (
          <div key={`p${i}`} className="sp-round pending">
            <p className="muted">Round {rounds.length + i + 1}: cooking up a lie…</p>
            <div className="card skeleton" />
          </div>
        ))}
      </div>

      {phase === 'done' && rounds.length > 0 && notes && (
        <section className="sp-card">
          {answered === rounds.length && (
            <p className="sp-score">
              You caught {caught} of {rounds.length} {caught === rounds.length ? '🎉' : '😈'}
            </p>
          )}
          <button type="button" className="primary" onClick={() => void openOnWebsite('host', { notes: notes.text, title: notes.title })}>
            🎉 Play this with friends
          </button>
          <p className="muted small">Opens the Sus website with these notes, ready to make a room.</p>
        </section>
      )}
    </main>
  )
}

function MiniRound({ round, index, onPick }: { round: SusRound; index: number; onPick: (correct: boolean) => void }) {
  const [picked, setPicked] = useState<number | null>(null)
  const cards = useMemo(() => {
    const pair = [
      { text: round.realCard, sus: false },
      { text: round.susCard, sus: true },
    ]
    return Math.random() < 0.5 ? pair : pair.reverse()
  }, [round])
  const revealed = picked !== null

  return (
    <article className="sp-round">
      <p className="sp-round-title">
        <span className="num">{index + 1}</span> {round.topic}
      </p>
      <p className="muted small">
        {revealed ? (cards[picked].sus ? 'You caught it! 🎯' : 'Fooled you 😈') : 'Tap the card that is lying'}
      </p>
      {cards.map((c, i) => (
        <button
          key={i}
          type="button"
          className={`card ${revealed ? (c.sus ? 'is-sus' : 'is-real') : ''}`}
          disabled={revealed}
          onClick={() => {
            setPicked(i)
            onPick(c.sus)
          }}
        >
          {revealed && <span className="tag">{c.sus ? 'SUS' : 'REAL'}</span>}
          {revealed && c.sus ? <Highlighted text={c.text} phrase={round.lie} /> : c.text}
        </button>
      ))}
      {revealed && (
        <p className="reveal small">
          <strong>The lie:</strong> “{round.lie}” instead of “{round.truth}”. {round.explanation}
        </p>
      )}
    </article>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SidePanel />
  </StrictMode>,
)
