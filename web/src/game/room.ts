import { signInAnonymously } from 'firebase/auth'
import {
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  increment,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore'
import type { InferenceSource } from 'firebase/ai'
import { auth, db } from '../firebase'
import type { SpeedMode, SusRound } from '../ai/susGenerator'

// ---------- Types ----------

export type RoomStatus = 'lobby' | 'explain' | 'vote' | 'reveal' | 'over'

export interface Reveal {
  round: number
  susUid: string
  susName: string
  topic: string
  realCard: string
  susCard: string
  lie: string
  truth: string
  explanation: string
  caught: boolean
  /** uid -> number of votes received */
  tally: Record<string, number>
}

export interface Room {
  hostUid: string
  status: RoomStatus
  mode: SpeedMode
  roundIndex: number
  roundsReady: number
  roundsTotal: number
  aiSource: InferenceSource | null
  topic: string | null
  reveal: Reveal | null
  /** Per finished round: topic and whether the group caught the lie (for "weak spots"). */
  history: { topic: string; lie: string; truth: string; caught: boolean }[]
}

export interface Player {
  uid: string
  name: string
  score: number
}

export interface Hand {
  round: number
  card: string
}

export const MIN_PLAYERS = 3

// ---------- Auth ----------

function requireFirebase() {
  if (!auth || !db) throw new Error('Firebase is not configured yet.')
  return { auth, db }
}

let signInPromise: Promise<string> | null = null

/**
 * Signs in anonymously (once per browser tab) and resolves with the uid.
 * Shared promise: concurrent callers (e.g. React StrictMode running effects twice)
 * must never create two different anonymous users.
 */
export function ensureSignedIn(): Promise<string> {
  const { auth } = requireFirebase()
  if (!signInPromise) {
    signInPromise = (async () => {
      await auth.authStateReady()
      if (auth.currentUser) return auth.currentUser.uid
      return (await signInAnonymously(auth)).user.uid
    })().catch((e) => {
      signInPromise = null
      throw e
    })
  }
  return signInPromise
}

// ---------- Room codes ----------

// No I, L, O or 0/1 so codes are easy to read out loud.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'

function randomCode(length = 4): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
}

export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4)
}

export function joinUrl(code: string): string {
  return `${location.origin}${location.pathname}#/join/${code}`
}

// ---------- Host actions ----------

export async function createRoom(mode: SpeedMode, roundsTotal: number): Promise<string> {
  const { db } = requireFirebase()
  const uid = await ensureSignedIn()
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomCode()
    const ref = doc(db, 'rooms', code)
    if ((await getDoc(ref)).exists()) continue
    const room: Room = {
      hostUid: uid,
      status: 'lobby',
      mode,
      roundIndex: -1,
      roundsReady: 0,
      roundsTotal,
      aiSource: null,
      topic: null,
      reveal: null,
      history: [],
    }
    await setDoc(ref, { ...room, createdAt: serverTimestamp() })
    return code
  }
  throw new Error('Could not find a free room code. Try again.')
}

/** Stores the deck where only the host can read it, and publishes progress. */
export async function saveDeck(
  code: string,
  rounds: SusRound[],
  aiSource: InferenceSource | null,
  roundsTotal?: number,
): Promise<void> {
  const { db } = requireFirebase()
  const batch = writeBatch(db)
  batch.set(doc(db, 'rooms', code, 'secret', 'deck'), { rounds })
  batch.update(doc(db, 'rooms', code), {
    roundsReady: rounds.length,
    aiSource,
    ...(roundsTotal !== undefined ? { roundsTotal } : {}),
  })
  await batch.commit()
}

export async function loadDeck(code: string): Promise<SusRound[]> {
  const { db } = requireFirebase()
  const snap = await getDoc(doc(db, 'rooms', code, 'secret', 'deck'))
  return (snap.data()?.rounds as SusRound[] | undefined) ?? []
}

export async function loadSusUid(code: string): Promise<string | null> {
  const { db } = requireFirebase()
  const snap = await getDoc(doc(db, 'rooms', code, 'secret', 'state'))
  return (snap.data()?.susUid as string | undefined) ?? null
}

/** Deals a round: one random player gets the sus card, everyone else the real one. */
export async function startRound(code: string, roundIndex: number, round: SusRound, players: Player[]) {
  const { db } = requireFirebase()
  const pick = crypto.getRandomValues(new Uint32Array(1))[0] % players.length
  const susUid = players[pick].uid
  const batch = writeBatch(db)
  for (const p of players) {
    batch.set(doc(db, 'rooms', code, 'hands', p.uid), {
      round: roundIndex,
      card: p.uid === susUid ? round.susCard : round.realCard,
    } satisfies Hand)
    batch.delete(doc(db, 'rooms', code, 'votes', p.uid))
  }
  batch.set(doc(db, 'rooms', code, 'secret', 'state'), { susUid, round: roundIndex })
  batch.update(doc(db, 'rooms', code), {
    status: 'explain',
    roundIndex,
    topic: round.topic,
    reveal: null,
  })
  await batch.commit()
}

export async function startVoting(code: string) {
  const { db } = requireFirebase()
  await updateDoc(doc(db, 'rooms', code), { status: 'vote' })
}

/**
 * Scores the round. Caught = the sus player got strictly more votes than anyone else.
 * Everyone who voted for the sus player gets +1. If nobody caught them, the sus player gets +2.
 */
