// The PDF's zoom following the chat: shrinking to fit beside it when it opens and
// growing back when it closes. A setting, so it can be turned off for the PDF to keep
// one size that already leaves room for the chat.

const KEY = 'leqtern.zoomFollowsChat'

/** Whether the zoom follows the chat in this browser. On unless turned off. */
export function savedZoomFollowsChat(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'false'
  } catch {
    return true
  }
}

export function saveZoomFollowsChat(on: boolean) {
  try {
    localStorage.setItem(KEY, String(on))
  } catch {
    // Storage can be unavailable (private windows); the choice just isn't remembered.
  }
}

/** How much bigger than fitting beside the chat a PDF opens while the chat is closed. */
export const ROOM_FOR_CHAT = 1.15

/**
 * The zoom a PDF opens at with the chat closed: a little bigger than fits beside the chat,
 * but never wider than the viewer. In whole percents, like PDF.js's own zoom steps.
 */
export function openingScale(fitViewer: number, fitBesideChat: number) {
  // The small nudge keeps 1.15 from flooring to 1.14 through float error.
  return Math.floor(Math.min(fitViewer, fitBesideChat * ROOM_FOR_CHAT) * 100 + 1e-6) / 100
}

/** How far the viewer has gone from one width to another, from 0 to 1. */
export function progress(from: number, to: number, now: number) {
  if (from === to) return 1
  return Math.min(1, Math.max(0, (now - from) / (to - from)))
}
