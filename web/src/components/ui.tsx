import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react'
import { warmUpImageModel, type SpeedMode } from '../ai/susGenerator'
import { ACCEPTED_FILES, describeFileKind, readPageImages, readStudyFile, type ReadResult } from '../ai/readFile'
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

export const MIN_NOTES_CHARS = 80

interface LoadedFile {
  name: string
  /** e.g. "1 page · 🔒 read on this device" */
  detail: string
  note?: string
}

function describeResult(r: ReadResult): string {
  return `${r.pages ? `${r.pages} page${r.pages === 1 ? '' : 's'} · ` : ''}${howLabel(r)}`
}

function howLabel(r: ReadResult): string {
  switch (r.how) {
    case 'pdf-text':
    case 'text-file':
      return '🔒 read on this device'
    case 'on_device':
      return '🔒 read by on-device AI'
    default:
      return '☁️ read by cloud AI'
  }
}

/** Notes (typed, pasted, PDF or photo) + Private/Fast switch + round count. Shared by Host and Practice. */
export function NotesForm(props: {
  submitLabel: string
  busyLabel: string
  busy: boolean
  disabled?: boolean
  onSubmit: (req: DeckRequest) => void
  footer?: ReactNode
  /** Notes handed over from the Sus Chrome extension. */
  incoming?: { text: string; label: string; images?: string[]; fast?: boolean } | null
}) {
  const [notes, setNotes] = useState('')
  const [rounds, setRounds] = useState(5)
  const [mode, setMode] = useState<SpeedMode>('private')
  const [reading, setReading] = useState<string | null>(null)
  const [files, setFiles] = useState<LoadedFile[]>([])
  const [fileError, setFileError] = useState('')
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  const [elapsed, setElapsed] = useState(0)

  // Screens pass a fresh `incoming` object on every render, so key the effect on its values
  // (the strings and the images array from state are stable); otherwise notes get appended again and again.
  const incomingText = props.incoming?.text
  const incomingLabel = props.incoming?.label
  const incomingImages = props.incoming?.images
  const incomingFast = props.incoming?.fast
  useEffect(() => {
    if (incomingText === undefined || incomingLabel === undefined) return
    const incoming = { text: incomingText, label: incomingLabel, images: incomingImages, fast: incomingFast }
    const append = (text: string) => setNotes((prev) => (prev.trim() ? `${prev.trim()}\n\n${text}` : text))
    // "Too slow? Make it in seconds" in the extension: start in Fast (cloud) mode.
    if (incoming.fast) setMode('fast')
    if (incoming.text) {
      append(incoming.text)
      setFiles((prev) => [...prev, { name: incoming.label, detail: '🧩 from the Sus Chrome extension' }])
    }
    if (incoming.images?.length) {
      // The student chose "Read it fast" in the extension: scanned pages go to cloud AI.
      setMode('fast')
      setReading('Reading scanned pages…')
      readPageImages(incoming.images, 'fast', setReading)
        .then((result) => {
          append(result.text)
          setFiles((prev) => [
            ...prev,
            { name: incoming.label, detail: `🧩 scanned PDF from the extension · ${describeResult(result)}` },
          ])
        })
        .catch((e) => setFileError(`${incoming.label}: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => setReading(null))
    }
  }, [incomingText, incomingLabel, incomingImages, incomingFast])

  // Live seconds counter while a file is being read, so slow on-device reads never look frozen.
  const isReading = reading !== null
  useEffect(() => {
    if (!isReading) return
    const started = Date.now()
    setElapsed(0)
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [isReading])

  async function handleFiles(list: FileList | File[]) {
    const picked = Array.from(list)
    if (picked.length === 0) return
    setFileError('')
    // Start Gemini Nano while we still have the user's click/drop/paste gesture.
    if (picked.some((f) => describeFileKind(f) !== 'text')) warmUpImageModel(mode)
    for (const file of picked) {
      try {
        setReading(`Opening ${file.name}…`)
        const result = await readStudyFile(file, mode, setReading)
        setNotes((prev) => (prev.trim() ? `${prev.trim()}\n\n${result.text}` : result.text))
        setFiles((prev) => [...prev, { name: file.name, detail: describeResult(result), note: result.note }])
      } catch (e) {
        setFileError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    setReading(null)
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragging(false)
    if (!reading) void handleFiles(e.dataTransfer.files)
  }

  function onPaste(e: ClipboardEvent) {
    const pastedFiles = Array.from(e.clipboardData.files)
    if (pastedFiles.length > 0 && !reading) {
      e.preventDefault()
      void handleFiles(pastedFiles)
    }
  }

  function clearAll() {
    setNotes('')
    setFiles([])
    setFileError('')
  }

  const chars = notes.trim().length
  const enough = chars >= MIN_NOTES_CHARS
  const busy = props.busy || reading !== null

  return (
    <section className="panel form-steps" onPaste={onPaste}>
      {/* ---------- Step 1 ---------- */}
      <div className="step">
        <div className="step-head">
          <span className="step-num">1</span>
          <h2>Add your notes</h2>
          <button type="button" className="link small" onClick={() => setNotes(SAMPLE_NOTES)} disabled={busy}>
            Try sample notes
          </button>
        </div>

        <div
          className={`dropzone ${dragging ? 'dragging' : ''} ${reading ? 'reading' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          {reading ? (
            <>
              <p className="drop-title" role="status">
                <span className="spinner" aria-hidden="true" /> {reading}
                {elapsed >= 3 && <span className="elapsed">{elapsed}s</span>}
              </p>
              {mode === 'private' && elapsed >= 10 && (
                <p className="drop-hint">
                  Reading photos on-device can take 1–2 minutes on laptops without a graphics card. ⚡ Fast mode
                  reads them in seconds.
                </p>
              )}
            </>
          ) : (
            <>
              <p className="drop-title">Drop a PDF or a photo of your notes here</p>
              <div className="drop-buttons">
                <button type="button" className="secondary" onClick={() => fileInput.current?.click()}>
                  📄 Upload PDF or image
                </button>
                <button type="button" className="secondary touch-only" onClick={() => cameraInput.current?.click()}>
                  📷 Take a photo
                </button>
              </div>
              <p className="drop-hint">Slides, textbook pages, handwritten notes, whiteboards… or paste a screenshot (Ctrl+V).</p>
            </>
          )}
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPTED_FILES}
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void handleFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <input
            ref={cameraInput}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => {
              if (e.target.files) void handleFiles(e.target.files)
              e.target.value = ''
            }}
          />
        </div>

        {files.length > 0 && (
          <ul className="file-chips">
            {files.map((f, i) => (
              <li key={i}>
                <strong>{f.name}</strong> · {f.detail}
                {f.note && <span className="file-note"> · {f.note}</span>}
              </li>
            ))}
          </ul>
        )}
        {fileError && <p className="error">{fileError}</p>}

        <label htmlFor="notes" className="sr-only">
          Your notes
        </label>
        <textarea
          id="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="…or type / paste your notes here. You can edit anything the AI read from your files."
          rows={7}
        />
        <div className="notes-meta">
          <span className={enough ? 'ok' : ''}>
            {chars === 0
              ? 'No notes yet'
              : enough
                ? `✓ ${chars.toLocaleString()} characters`
                : `${chars} characters · add a few more sentences`}
            {enough && mode === 'private' && chars > 4000 && ' · long notes: Private mode picks from across them'}
          </span>
          {chars > 0 && (
            <button type="button" className="link small" onClick={clearAll} disabled={busy}>
              Clear
            </button>
          )}
        </div>
      </div>

      {/* ---------- Step 2 ---------- */}
      <div className="step">
        <div className="step-head">
          <span className="step-num">2</span>
          <h2>Pick your AI</h2>
        </div>
        <div className="mode" role="radiogroup" aria-label="AI mode">
          <ModeOption
            active={mode === 'private'}
            onSelect={() => setMode('private')}
            title="🔒 Private"
            detail="AI runs on this laptop. Nothing is uploaded. Slower."
          />
          <ModeOption
            active={mode === 'fast'}
            onSelect={() => setMode('fast')}
            title="⚡ Fast"
            detail="Google's cloud AI. Ready in seconds."
          />
        </div>
        <p className="drop-hint">If this device can't run AI, Private mode switches to the cloud automatically.</p>
      </div>

      {/* ---------- Step 3 ---------- */}
      <div className="step">
        <div className="step-head">
          <span className="step-num">3</span>
          <h2>Play</h2>
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
            disabled={busy || props.disabled || !enough}
            onClick={() => props.onSubmit({ notes, rounds, mode })}
          >
            {props.busy ? props.busyLabel : props.submitLabel}
          </button>
        </div>
        {props.footer}
      </div>
    </section>
  )
}

export function SourceChip({ source }: { source: string | null | undefined }) {
  if (!source) return null
  const onDevice = source === 'on_device'
  return <span className={`chip ${onDevice ? 'device' : 'cloud'}`}>{onDevice ? '🔒 on device' : '☁️ cloud'}</span>
}
