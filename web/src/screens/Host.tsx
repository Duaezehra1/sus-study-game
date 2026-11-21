import { useEffect, useRef, useState, type ReactNode } from 'react'
import QRCode from 'qrcode'
import type { InferenceSource } from 'firebase/ai'
import { generateSusDeck, warmUpOnDeviceModel, type SusRound } from '../ai/susGenerator'
import { isFirebaseConfigured } from '../firebase'
import { Brand, Highlighted, NotesForm, SourceChip, type DeckRequest } from '../components/ui'
import { useExtensionHandoff } from '../game/handoff'
import {
  createRoom,
  endGame,
  joinUrl,
  loadDeck,
  MIN_PLAYERS,
  revealRound,
  saveDeck,
  startRound,
  startVoting,
  watchPlayers,
  watchRoom,
  watchVotes,
  type Player,
  type Room,
} from '../game/room'

const HOST_ROOM_KEY = 'sus.hostRoom'

function readHostRoom(): string | null {
  try {
    return sessionStorage.getItem(HOST_ROOM_KEY)
  } catch {
    return null
  }
}

function writeHostRoom(code: string | null) {
  try {
    if (code) sessionStorage.setItem(HOST_ROOM_KEY, code)
    else sessionStorage.removeItem(HOST_ROOM_KEY)
  } catch {
    /* storage unavailable: refresh just won't resume */
  }
}

