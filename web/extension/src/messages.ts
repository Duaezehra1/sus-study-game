/** Shared keys and message shapes between the side panel, background and content script. */

/** chrome.storage.session key: a quiz request from the right-click menu, read by the side panel. */
export const PENDING_KEY = 'sus.pending'
/** chrome.storage.session key: notes waiting to be handed to the Sus website. */
export const HANDOFF_KEY = 'sus.handoff'

export interface PendingQuiz {
  tabId: number
  /** Selected text from the right-click, if any; otherwise the side panel reads the page. */
  selection?: string
  at: number
}

export interface Handoff {
  notes: string
  title: string
  /** Scanned PDF pages (JPEG base64) for the website to read with fast cloud AI. */
  images?: string[]
  /** The student asked for speed: the website should start in ⚡ Fast (cloud) mode. */
  fast?: boolean
  at: number
}

export const SITE_URL = 'https://sus-study-game.web.app'
