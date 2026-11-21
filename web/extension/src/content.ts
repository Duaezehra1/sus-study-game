// Runs only on the Sus website. When the side panel hands notes over ("Play with friends"),
// it passes them to the page with postMessage. Notes never go in the URL.
// Self-contained on purpose: content scripts can't import modules.

type HandoffData = { notes: string; title: string; images?: string[]; fast?: boolean } | null
let cached: HandoffData | undefined // undefined = not fetched yet

function withHandoff(cb: (h: HandoffData) => void) {
  if (cached !== undefined) return cb(cached)
  chrome.runtime.sendMessage({ type: 'sus:getHandoff' }, (res: HandoffData) => {
    if (chrome.runtime.lastError) return
    // The background hands notes out only once, so keep them for repeat requests from the page.
    cached = res?.notes || res?.images?.length ? res : null
    cb(cached)
  })
}

function post() {
  if (!location.hash.includes('handoff')) return
  withHandoff((h) => {
    if (h) window.postMessage({ type: 'sus:handoff', notes: h.notes, title: h.title, images: h.images, fast: h.fast }, location.origin)
  })
}

// The page asks once its form is mounted, so the message is never missed; it ignores duplicates.
window.addEventListener('message', (e) => {
  if (e.source === window && e.origin === location.origin && e.data?.type === 'sus:requestHandoff') post()
})
window.addEventListener('hashchange', post)
post()
