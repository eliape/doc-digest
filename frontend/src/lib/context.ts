import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'

/** A spot on a page, from 0 to 1 across and down, so it does not depend on zoom. */
export type Point = { x: number; y: number }
/** An area on a page, in the same 0 to 1 units. */
export type Box = { x: number; y: number; width: number; height: number }

/** What the reader pointed at: a spot they clicked, or text they selected. */
export type Pick = { page: number; point?: Point; box?: Box; selection?: string }

/** Text the PDF has on a page. Scanned pages often have none. */
export type PageText = { page: number; label?: string; text: string }

/**
 * Where a question comes from, attached to it in the chat: the page, the
 * spot or selection on it, and what the model gets to see.
 */
export type PageContext = Pick & {
  docId: string
  docName: string
  pageLabel?: string
  section?: string
  /** Text the PDF has around the spot. */
  nearbyText?: string
  /** The whole page as a base64 JPEG, with the spot marked. */
  pageImage?: string
  /** A close-up around the spot as a base64 JPEG, with the spot marked. */
  crop?: string
  /** A small image shown on the chip, as a data URL. */
  thumbnail?: string
  /** Text of the page and the pages either side. */
  pageTexts: PageText[]
}

/** Images and text for a pick, without the document's id and name. */
export type Capture = Omit<PageContext, 'docId' | 'docName'>

// Images are sized for the model: it scales anything with a longer side down to about this.
const PAGE_IMAGE_SIDE = 1568
const CROP_IMAGE_SIDE = 1200
const THUMBNAIL_WIDTH = 240
const MAX_PAGE_TEXT = 8000
const MAX_NEARBY_TEXT = 2000
const MARK = '#e5221b'

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * The area of the page the close-up shows: wide enough for a whole equation or
 * figure around a clicked spot, or a selection with some margin.
 */
export function cropRegion(pick: Pick): Box {
  let width: number
  let height: number
  let cx: number
  let cy: number
  if (pick.box) {
    width = Math.max(0.5, pick.box.width + 0.16)
    height = Math.max(0.2, pick.box.height + 0.1)
    cx = pick.box.x + pick.box.width / 2
    cy = pick.box.y + pick.box.height / 2
  } else {
    width = 0.7
    height = 0.3
    cx = pick.point?.x ?? 0.5
    cy = pick.point?.y ?? 0.5
  }
  width = Math.min(1, width)
  height = Math.min(1, height)
  return {
    x: clamp(cx - width / 2, 0, 1 - width),
    y: clamp(cy - height / 2, 0, 1 - height),
    width,
    height,
  }
}

/** A text item from PDF.js with where it starts on the page, in 0 to 1 units. */
export type PlacedText = { text: string; x: number; y: number; eol: boolean }

/** Join text items into a string, keeping the PDF's line breaks. */
export function joinText(items: PlacedText[]): string {
  return items
    .map((item) => item.text + (item.eol ? '\n' : ''))
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The text that starts inside an area of the page. */
export function textInRegion(items: PlacedText[], region: Box): string {
  const inside = items.filter(
    (item) =>
      item.x >= region.x - 0.02 &&
      item.x <= region.x + region.width &&
      item.y >= region.y &&
      item.y <= region.y + region.height + 0.01,
  )
  return joinText(inside.map((item, i) => ({ ...item, eol: item.eol || i === inside.length - 1 })))
}

/** Shorten long text, marking the cut. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()} …`
}

/** Outline entries with the page they start on. */
export type Heading = { title: string; page: number }

/** The heading a page belongs to: the last one that starts on or before it. */
export function sectionFor(headings: Heading[], page: number): string | undefined {
  let best: Heading | undefined
  for (const heading of headings) {
    if (heading.page <= page && (!best || heading.page >= best.page)) best = heading
  }
  return best?.title
}

const outlines = new WeakMap<PDFDocumentProxy, Promise<Heading[]>>()

/** The PDF's outline (bookmarks), flattened, with page numbers. Empty when it has none. */
function headings(doc: PDFDocumentProxy): Promise<Heading[]> {
  let found = outlines.get(doc)
  if (!found) {
    found = (async () => {
      const result: Heading[] = []
      type Node = { title: string; dest: string | unknown[] | null; items: Node[] }
      const visit = async (nodes: Node[]) => {
        for (const node of nodes) {
          try {
            const dest = typeof node.dest === 'string' ? await doc.getDestination(node.dest) : node.dest
            const ref = dest?.[0]
            if (ref != null) {
              const index = typeof ref === 'number' ? ref : await doc.getPageIndex(ref as never)
              result.push({ title: node.title, page: index + 1 })
            }
          } catch {
            // Outlines can point at things that aren't pages; skip those.
          }
          await visit(node.items ?? [])
        }
      }
      await visit(((await doc.getOutline()) ?? []) as Node[])
      return result
    })().catch(() => [])
    outlines.set(doc, found)
  }
  return found
}

async function placedText(page: PDFPageProxy): Promise<PlacedText[]> {
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const items: PlacedText[] = []
  for (const item of content.items) {
    if (!('str' in item)) continue
    const [vx, vy] = viewport.convertToViewportPoint(item.transform[4], item.transform[5])
    items.push({ text: item.str, x: vx / viewport.width, y: vy / viewport.height, eol: item.hasEOL })
  }
  return items
}

function newCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  return canvas
}

