import { HANDOFF_KEY, PENDING_KEY, type Handoff, type PendingQuiz } from './messages'

const MENU_ID = 'sus-quiz'

chrome.runtime.onInstalled.addListener(() => {
  // Clicking the toolbar icon opens the side panel.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Quiz me on this with Sus',
    contexts: ['selection', 'page'],
  })
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return
  // Must open the panel synchronously inside the click (user gesture).
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {})
  const pending: PendingQuiz = { tabId: tab.id, selection: info.selectionText?.trim() || undefined, at: Date.now() }
  void chrome.storage.session.set({ [PENDING_KEY]: pending })
})

// The content script on the Sus website asks for notes handed off from the side panel.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'sus:getHandoff' || !sender.tab) return
  chrome.storage.session.get(HANDOFF_KEY).then((data) => {
    const handoff = data[HANDOFF_KEY] as Handoff | undefined
    // One-time and short-lived: notes are removed as soon as the website takes them.
    if (handoff && Date.now() - handoff.at < 5 * 60_000) {
      void chrome.storage.session.remove(HANDOFF_KEY)
      sendResponse({ notes: handoff.notes, title: handoff.title, images: handoff.images, fast: handoff.fast })
    } else {
      sendResponse(null)
    }
  })
  return true // async response
})