/** The big screen: create a room, show the code, run the rounds. */
export function Host({ handoff = false }: { handoff?: boolean }) {
  const fromExtension = useExtensionHandoff(handoff)
  const [code, setCode] = useState<string | null>(readHostRoom)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [deck, setDeck] = useState<SusRound[]>([])
  const [generating, setGenerating] = useState(false)
  const [aiError, setAiError] = useState('')
  const [room, setRoom] = useState<Room | null>(null)
  const [players, setPlayers] = useState<Player[]>([])
  const [votes, setVotes] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const deckRef = useRef<SusRound[]>([])
  const saveChain = useRef<Promise<void>>(Promise.resolve())

  // Live room + players.
  useEffect(() => {
    if (!code) return
    const stopRoom = watchRoom(code, setRoom)
    const stopPlayers = watchPlayers(code, setPlayers)
    return () => {
      stopRoom()
      stopPlayers()
    }
  }, [code])

  // After a refresh, pick the deck back up from Firestore.
  useEffect(() => {
    if (!code || deckRef.current.length > 0) return
    loadDeck(code)
      .then((rounds) => {
        deckRef.current = rounds
        setDeck(rounds)
      })
      .catch(() => {})
  }, [code])

  // Votes for the current round (host-only by security rules).
  const roundIndex = room?.roundIndex ?? -1
  useEffect(() => {
    if (!code || roundIndex < 0) return
    return watchVotes(code, roundIndex, setVotes)
  }, [code, roundIndex])

  async function create({ notes, rounds, mode }: DeckRequest) {
    setError('')
    setAiError('')
    if (notes.trim().length < 80) {
      setError('Paste a bit more of your notes (at least a few sentences).')
      return
    }
    setCreating(true)
    try {
      // Must start inside the click for Chrome's user-activation rule.
      if (mode === 'private') warmUpOnDeviceModel().catch(() => {})
      const newCode = await createRoom(mode, rounds)
      writeHostRoom(newCode)
      deckRef.current = []
      setDeck([])
      setCode(newCode)
      void makeDeck(newCode, { notes, rounds, mode })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  /** Builds the deck in the background while friends join the lobby. */
  async function makeDeck(roomCode: string, { notes, rounds, mode }: DeckRequest) {
    setGenerating(true)
    let source: InferenceSource | null = null
    const persist = (total?: number) => {
      const snapshot = [...deckRef.current]
      saveChain.current = saveChain.current
        .then(() => saveDeck(roomCode, snapshot, source, total))
        .catch(() => {})
    }
    try {
      const all = await generateSusDeck(notes, rounds, mode, {
        onFacts: (count, s) => {
          source = s
          persist(count)
        },
        onRound: (round) => {
          deckRef.current = [...deckRef.current, round]
          setDeck(deckRef.current)
          persist()
        },
      })
      persist(all.length)
    } catch (e) {
      setAiError(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
    }
  }

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function newGame() {
    writeHostRoom(null)
    deckRef.current = []
    setDeck([])
    setRoom(null)
    setPlayers([])
    setCode(null)
  }

  // ---------- Setup ----------
  if (!code) {
    return (
      <main className="shell">
        <Brand />
        <p className="crumb">
          <a href="#/">← Home</a> · Host a game
        </p>
        <NotesForm
          incoming={fromExtension && { text: fromExtension.notes, label: fromExtension.title, images: fromExtension.images, fast: fromExtension.fast }}
          submitLabel="Create room"
          busyLabel="Creating room…"
          busy={creating}
          disabled={!isFirebaseConfigured}
          onSubmit={create}
          footer={error && <p className="error">{error}</p>}
        />
        <p className="hint center">The AI makes the cards while your friends join, so there's no waiting.</p>
      </main>
    )
  }

  if (!room) {
    return (
      <main className="shell">
        <Brand compact />
        <p className="hint">Opening room {code}…</p>
        <button type="button" className="link" onClick={newGame}>
          Start over
        </button>
      </main>
    )
  }

  // Once generation is over, the real number of rounds is what we managed to make.
  const totalRounds = generating ? room.roundsTotal : Math.max(deck.length, 0)
  const current = room.roundIndex >= 0 ? deck[room.roundIndex] : undefined
  const nextReady = deck.length > room.roundIndex + 1
  const isLastRound = !generating && room.roundIndex + 1 >= deck.length
  const voters = Object.keys(votes).filter((uid) => players.some((p) => p.uid === uid))

  const aiStatus = (
    <p className={`badge ${room.aiSource === 'on_device' ? 'device' : room.aiSource ? 'cloud' : 'neutral'}`}>
      {room.aiSource === 'on_device'
        ? '🔒 Cards made on this laptop'
        : room.aiSource
          ? '☁️ Cards made in the cloud'
          : '🧠 Reading your notes…'}
      <span>
        {' · '}
        {deck.length} of {room.roundsTotal} ready{generating ? '' : ' ✓'}
      </span>
    </p>
  )

  return (
    <main className="shell wide">
      <header className="host-bar">
        <Brand compact />
        <div className="room-pill">
          Room <strong>{code}</strong>
        </div>
      </header>

      {error && <p className="error">{error}</p>}
      {aiError && <p className="error">AI problem: {aiError}</p>}

      {room.status === 'lobby' && (
        <Lobby
          code={code}
          players={players}
          aiStatus={aiStatus}
          canStart={players.length >= MIN_PLAYERS && deck.length > 0 && !busy}
          readyRounds={deck.length}
          onStart={() => run(() => startRound(code, 0, deck[0], players))}
        />
      )}

      {room.status === 'explain' && current && (
        <section className="stage">
          <p className="round-label">
            Round {room.roundIndex + 1} of {totalRounds} <SourceChip source={current.source} />
          </p>
          <h2 className="stage-title">{current.topic}</h2>
          <ol className="steps">
            <li>Look at the card on your phone. Keep it secret!</li>
            <li>Go around the table: explain it in your own words, one sentence each.</li>
            <li>One of you has a card with a lie, and doesn't know it. Listen closely 👂</li>
          </ol>
          <button type="button" className="primary big" disabled={busy} onClick={() => run(() => startVoting(code))}>
            Everyone explained → Vote
          </button>
        </section>
      )}

      {room.status === 'vote' && current && (
        <section className="stage">
          <p className="round-label">
            Round {room.roundIndex + 1} of {totalRounds}
          </p>
          <h2 className="stage-title">Who's sus? Vote on your phones 🗳️</h2>
          <ul className="player-grid">
            {players.map((p) => (
              <li key={p.uid} className={voters.includes(p.uid) ? 'done' : ''}>
                {voters.includes(p.uid) ? '✅' : '⏳'} {p.name}
              </li>
            ))}
          </ul>
          <p className="hint center">
            {voters.length} of {players.length} voted
          </p>
          <button
            type="button"
            className="primary big"
            disabled={busy || voters.length === 0}
            onClick={() => run(() => revealRound(code, room, current, players, votes))}
          >
            {voters.length >= players.length ? 'Reveal the liar 😈' : 'Reveal now'}
          </button>
        </section>
      )}

      {room.status === 'reveal' && room.reveal && (
        <section className="stage">
          <p className="round-label">
            Round {room.roundIndex + 1} of {totalRounds}
          </p>
          <h2 className="stage-title">
            {room.reveal.caught ? `Caught! ${room.reveal.susName} had the lie 🎯` : `${room.reveal.susName} fooled you all 😈`}
          </h2>
          <div className="cards">
            <div className="card is-real">
              <span className="tag">REAL</span>
              {room.reveal.realCard}
            </div>
            <div className="card is-sus">
              <span className="tag">SUS</span>
              <Highlighted text={room.reveal.susCard} phrase={room.reveal.lie} />
            </div>
          </div>
          <div className="reveal">
            <p>
              <strong>The lie:</strong> “{room.reveal.lie}” instead of “{room.reveal.truth}”
            </p>
            {room.reveal.explanation && <p>{room.reveal.explanation}</p>}
          </div>
          <Scoreboard players={players} tally={room.reveal.tally} susUid={room.reveal.susUid} />
          {isLastRound ? (
            <button type="button" className="primary big" disabled={busy} onClick={() => run(() => endGame(code))}>
              Final results 🏆
            </button>
          ) : (
            <button
              type="button"
              className="primary big"
              disabled={busy || !nextReady}
              onClick={() => run(() => startRound(code, room.roundIndex + 1, deck[room.roundIndex + 1], players))}
            >
              {nextReady ? 'Next round →' : 'AI is still writing the next card…'}
            </button>
          )}
        </section>
      )}

      {room.status === 'over' && (
        <section className="stage">
          <h2 className="stage-title">🏆 Final scores</h2>
          <Scoreboard players={players} />
          <WeakSpots history={room.history} />
          <button type="button" className="primary big" onClick={newGame}>
            New game
          </button>
        </section>
      )}

      {room.status !== 'lobby' && room.status !== 'over' && <div className="host-foot">{aiStatus}</div>}
    </main>
  )
}

function Lobby(props: {
  code: string
  players: Player[]
  aiStatus: ReactNode
  canStart: boolean
  readyRounds: number
  onStart: () => void
}) {
  const url = joinUrl(props.code)
  const [qr, setQr] = useState('')
  useEffect(() => {
    QRCode.toDataURL(url, { margin: 1, width: 240 })
      .then(setQr)
      .catch(() => setQr(''))
  }, [url])
  const onLocalhost = ['localhost', '127.0.0.1'].includes(location.hostname)
  const needed = Math.max(0, MIN_PLAYERS - props.players.length)

  return (
    <section className="lobby">
      <div className="join-card">
        <p className="eyebrow">Scan to join, or enter the code</p>
        <p className="big-code">{props.code}</p>
        {qr && <img className="qr" src={qr} alt={`QR code to join room ${props.code}`} width={240} height={240} />}
        <p className="join-url">{url}</p>
        {onLocalhost && (
          <p className="hint">
            Phones can't open “localhost”. Use the deployed site, or your laptop's Wi-Fi address, to play on phones.
          </p>
        )}
      </div>

      <div className="lobby-side">
        <h2>
          Players <span className="count">{props.players.length}</span>
        </h2>
        {props.players.length === 0 ? (
          <p className="hint">Waiting for friends to join…</p>
        ) : (
          <ul className="player-grid">
            {props.players.map((p) => (
              <li key={p.uid} className="pop">
                {p.name}
              </li>
            ))}
          </ul>
        )}
        {props.aiStatus}
        <button type="button" className="primary big" disabled={!props.canStart} onClick={props.onStart}>
          Start game
        </button>
        <p className="hint">
          {needed > 0
            ? `Need ${needed} more player${needed === 1 ? '' : 's'} (${MIN_PLAYERS}+ makes it fun).`
            : props.readyRounds === 0
              ? 'Waiting for the first card…'
              : 'Ready when you are!'}
        </p>
      </div>
    </section>
  )
}

function Scoreboard({ players, tally, susUid }: { players: Player[]; tally?: Record<string, number>; susUid?: string }) {
  const ranked = [...players].sort((a, b) => b.score - a.score)
  return (
    <ol className="scoreboard">
      {ranked.map((p, i) => (
        <li key={p.uid} className={p.uid === susUid ? 'sus' : ''}>
          <span className="rank">{i + 1}</span>
          <span className="name">
            {p.name}
            {p.uid === susUid && ' 😈'}
          </span>
          {tally && (
            <span className="votes">
              {tally[p.uid] ?? 0} vote{(tally[p.uid] ?? 0) === 1 ? '' : 's'}
            </span>
          )}
          <span className="score">{p.score}</span>
        </li>
      ))}
    </ol>
  )
}

function WeakSpots({ history }: { history: Room['history'] }) {
  const missed = history.filter((h) => !h.caught)
  return (
    <div className="weak-spots">
      <h3>📚 Revise these before your exam</h3>
      {missed.length === 0 ? (
        <p>Your group caught every lie. You know this stuff! 🎉</p>
      ) : (
        <ul>
          {missed.map((h, i) => (
            <li key={i}>
              <strong>{h.topic}:</strong> it's “{h.truth}”, not “{h.lie}”
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
