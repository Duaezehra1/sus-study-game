import { useEffect, useState } from 'react'

export interface ExtensionHandoff {
  notes: string
  title: string
  /** Scanned PDF pages (JPEG base64) to read with cloud AI, chosen by the user in the extension. */
  images: string[]
  /** The student chose speed in the extension, so start in ⚡ Fast mode. */
  fast: boolean
}

const MAX_IMAGES = 6
const MAX_IMAGE_CHARS = 3_000_000

/**
 * Receives notes from the Sus Chrome extension ("Play with friends" / "Read it fast").
 * The extension's content script answers our request with window.postMessage, so the
 * notes never travel in the URL.
 */
export function useExtensionHandoff(enabled: boolean): ExtensionHandoff | null {
  const [handoff, setHandoff] = useState<ExtensionHandoff | null>(null)

  useEffect(() => {
    if (!enabled) return
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window || e.origin !== location.origin) return
      if (e.data?.type !== 'sus:handoff') return
      const notes = typeof e.data.notes === 'string' ? e.data.notes.slice(0, 100_000) : ''
      const images = Array.isArray(e.data.images)
        ? (e.data.images as unknown[])
            .filter((i): i is string => typeof i === 'string' && i.length < MAX_IMAGE_CHARS)
            .slice(0, MAX_IMAGES)
        : []
      if (!notes && images.length === 0) return
      setHandoff((prev) => prev ?? { notes, images, fast: e.data.fast === true, title: String(e.data.title ?? 'Chrome extension').slice(0, 120) })
      // Drop "/handoff" so a refresh doesn't ask again.
      history.replaceState(null, '', location.hash.replace('/handoff', ''))
    }
    window.addEventListener('message', onMessage)
    window.postMessage({ type: 'sus:requestHandoff' }, location.origin)
    return () => window.removeEventListener('message', onMessage)
  }, [enabled])

  return handoff
}
