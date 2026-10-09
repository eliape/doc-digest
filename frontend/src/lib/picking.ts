import type { Box, Pick, Point } from './context'

/** How far the mouse may move between press and release and still count as a click, in pixels. */
const CLICK_SLOP = 4
/**
 * Half the size of the square checked for ink around a click, in CSS pixels.
 * Generous, so a click on the white inside a diagram still counts.
 */
const INK_RADIUS = 40

type Rect = { left: number; top: number; width: number; height: number }

export function isClick(down: { x: number; y: number }, up: { x: number; y: number }): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) <= CLICK_SLOP
}

/** A point in the window as a spot on a page, or undefined when it is outside the page. */
export function pointOnPage(page: Rect, x: number, y: number): Point | undefined {
  const point = { x: (x - page.left) / page.width, y: (y - page.top) / page.height }
  if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return undefined
  return point
}

/** The area some rectangles (a selection's lines) cover on a page, clipped to it. */
export function boxOnPage(page: Rect, rects: Rect[]): Box | undefined {
  const clip = (v: number) => Math.min(1, Math.max(0, v))
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rects) {
    if (r.width === 0 && r.height === 0) continue
    x0 = Math.min(x0, clip((r.left - page.left) / page.width))
    y0 = Math.min(y0, clip((r.top - page.top) / page.height))
    x1 = Math.max(x1, clip((r.left + r.width - page.left) / page.width))
    y1 = Math.max(y1, clip((r.top + r.height - page.top) / page.height))
  }
  if (!(x1 > x0 && y1 > y0)) return undefined
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** Whether pixels (RGBA) are all close to white, i.e. a margin or gap with nothing to ask about. */
export function isBlank(pixels: Uint8ClampedArray): boolean {
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] > 16 && (pixels[i] < 230 || pixels[i + 1] < 230 || pixels[i + 2] < 230)) return false
  }
  return true
}

/** The rendered page's area: its canvas, without PDF.js's page border. */
function pageArea(pageEl: Element): Element {
  return pageEl.querySelector('.canvasWrapper') ?? pageEl
}

function pageNumberOf(pageEl: Element): number | undefined {
  const n = Number(pageEl.getAttribute('data-page-number'))
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** Whether the rendered page has ink (text, lines, images) near a point in the window. */
function hasInkNear(pageEl: Element, x: number, y: number): boolean {
  const canvas = pageEl.querySelector('.canvasWrapper canvas')
  if (!(canvas instanceof HTMLCanvasElement) || !canvas.width) return true
  const rect = canvas.getBoundingClientRect()
  const sx = canvas.width / rect.width
  const sy = canvas.height / rect.height
  const left = Math.max(0, Math.floor((x - rect.left - INK_RADIUS) * sx))
  const top = Math.max(0, Math.floor((y - rect.top - INK_RADIUS) * sy))
  const width = Math.min(canvas.width - left, Math.ceil(INK_RADIUS * 2 * sx))
  const height = Math.min(canvas.height - top, Math.ceil(INK_RADIUS * 2 * sy))
  if (width <= 0 || height <= 0) return false
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    return !ctx || !isBlank(ctx.getImageData(left, top, width, height).data)
  } catch {
    return true
  }
}

/** What a click at a point picks: the spot on the page under it, unless it is in a margin. */
export function pickAtPoint(target: Element, x: number, y: number): Pick | undefined {
  const pageEl = target.closest('.page')
  const page = pageEl && pageNumberOf(pageEl)
  if (!pageEl || !page) return undefined
  const point = pointOnPage(pageArea(pageEl).getBoundingClientRect(), x, y)
  if (!point || !hasInkNear(pageEl, x, y)) return undefined
  return { page, point }
}

/** What a text selection inside the viewer picks: its text and where it is, on the page it starts on. */
export function pickSelection(selection: Selection | null, container: Element): Pick | undefined {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined
  const text = selection.toString().trim()
  const range = selection.getRangeAt(0)
  const start = range.startContainer
  const startEl = start instanceof Element ? start : start.parentElement
  const pageEl = startEl?.closest('.page')
  const page = pageEl && pageNumberOf(pageEl)
  if (!text || !pageEl || !page || !container.contains(pageEl)) return undefined
  const box = boxOnPage(pageArea(pageEl).getBoundingClientRect(), Array.from(range.getClientRects()))
  return { page, box, selection: text }
}

/** Whether a point in the window is on a selection's text. */
export function isOnSelection(selection: Selection | null, x: number, y: number): boolean {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false
  const rects = Array.from(selection.getRangeAt(0).getClientRects())
  return rects.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
}

/** Clicks on these do their own thing (follow a link, press a button), so they never pick. */
export const NOT_PICKABLE = 'a, button, input, select, textarea, .linkAnnotation, .context-marker'
