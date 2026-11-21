import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
  Schema,
  type GenerativeModel,
  type InferenceSource,
  type ObjectSchema,
} from 'firebase/ai'
import { getApp, getApps } from 'firebase/app'

/** One round of Sus: the true fact, its twin with exactly one lie, and why. */
export interface SusRound {
  topic: string
  realCard: string
  susCard: string
  /** The words that were swapped in, e.g. "photosynthesis". */
  lie: string
  /** The words they replaced, e.g. "cellular respiration". */
  truth: string
  explanation: string
  source: InferenceSource
}

/**
 * private: Gemini Nano on this device first; cloud only if Nano is unavailable.
 * fast:    cloud first (seconds instead of minutes on laptops without a GPU).
 * device:  Gemini Nano only, never the cloud (the Chrome extension, which has no App Check).
 */
export type SpeedMode = 'private' | 'fast' | 'device'

const INFERENCE_MODE: Record<SpeedMode, InferenceMode> = {
  private: InferenceMode.PREFER_ON_DEVICE,
  fast: InferenceMode.PREFER_IN_CLOUD,
  device: InferenceMode.ONLY_ON_DEVICE,
}

export interface GenerateCallbacks {
  /** Fired once the key facts have been pulled out of the notes. */
  onFacts?: (count: number, source: InferenceSource) => void
  /** Fired for every finished round, as soon as it is ready. */
  onRound?: (round: SusRound, index: number) => void
}

// Gemini Nano has a small context window (and is slow on CPU-only laptops), so on-device
// prompts get a short excerpt; the cloud model can take a whole chapter.
const MAX_NOTES_CHARS: Record<SpeedMode, number> = { private: 4000, fast: 30000, device: 4000 }
const CLOUD_MODEL = 'gemini-3.5-flash-lite'

/**
 * Shortens long notes by keeping evenly spaced paragraphs, so the facts come from
 * the whole document (not just page 1).
 */
export function fitNotes(notes: string, maxChars: number): string {
  if (notes.length <= maxChars) return notes
  const paragraphs = notes
    .split(/\n\s*\n|\n(?=[A-Z0-9•\-*])/)
    .map((p) => p.trim())
    .filter((p) => p.length > 30)
  if (paragraphs.length < 2) return notes.slice(0, maxChars)
  const avg = notes.length / paragraphs.length
  const keep = Math.max(1, Math.floor(maxChars / avg))
  const step = paragraphs.length / keep
  const picked: string[] = []
  let used = 0
  for (let i = 0; i < keep; i++) {
    const p = paragraphs[Math.floor(i * step)]
    if (used + p.length > maxChars) break
    picked.push(p)
    used += p.length + 2
  }
  return picked.length ? picked.join('\n\n') : notes.slice(0, maxChars)
}

const factsSchema = Schema.object({
  properties: { facts: Schema.array({ items: Schema.string() }) },
})

const twistSchema = Schema.object({
  properties: {
    topic: Schema.string(),
    original: Schema.string(),
    replacement: Schema.string(),
    explanation: Schema.string(),
  },
})

const models = new Map<string, GenerativeModel>()

/** Hybrid model per (mode, task). With a schema it returns JSON; without, plain text. */
function getModel(mode: SpeedMode, schema: ObjectSchema | null, key: string): GenerativeModel {
  // Uses whichever default Firebase app the host (website or extension) initialized.
  if (getApps().length === 0) throw new Error('Firebase is not configured yet. Fill in web/.env.local.')
  const cacheKey = `${mode}:${key}`
  let model = models.get(cacheKey)
  if (!model) {
    const ai = getAI(getApp(), { backend: new GoogleAIBackend() })
    model = getGenerativeModel(ai, {
      mode: INFERENCE_MODE[mode],
      inCloudParams: {
        model: CLOUD_MODEL,
        generationConfig: schema
          ? { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.8 }
          : { temperature: 0.2 },
      },
      onDeviceParams: schema ? { promptOptions: { responseConstraint: schema } } : {},
    })
    models.set(cacheKey, model)
  }
  return model
}

/**
 * Turns a photo or scanned page of study material into plain text.
 * Private mode reads it with Gemini Nano on this device (JPEG/PNG), cloud otherwise.
 */
export async function transcribeImage(
  jpegBase64: string,
  mode: SpeedMode,
): Promise<{ text: string; source: InferenceSource }> {
  const model = getModel(mode, null, 'transcribe')
  const result = await model.generateContent([
    `This image is study material: handwritten or typed notes, lecture slides, a textbook page or a whiteboard.
Write out ALL of its study content as clean plain text, in reading order.
Keep headings and bullet points. Write formulas in plain text.
Skip page numbers, logos and decorations. If a word is unreadable, leave it out.
Do not add, explain or summarize anything that isn't in the image.`,
    { type: 'inlineData', inlineData: { data: jpegBase64, mimeType: 'image/jpeg' } },
  ])
  return { text: result.response.text().trim(), source: result.response.inferenceSource ?? 'in_cloud' }
}

