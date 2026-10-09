// How wide the chat panel is. ChatPanel resizes it; the PDF viewer reads it to leave room.
export const WIDTH_KEY = 'doc-digest.chatWidth'
export const DEFAULT_WIDTH = 384
export const MIN_WIDTH = 280

/** Keep the panel between a usable minimum and leaving room for the PDF. */
export function clampWidth(px: number) {
  const max = Math.max(MIN_WIDTH, Math.min(window.innerWidth * 0.7, window.innerWidth - 320))
  return Math.round(Math.min(max, Math.max(MIN_WIDTH, px)))
}

export function readWidth() {
  try {
    return Number(localStorage.getItem(WIDTH_KEY)) || DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

/** Below this window width the chat floats over the PDF instead of sitting beside it. */
const OVERLAY_BELOW = 768

/** The width the chat takes beside the PDF when it opens, so the PDF can be sized to fit next to it. */
export function chatReserve() {
  return window.innerWidth < OVERLAY_BELOW ? 0 : clampWidth(readWidth())
}
