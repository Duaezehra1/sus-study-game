import { useEffect, useState } from 'react'
import { Home } from './screens/Home'
import { Host } from './screens/Host'
import { Play } from './screens/Play'
import { Practice } from './screens/Practice'
import { normalizeCode } from './game/room'
import './App.css'

type Route =
  | { name: 'home' }
  | { name: 'host'; handoff: boolean }
  | { name: 'practice'; handoff: boolean }
  | { name: 'join'; code: string }

function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/')
  // "/handoff": notes are coming from the Sus Chrome extension.
  if (parts[0] === 'host') return { name: 'host', handoff: parts[1] === 'handoff' }
  if (parts[0] === 'practice') return { name: 'practice', handoff: parts[1] === 'handoff' }
  if (parts[0] === 'join' && parts[1]) {
    const code = normalizeCode(parts[1])
    if (code.length === 4) return { name: 'join', code }
  }
  return { name: 'home' }
}

function App() {
  const [route, setRoute] = useState(() => parseRoute(location.hash))

  useEffect(() => {
    const onHash = () => {
      setRoute(parseRoute(location.hash))
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  switch (route.name) {
    case 'host':
      return <Host handoff={route.handoff} />
    case 'practice':
      return <Practice handoff={route.handoff} />
    case 'join':
      return <Play key={route.code} code={route.code} />
    default:
      return <Home />
  }
}

export default App