/** Starts the on-device model for photo reading (call from a user gesture). */
export function warmUpImageModel(mode: SpeedMode): void {
  if (mode === 'fast') return
  getModel(mode, null, 'transcribe')
    .initializeDeviceModel()
    .catch(() => {})
}

/**
 * Must be called from a user gesture (e.g. a button click), per Chrome's
 * user-activation rule. Starts the Gemini Nano download if needed.
 */
export function warmUpOnDeviceModel(onProgress?: (fraction: number) => void): Promise<void> {
  return getModel('private', factsSchema, 'facts').initializeDeviceModel(onProgress)
}

async function ask<T>(model: GenerativeModel, prompt: string): Promise<{ data: T; source: InferenceSource }> {
  const result = await model.generateContent(prompt)
  return {
    data: JSON.parse(result.response.text()) as T,
    source: result.response.inferenceSource ?? 'in_cloud',
  }
}

// ---------- Step 1: pull the key facts out of the notes ----------

function factsPrompt(notes: string, count: number, mode: SpeedMode): string {
  return `List the ${count} most important, testable facts in these study notes.
Each fact: one short, complete sentence (max 25 words) using the notes' own terms.
Each fact must contain a specific term, number, place, cause or direction that a student must remember.
Different facts must cover different ideas, spread across the whole notes.

NOTES:
"""
${fitNotes(notes, MAX_NOTES_CHARS[mode])}
"""`
}

// ---------- Step 2: for one fact, choose a single believable lie ----------

function twistPrompt(fact: string): string {
  return `You write a trick card for a study game.
FACT: "${fact}"
Pick ONE key phrase (1-4 words) copied EXACTLY from the FACT, and a believable wrong replacement for it
(a related term, a nearby number, the opposite direction, or a commonly confused concept).
A student who half-studied should fall for it. Do not change anything else.
Return:
- topic: 2-4 word label for the fact
- original: the exact phrase from the FACT
- replacement: the wrong phrase
- explanation: one friendly sentence on why the original is correct`
}

interface Twist {
  topic: string
  original: string
  replacement: string
  explanation: string
}

/** Build the sus card in code so it always differs from the real card by exactly one phrase. */
export function applyTwist(fact: string, twist: Twist): string | null {
  const original = twist.original?.trim()
  const replacement = twist.replacement?.trim()
  if (!original || !replacement) return null
  if (original.toLowerCase() === replacement.toLowerCase()) return null
  const at = fact.toLowerCase().indexOf(original.toLowerCase())
  if (at < 0) return null
  return fact.slice(0, at) + replacement + fact.slice(at + original.length)
}

async function makeRound(fact: string, mode: SpeedMode): Promise<SusRound | null> {
  const model = getModel(mode, twistSchema, 'twist')
  // Small models sometimes quote a phrase that isn't in the fact; give it one retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, source } = await ask<Twist>(model, twistPrompt(fact))
    const susCard = applyTwist(fact, data)
    if (susCard) {
      return {
        topic: data.topic?.trim() || 'Key fact',
        realCard: fact,
        susCard,
        lie: data.replacement.trim(),
        truth: data.original.trim(),
        explanation: data.explanation?.trim() ?? '',
        source,
      }
    }
  }
  return null
}

/**
 * Generates a deck round by round. Rounds are delivered through `onRound` as
 * soon as each is ready, so the game can start before the whole deck is done.
 */
export async function generateSusDeck(
  notes: string,
  roundCount: number,
  mode: SpeedMode,
  callbacks: GenerateCallbacks = {},
): Promise<SusRound[]> {
  const trimmed = notes.trim()
  if (trimmed.length < 80) throw new Error('Paste a bit more of your notes (at least a few sentences).')

  // Ask for one spare fact in case a twist fails validation.
  const { data, source } = await ask<{ facts?: string[] }>(
    getModel(mode, factsSchema, 'facts'),
    factsPrompt(trimmed, roundCount + 1, mode),
  )
  const facts = [...new Set((data.facts ?? []).map((f) => f.trim()).filter((f) => f.length > 15))]
  if (facts.length === 0) throw new Error('The AI could not find clear facts. Try longer or clearer notes.')
  callbacks.onFacts?.(Math.min(facts.length, roundCount), source)

  const rounds: SusRound[] = []
  const emit = (round: SusRound | null) => {
    if (round && rounds.length < roundCount) {
      rounds.push(round)
      callbacks.onRound?.(round, rounds.length - 1)
    }
  }

  if (source === 'on_device') {
    // One on-device model: run sequentially so the first card appears as early as possible.
    for (const fact of facts) {
      if (rounds.length >= roundCount) break
      emit(await makeRound(fact, mode).catch(() => null))
    }
  } else {
    // Cloud handles parallel requests well: make all rounds at once.
    await Promise.all(facts.map((fact) => makeRound(fact, mode).catch(() => null).then(emit)))
  }

  if (rounds.length === 0) throw new Error('The AI could not build any rounds. Try different notes.')
  return rounds
}
