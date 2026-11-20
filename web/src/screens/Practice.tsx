import { useMemo, useRef, useState } from 'react'
import type { InferenceSource } from 'firebase/ai'
import { generateSusDeck, warmUpOnDeviceModel, type SusRound } from '../ai/susGenerator'
import { isFirebaseConfigured } from '../firebase'
import { Brand, Highlighted, NotesForm, SourceChip, type DeckRequest } from '../components/ui'

type Status = 'idle' | 'working' | 'done' | 'error'

interface Timing {
  started: number
  firstCard?: number
  total?: number
}

/** Solo mode: make a deck and pick the sus card in each pair. */
export function Practice() {
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState('')
  const [download, setDownload] = useState<number | null>(null)
  const [rounds, setRounds] = useState<SusRound[]>([])
  const [expected, setExpected] = useState(0)
  const [factsSource, setFactsSource] = useState<InferenceSource | null>(null)
  const [timing, setTiming] = useState<Timing | null>(null)
  const runId = useRef(0)

  async function makeGame({ notes, rounds: roundCount, mode }: DeckRequest) {
    const run = ++runId.current
    const started = performance.now()
    setStatus('working')
    setError('')
    setRounds([])
    setExpected(roundCount)
    setFactsSource(null)
    setTiming({ started })
    try {
      if (mode === 'private') {
        // Kick off Gemini Nano inside the click (Chrome needs a user gesture).
        warmUpOnDeviceModel((p) => setDownload(p < 1 ? p : null)).catch(() => setDownload(null))
      }
      const all = await generateSusDeck(notes, roundCount, mode, {
        onFacts: (count, source) => {
          if (run !== runId.current) return
          setExpected(count)
          setFactsSource(source)
        },
        onRound: (round) => {
          if (run !== runId.current) return
          setRounds((prev) => [...prev, round])
          setTiming((t) => (t && t.firstCard === undefined ? { ...t, firstCard: performance.now() - t.started } : t))
        },
      })
      if (run !== runId.current) return
      setExpected(all.length)
      setTiming((t) => (t ? { ...t, total: performance.now() - t.started } : t))
      setStatus('done')
    } catch (e) {
      if (run !== runId.current) return
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }

  const pending = status === 'working' ? Math.max(0, expected - rounds.length) : 0

  return (
    <main className="shell">
      <Brand />
      <p className="crumb">
        <a href="#/">← Home</a> · Practice solo
      </p>

      {!isFirebaseConfigured && (
        <p className="banner">
          Firebase isn't connected yet. Copy <code>web/.env.example</code> to <code>web/.env.local</code> and fill in
          your project's web config.
        </p>
      )}

      <NotesForm
        submitLabel="Make the game"
        busyLabel="Hiding liars in your notes…"
        busy={status === 'working'}
        disabled={!isFirebaseConfigured}
        onSubmit={makeGame}
        footer={
          <>
            {download !== null && (
              <p className="hint">
                Downloading Gemini Nano to this laptop: {Math.round(download * 100)}% (using cloud meanwhile)
              </p>
            )}
            {status === 'error' && <p className="error">{error}</p>}
          </>
        }
      />

      {status !== 'idle' && status !== 'error' && (
        <section className="deck" aria-live="polite">
          <DeckStatus status={status} factsSource={factsSource} timing={timing} ready={rounds.length} expected={expected} />
          {rounds.map((round, i) => (
            <RoundPreview key={i} index={i} round={round} />
          ))}
          {Array.from({ length: pending }, (_, i) => (
            <article key={`pending-${i}`} className="round pending">
              <h2>
                <span className="num">{rounds.length + i + 1}</span> Cooking up a lie…
              </h2>
              <div className="cards">
                <div className="card skeleton" />
                <div className="card skeleton" />
              </div>
            </article>
          ))}
        </section>
      )}
    </main>
  )
}

function seconds(ms?: number) {
  return ms === undefined ? '' : `${(ms / 1000).toFixed(1)}s`
}

function DeckStatus(props: {
  status: Status
  factsSource: InferenceSource | null
  timing: Timing | null
  ready: number
  expected: number
}) {
  const { status, factsSource, timing, ready, expected } = props
  if (!factsSource) return <p className="badge neutral">Reading your notes…</p>
  const onDevice = factsSource === 'on_device'
  return (
    <p className={`badge ${onDevice ? 'device' : 'cloud'}`}>
      {onDevice ? '🔒 Made on your device — notes never left this laptop' : '☁️ Made in the cloud'}
      <span>
        {' · '}
        {status === 'done'
          ? `${ready} rounds · first card ${seconds(timing?.firstCard)} · all ${seconds(timing?.total)}`
          : `${ready} of ${expected} ready${timing?.firstCard !== undefined ? ` · first card ${seconds(timing.firstCard)}` : ''}`}
      </span>
    </p>
  )
}

function RoundPreview({ round, index }: { round: SusRound; index: number }) {
  const [picked, setPicked] = useState<number | null>(null)
  // Shuffle once per round so the sus card isn't always on the same side.
  const cards = useMemo(() => {
    const pair = [
      { text: round.realCard, sus: false },
      { text: round.susCard, sus: true },
    ]
    return Math.random() < 0.5 ? pair : pair.reverse()
  }, [round])
  const revealed = picked !== null

  return (
    <article className="round">
      <h2>
        <span className="num">{index + 1}</span> {round.topic}
        <SourceChip source={round.source} />
      </h2>
      <p className="ask">{revealed ? (cards[picked].sus ? 'You caught it! 🎯' : 'Fooled you 😈') : 'Which card is sus?'}</p>
      <div className="cards">
        {cards.map((c, i) => (
          <button
            key={i}
            type="button"
            className={`card ${revealed ? (c.sus ? 'is-sus' : 'is-real') : ''} ${picked === i ? 'picked' : ''}`}
            onClick={() => !revealed && setPicked(i)}
            disabled={revealed}
          >
            {revealed && <span className="tag">{c.sus ? 'SUS' : 'REAL'}</span>}
            {revealed && c.sus ? <Highlighted text={c.text} phrase={round.lie} /> : c.text}
          </button>
        ))}
      </div>
      {revealed && (
        <div className="reveal">
          <p>
            <strong>The lie:</strong> “{round.lie}” instead of “{round.truth}”
          </p>
          {round.explanation && <p>{round.explanation}</p>}
        </div>
      )}
    </article>
  )
}
