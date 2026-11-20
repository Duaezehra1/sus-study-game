import { useState } from 'react'
import { Brand } from '../components/ui'
import { normalizeCode } from '../game/room'

export function Home() {
  const [code, setCode] = useState('')

  return (
    <main className="shell">
      <Brand />

      <section className="hero-card">
        <h2>The study game where one card is lying.</h2>
        <ol className="how">
          <li>
            <strong>Paste your notes.</strong> AI turns them into cards, and secretly writes one believable lie for
            each.
          </li>
          <li>
            <strong>Everyone gets a card.</strong> One player gets the lie, and they don't know it.
          </li>
          <li>
            <strong>Explain, vote, reveal.</strong> Catch the liar, and learn the fact you'd have missed.
          </li>
        </ol>
      </section>

      <div className="home-actions">
        <a className="primary big" href="#/host">
          Host a game
          <span>On your laptop, with your notes</span>
        </a>

        <form
          className="join-box"
          onSubmit={(e) => {
            e.preventDefault()
            const c = normalizeCode(code)
            if (c.length === 4) location.hash = `#/join/${c}`
          }}
        >
          <label htmlFor="code">Join with a room code</label>
          <div className="join-row">
            <input
              id="code"
              value={code}
              onChange={(e) => setCode(normalizeCode(e.target.value))}
              placeholder="ABCD"
              autoCapitalize="characters"
              autoComplete="off"
              inputMode="text"
              maxLength={4}
            />
            <button type="submit" className="primary" disabled={code.length !== 4}>
              Join
            </button>
          </div>
        </form>

        <a className="link center" href="#/practice">
          Practice solo instead →
        </a>
      </div>
    </main>
  )
}