/** Draw the mark the model is told to look at: a ring around a spot, or a frame around a selection. */
function drawMark(canvas: HTMLCanvasElement, pick: Pick, region: Box) {
  const ctx = canvas.getContext('2d')!
  const toX = (x: number) => ((x - region.x) / region.width) * canvas.width
  const toY = (y: number) => ((y - region.y) / region.height) * canvas.height
  const line = Math.max(2, Math.round(Math.max(canvas.width, canvas.height) / 400))
  ctx.strokeStyle = MARK
  ctx.lineWidth = line
  if (pick.box) {
    const pad = line * 2
    ctx.strokeRect(
      toX(pick.box.x) - pad,
      toY(pick.box.y) - pad,
      (pick.box.width / region.width) * canvas.width + pad * 2,
      (pick.box.height / region.height) * canvas.height + pad * 2,
    )
  } else if (pick.point) {
    const radius = Math.max(canvas.width, canvas.height) * 0.018 * (1 / Math.max(region.width, region.height))
    ctx.beginPath()
    ctx.arc(toX(pick.point.x), toY(pick.point.y), Math.max(radius, line * 5), 0, Math.PI * 2)
    ctx.stroke()
  }
}

/** Render part of a page (the whole page by default) to a white-backed canvas whose longer side is `side`. */
async function renderRegion(page: PDFPageProxy, region: Box, side: number) {
  const base = page.getViewport({ scale: 1 })
  const scale = side / Math.max(base.width * region.width, base.height * region.height)
  const viewport = page.getViewport({
    scale,
    offsetX: -region.x * base.width * scale,
    offsetY: -region.y * base.height * scale,
  })
  const canvas = newCanvas(base.width * region.width * scale, base.height * region.height * scale)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvas, canvasContext: ctx, viewport, background: '#fff' }).promise
  return canvas
}

const toBase64Jpeg = (canvas: HTMLCanvasElement) => canvas.toDataURL('image/jpeg', 0.85).split(',')[1]

/**
 * A small 4:3 image for the chip, showing the marked spot up close, or the
 * selection, or the top of the page when nothing is marked.
 */
function thumbnailOf(canvas: HTMLCanvasElement, pick: Pick, region: Box): string {
  const { width: w, height: h } = canvas
  let sw = Math.min(w, h * (4 / 3))
  if (pick.point) sw = Math.min(sw, w * 0.4)
  if (pick.box) sw = Math.min(w, Math.max(sw * 0.4, (pick.box.width / region.width) * w * 1.1))
  const sh = Math.min(h, sw * 0.75)
  const spot = pick.box
    ? { x: pick.box.x + pick.box.width / 2, y: pick.box.y + pick.box.height / 2 }
    : (pick.point ?? { x: 0.5, y: region.y })
  const cx = ((spot.x - region.x) / region.width) * w
  const cy = pick.point || pick.box ? ((spot.y - region.y) / region.height) * h : sh / 2
  const sx = clamp(cx - sw / 2, 0, w - sw)
  const sy = clamp(cy - sh / 2, 0, h - sh)
  const small = newCanvas(THUMBNAIL_WIDTH, THUMBNAIL_WIDTH * 0.75)
  const ctx = small.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, small.width, small.height)
  ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, small.width, small.height)
  return small.toDataURL('image/jpeg', 0.8)
}

/**
 * Everything the model gets for a question about a page: images of the page
 * and of the picked spot with the spot marked, the PDF's text around it and on
 * the pages either side, the page's printed label and its section.
 */
export async function capture(doc: PDFDocumentProxy, pick: Pick): Promise<Capture> {
  const page = await doc.getPage(pick.page)
  const whole: Box = { x: 0, y: 0, width: 1, height: 1 }
  const marked = pick.point || pick.box
  const region = cropRegion(pick)

  const [pageCanvas, cropCanvas, labels, outline, items] = await Promise.all([
    renderRegion(page, whole, PAGE_IMAGE_SIDE),
    marked ? renderRegion(page, region, CROP_IMAGE_SIDE) : undefined,
    doc.getPageLabels().catch(() => null),
    headings(doc),
    placedText(page).catch(() => []),
  ])
  if (marked) {
    drawMark(pageCanvas, pick, whole)
    drawMark(cropCanvas!, pick, region)
  }

  const neighbours = [pick.page - 1, pick.page, pick.page + 1].filter((n) => n >= 1 && n <= doc.numPages)
  const pageTexts = await Promise.all(
    neighbours.map(async (n) => {
      const text = n === pick.page ? joinText(items) : joinText(await doc.getPage(n).then(placedText).catch(() => []))
      return { page: n, label: labels?.[n - 1] || undefined, text: truncate(text, MAX_PAGE_TEXT) }
    }),
  )

  return {
    ...pick,
    pageLabel: labels?.[pick.page - 1] || undefined,
    section: sectionFor(outline, pick.page),
    nearbyText: marked ? truncate(textInRegion(items, region), MAX_NEARBY_TEXT) || undefined : undefined,
    pageImage: toBase64Jpeg(pageCanvas),
    crop: cropCanvas ? toBase64Jpeg(cropCanvas) : undefined,
    thumbnail: cropCanvas ? thumbnailOf(cropCanvas, pick, region) : thumbnailOf(pageCanvas, pick, whole),
    pageTexts,
  }
}

/** How a context is named on its chip: "p. 12", using the printed page number when there is one. */
export function contextLabel(context: Pick & { pageLabel?: string }): string {
  return `p. ${context.pageLabel || context.page}`
}