export async function revealRound(
  code: string,
  room: Room,
  round: SusRound,
  players: Player[],
  votes: Record<string, string>,
) {
  const { db } = requireFirebase()
  const susUid = (await loadSusUid(code)) ?? ''
  const tally: Record<string, number> = {}
  for (const target of Object.values(votes)) tally[target] = (tally[target] ?? 0) + 1
  const susVotes = tally[susUid] ?? 0
  const caught = susVotes > 0 && Object.entries(tally).every(([uid, n]) => uid === susUid || n < susVotes)

  const batch = writeBatch(db)
  for (const [voter, target] of Object.entries(votes)) {
    if (target === susUid && voter !== susUid) {
      batch.update(doc(db, 'rooms', code, 'players', voter), { score: increment(1) })
    }
  }
  if (!caught && susUid) {
    batch.update(doc(db, 'rooms', code, 'players', susUid), { score: increment(2) })
  }
  const reveal: Reveal = {
    round: room.roundIndex,
    susUid,
    susName: players.find((p) => p.uid === susUid)?.name ?? 'Someone',
    topic: round.topic,
    realCard: round.realCard,
    susCard: round.susCard,
    lie: round.lie,
    truth: round.truth,
    explanation: round.explanation,
    caught,
    tally,
  }
  batch.update(doc(db, 'rooms', code), {
    status: 'reveal',
    reveal,
    history: [...room.history, { topic: round.topic, lie: round.lie, truth: round.truth, caught }],
  })
  await batch.commit()
}

export async function endGame(code: string) {
  const { db } = requireFirebase()
  await updateDoc(doc(db, 'rooms', code), { status: 'over', topic: deleteField() })
}

// ---------- Player actions ----------

export async function joinRoom(code: string, name: string): Promise<void> {
  const { db } = requireFirebase()
  const uid = await ensureSignedIn()
  const roomSnap = await getDoc(doc(db, 'rooms', code))
  if (!roomSnap.exists()) throw new Error(`No room called ${code}. Check the code.`)
  const playerRef = doc(db, 'rooms', code, 'players', uid)
  const existing = await getDoc(playerRef)
  if (existing.exists()) {
    if (existing.data().name !== name) await updateDoc(playerRef, { name })
    return
  }
  if ((roomSnap.data() as Room).status !== 'lobby') throw new Error('This game already started. Ask the host for a new room.')
  await setDoc(playerRef, { name, score: 0, joinedAt: serverTimestamp() })
}

export async function isInRoom(code: string): Promise<boolean> {
  const { db } = requireFirebase()
  const uid = await ensureSignedIn()
  return (await getDoc(doc(db, 'rooms', code, 'players', uid))).exists()
}

export async function castVote(code: string, round: number, target: string) {
  const { db } = requireFirebase()
  const uid = await ensureSignedIn()
  await setDoc(doc(db, 'rooms', code, 'votes', uid), { round, target })
}

// ---------- Live subscriptions ----------

export function watchRoom(code: string, cb: (room: Room | null) => void): Unsubscribe {
  const { db } = requireFirebase()
  return onSnapshot(doc(db, 'rooms', code), (snap) => cb(snap.exists() ? (snap.data() as Room) : null))
}

export function watchPlayers(code: string, cb: (players: Player[]) => void): Unsubscribe {
  const { db } = requireFirebase()
  return onSnapshot(collection(db, 'rooms', code, 'players'), (snap) => {
    const players = snap.docs.map((d) => ({
      uid: d.id,
      name: d.data().name as string,
      score: (d.data().score as number) ?? 0,
      joinedAt: d.data().joinedAt?.toMillis?.() ?? Date.now(),
    }))
    players.sort((a, b) => a.joinedAt - b.joinedAt)
    cb(players.map(({ uid, name, score }) => ({ uid, name, score })))
  })
}

export function watchHand(
  code: string,
  uid: string,
  cb: (hand: Hand | null) => void,
  onError?: (e: Error) => void,
): Unsubscribe {
  const { db } = requireFirebase()
  return onSnapshot(
    doc(db, 'rooms', code, 'hands', uid),
    (snap) => cb(snap.exists() ? (snap.data() as Hand) : null),
    (e) => onError?.(e),
  )
}

/** Host only: live map of voter uid -> target uid for the given round. */
export function watchVotes(code: string, round: number, cb: (votes: Record<string, string>) => void): Unsubscribe {
  const { db } = requireFirebase()
  return onSnapshot(collection(db, 'rooms', code, 'votes'), (snap) => {
    const votes: Record<string, string> = {}
    for (const d of snap.docs) {
      if (d.data().round === round) votes[d.id] = d.data().target as string
    }
    cb(votes)
  })
}

export function watchMyVote(code: string, uid: string, cb: (vote: { round: number; target: string } | null) => void) {
  const { db } = requireFirebase()
  return onSnapshot(doc(db, 'rooms', code, 'votes', uid), (snap) =>
    cb(snap.exists() ? (snap.data() as { round: number; target: string }) : null),
  )
}

/** Used by the host to make sure nothing stale is left before starting. */
export async function countPlayers(code: string): Promise<number> {
  const { db } = requireFirebase()
  return (await getDocs(collection(db, 'rooms', code, 'players'))).size
}
