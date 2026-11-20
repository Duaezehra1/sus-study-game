import { useState, type ReactNode } from 'react'
import type { SpeedMode } from '../ai/susGenerator'
import { SAMPLE_NOTES } from '../sampleNotes'

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <header className={`brand ${compact ? 'compact' : ''}`}>
      <a className="logo" href="#/" aria-label="Sus home">
        ?!
      </a>
      <div>
        <h1>Sus</h1>
        {!compact && <p className="tagline">One of these cards is lying. Study enough to catch it.</p>}
      </div>
    </header>
  )
}

export function ModeOption(props: { active: boolean; onSelect: () => void; title: string; detail: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.active}
      className={`mode-option ${props.active ? 'active' : ''}`}
      onClick={props.onSelect}
    >
      <strong>{props.title}</strong>
      <span>{props.detail}</span>
    </button>
  )
}

/** Marks the swapped-in phrase inside a sus card. */
export function Highlighted({ text, phrase }: { text: string; phrase: string }) {
  const at = text.toLowerCase().indexOf(phrase.toLowerCase())
  if (at < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + phrase.length)}</mark>
      {text.slice(at + phrase.length)}
    </>
  )
}

export interface DeckRequest {
  notes: string
  rounds: number
  mode: SpeedMode
}

/** Notes box + Private/Fast switch + round count. Shared by Host and Practice. */
export function NotesForm(props: {
  submitLabel: string
  busyLabel: string
  busy: boolean
  disabled?: boolean
  onSubmit: (req: DeckRequest) => void
  footer?: ReactNode
}) {
  const [notes, setNotes] = useState('')
  const [rounds, setRounds] = useState(5)
  const [mode, setMode] = useState<SpeedMode>('private')

  return (
    <section className="panel">
      <div className="panel-head">
        <label htmlFor="notes">Your notes</label>
        <button type="button" className="link" onClick={() => setNotes(SAMPLE_NOTES)}>
          Use sample biology notes
        </button>
      </div>
      <textarea
        id="notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Paste lecture notes, slides or a textbook paragraph…"
        rows={8}
      />

      <div className="mode" role="radiogroup" aria-label="AI mode">
        <ModeOption
          active={mode === 'private'}
          onSelect={() => setMode('private')}
          title="🔒 Private"
          detail="AI runs on this laptop. Notes never leave it."
        />
        <ModeOption
          active={mode === 'fast'}
          onSelect={() => setMode('fast')}
          title="⚡ Fast"
          detail="Cloud AI. Ready in seconds."
        />
      </div>

      <div className="actions">
        <label className="rounds">
          Rounds
          <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))}>
            {[3, 5, 7].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="primary"
          disabled={props.busy || props.disabled}
          onClick={() => props.onSubmit({ notes, rounds, mode })}
        >
          {props.busy ? props.busyLabel : props.submitLabel}
        </button>
      </div>
      {props.footer}
    </section>
  )
}

export function SourceChip({ source }: { source: string | null | undefined }) {
  if (!source) return null
  const onDevice = source === 'on_device'
  return <span className={`chip ${onDevice ? 'device' : 'cloud'}`}>{onDevice ? '🔒 on device' : '☁️ cloud'}</span>
}
