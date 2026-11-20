import { useEffect, useState, type FormEvent } from 'react'
import { Brand, Highlighted } from '../components/ui'
import {
  castVote,
  ensureSignedIn,
  isInRoom,
  joinRoom,
  watchHand,
  watchMyVote,
  watchPlayers,
  watchRoom,
  type Hand,
  type Player,
  type Room,
} from '../game/room'

const NAME_KEY = 'sus.name'

function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? ''
  } catch {
    return ''
  }
}

/** The phone screen for a player in room `code`. */
export function Play({ code }: { code: string }) {
  const [uid, setUid] = useState<string | null>(null)
  const [joined, setJoined] = useState<boolean | null>(null)
  const [name, setName] = useState(savedName)
  const [joining, setJoining] = useState(false)
  const [error, setError] = useState('')
  const [room, setRoom] = useState<Room | null | undefined>(undefined)
  const [players, setPlayers] = useState<Player[]>([])
  const [hand, setHand] = useState<Hand | null>(null)
  const [myVote, setMyVote] = useState<{ round: number; target: string } | null>(null)
  const [voting, setVoting] = useState(false)

  useEffect(() => {
    let alive = true
    ensureSignedIn()
      .then(async (id) => {
        const inRoom = await isInRoom(code)
        if (!alive) return
        setUid(id)
        setJoined(inRoom)
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [code])

  useEffect(() => {
    if (!uid) return
    const stops = [watchRoom(code, setRoom), watchPlayers(code, setPlayers)]
    return () => stops.forEach((stop) => stop())
  }, [code, uid])

  useEffect(() => {
    if (!uid || !joined) return
    const stops = [
      watchHand(code, uid, setHand, () => setError("Couldn't load your card. Refresh the page.")),
      watchMyVote(code, uid, setMyVote),
    ]
    return () => stops.forEach((stop) => stop())
  }, [code, uid, joined])

  async function join(e: FormEvent) {
    e.preventDefault()
    const clean = name.trim().slice(0, 20)
    if (!clean) return
    setJoining(true)
    setError('')
    try {
      await joinRoom(code, clean)
      try {
        localStorage.setItem(NAME_KEY, clean)
      } catch {
        /* fine */
      }
      setJoined(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setJoining(false)
    }
  }

  async function vote(target: string) {
    if (!room) return
    setVoting(true)
    setError('')
    try {
      await castVote(code, room.roundIndex, target)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setVoting(false)
    }
  }

  const header = (
    <header className="phone-bar">
      <Brand compact />
      <span className="room-pill">
        Room <strong>{code}</strong>
      </span>
    </header>
  )

  if (room === null) {
    return (
      <main className="shell phone">
        {header}
        <p className="error">No room called {code}. Check the code with the host.</p>
        <a className="link" href="#/">
          ← Home
        </a>
      </main>
    )
  }

  if (joined === null || room === undefined) {
    return (
      <main className="shell phone">
        {header}
        <p className="hint">Connecting…</p>
        {error && <p className="error">{error}</p>}
      </main>
    )
  }

  if (!joined) {
    return (
      <main className="shell phone">
        {header}
        {room.status !== 'lobby' ? (
          <p className="error">This game already started. Ask the host to make a new room.</p>
        ) : (
          <form className="panel join-form" onSubmit={join}>
            <label htmlFor="name">Your name</label>
            <input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={20}
              placeholder="e.g. Dua"
              autoComplete="nickname"
              autoFocus
            />
            <button type="submit" className="primary big" disabled={joining || !name.trim()}>
              {joining ? 'Joining…' : 'Join game'}
            </button>
            {error && <p className="error">{error}</p>}
          </form>
        )}
      </main>
    )
  }

  const me = players.find((p) => p.uid === uid)
  const myCard = hand && hand.round === room.roundIndex ? hand.card : null
  const votedThisRound = myVote && myVote.round === room.roundIndex ? myVote.target : null

  return (
    <main className="shell phone">
      {header}
      {error && <p className="error">{error}</p>}

      {room.status === 'lobby' && (
        <section className="phone-stage">
          <p className="big-emoji">🎉</p>
          <h2>You're in, {me?.name ?? name}!</h2>
          <p className="hint">Waiting for the host to start. Look at the big screen.</p>
          <ul className="player-grid">
            {players.map((p) => (
              <li key={p.uid} className={p.uid === uid ? 'me' : ''}>
                {p.name}
              </li>
            ))}
          </ul>
        </section>
      )}

      {room.status === 'explain' && (
        <section className="phone-stage">
          <p className="round-label">
            Round {room.roundIndex + 1} · {room.topic}
          </p>
          <div className="secret-card">{myCard ?? 'Dealing your card…'}</div>
          <p className="instruction">
            Explain this <strong>in your own words</strong>, one sentence. Don't read it out!
          </p>
          <p className="hint">Someone's card has a lie… it might be yours 👀</p>
        </section>
      )}

      {room.status === 'vote' && (
        <section className="phone-stage">
          <p className="round-label">Round {room.roundIndex + 1} · Vote</p>
          {votedThisRound ? (
            <>
              <p className="big-emoji">🗳️</p>
              <h2>Vote locked: {players.find((p) => p.uid === votedThisRound)?.name ?? '…'}</h2>
              <p className="hint">Waiting for everyone else.</p>
            </>
          ) : (
            <>
              <h2>Who had the lie?</h2>
              <div className="vote-list">
                {players
                  .filter((p) => p.uid !== uid)
                  .map((p) => (
                    <button key={p.uid} type="button" className="vote-btn" disabled={voting} onClick={() => vote(p.uid)}>
                      {p.name}
                    </button>
                  ))}
              </div>
            </>
          )}
          {myCard && (
            <details className="my-card">
              <summary>See my card again</summary>
              <p>{myCard}</p>
            </details>
          )}
        </section>
      )}

      {room.status === 'reveal' && room.reveal && (
        <section className="phone-stage">
          {room.reveal.susUid === uid ? (
            <>
              <p className="big-emoji">😈</p>
              <h2>You had the lie!</h2>
              <p className="hint">{room.reveal.caught ? 'They caught you this time.' : 'You fooled everyone: +2 points!'}</p>
            </>
          ) : votedThisRound === room.reveal.susUid ? (
            <>
              <p className="big-emoji">🎯</p>
              <h2>You caught {room.reveal.susName}! +1</h2>
            </>
          ) : (
            <>
              <p className="big-emoji">🙈</p>
              <h2>{room.reveal.susName} had the lie</h2>
              <p className="hint">You missed it this time.</p>
            </>
          )}
          <div className="reveal">
            <p>
              <Highlighted text={room.reveal.susCard} phrase={room.reveal.lie} />
            </p>
            <p>
              <strong>Truth:</strong> “{room.reveal.truth}”, not “{room.reveal.lie}”.
            </p>
            {room.reveal.explanation && <p>{room.reveal.explanation}</p>}
          </div>
          <p className="my-score">Your score: {me?.score ?? 0}</p>
        </section>
      )}

      {room.status === 'over' && (
        <section className="phone-stage">
          <p className="big-emoji">🏆</p>
          <h2>Game over!</h2>
          <FinalRank players={players} uid={uid} />
          <a className="primary big" href="#/">
            Back to home
          </a>
        </section>
      )}
    </main>
  )
}

function FinalRank({ players, uid }: { players: Player[]; uid: string | null }) {
  const ranked = [...players].sort((a, b) => b.score - a.score)
  const place = ranked.findIndex((p) => p.uid === uid) + 1
  return (
    <>
      {place > 0 && (
        <p className="instruction">
          You finished <strong>#{place}</strong> of {ranked.length} with {ranked[place - 1].score} point
          {ranked[place - 1].score === 1 ? '' : 's'}.
        </p>
      )}
      <ol className="scoreboard">
        {ranked.map((p, i) => (
          <li key={p.uid} className={p.uid === uid ? 'me' : ''}>
            <span className="rank">{i + 1}</span>
            <span className="name">{p.name}</span>
            <span className="score">{p.score}</span>
          </li>
        ))}
      </ol>
    </>
  )
}
