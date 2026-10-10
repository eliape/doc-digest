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
  /**
   * What the model sees, as a base64 JPEG: the whole page, or with a spot or
   * selection a band around it with the spot marked (see `windowSlices`).
   */
  pageImage?: string
  /** The pages the band shows parts of, in order. Absent when the image is the whole page. */
  imagePages?: number[]
  /** A small image shown on the chip, as a data URL. */
  thumbnail?: string
  /** Text of what the image shows, per page. */
  pageTexts: PageText[]
}

/** Images and text for a pick, without the document's id and name. */
export type Capture = Omit<PageContext, 'docId' | 'docName'>

// Images are sized for the model: it scales anything with a longer side down to about this.
const PAGE_IMAGE_SIDE = 1568
// The close-up is only rendered for the chip's thumbnail; the model gets the marked page.
const CROP_IMAGE_SIDE = 800
const THUMBNAIL_WIDTH = 240
const MAX_PAGE_TEXT = 3000
const MAX_NEARBY_TEXT = 2000
const MARK = '#e5221b'
const PAGE_BREAK = '#8a8a8a'
/** How tall the image around a spot is, as a share of a page's height. */
export const WINDOW_HEIGHT = 0.8

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

/** Part of a page, from `from` to `to` down it (0 to 1). */
export type Slice = { page: number; from: number; to: number }

/**
 * The parts of pages the image around a spot shows: a band WINDOW_HEIGHT of a
 * page tall centred on the spot, since a page is not a unit of meaning. Near the
 * top or bottom of a page it runs into the previous or next page; at the start
 * or end of the document it slides back inside. Neighbouring pages are assumed
 * to be about the same size.
 */
export function windowSlices(page: number, centre: number, pageCount: number): Slice[] {
  let top = centre - WINDOW_HEIGHT / 2
  let bottom = centre + WINDOW_HEIGHT / 2
  if (top < 0 && page === 1) [top, bottom] = [0, WINDOW_HEIGHT]
  if (bottom > 1 && page === pageCount) [top, bottom] = [1 - WINDOW_HEIGHT, 1]
  if (top < 0) {
    return [
      { page: page - 1, from: 1 + top, to: 1 },
      { page, from: 0, to: bottom },
    ]
  }
  if (bottom > 1) {
    return [
      { page, from: top, to: 1 },
      { page: page + 1, from: 0, to: bottom - 1 },
    ]
  }
  return [{ page, from: top, to: bottom }]
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

/** Render part of a page to a white-backed canvas whose longer side is `side`. */
function renderRegion(page: PDFPageProxy, region: Box, side: number) {
  const base = page.getViewport({ scale: 1 })
  return renderAt(page, region, side / Math.max(base.width * region.width, base.height * region.height))
}

/** Render part of a page to a white-backed canvas at a given scale. */
async function renderAt(page: PDFPageProxy, region: Box, scale: number) {
  const base = page.getViewport({ scale: 1 })
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

const sliceBox = (slice: Slice): Box => ({ x: 0, y: slice.from, width: 1, height: slice.to - slice.from })

/**
 * The band around a spot as one image, `width` pixels wide: each page part is
 * rendered at that width and stacked, with a grey dashed line and both page
 * numbers where one page ends and the next begins. The spot is marked on the
 * picked page's part.
 */
async function renderWindow(
  doc: PDFDocumentProxy,
  pick: Pick,
  slices: Slice[],
  width: number,
  name: (page: number) => string,
): Promise<HTMLCanvasElement> {
  const parts = await Promise.all(
    slices.map(async (slice) => {
      const page = await doc.getPage(slice.page)
      const canvas = await renderAt(page, sliceBox(slice), width / page.getViewport({ scale: 1 }).width)
      if (slice.page === pick.page) drawMark(canvas, pick, sliceBox(slice))
      return canvas
    }),
  )
  const out = newCanvas(width, parts.reduce((sum, part) => sum + part.height, 0))
  const ctx = out.getContext('2d')!
  let y = 0
  parts.forEach((part, i) => {
    ctx.drawImage(part, 0, y)
    if (i > 0) {
      const line = Math.max(2, Math.round(width / 500))
      ctx.strokeStyle = PAGE_BREAK
      ctx.lineWidth = line
      ctx.setLineDash([line * 6, line * 4])
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
      ctx.stroke()
      ctx.setLineDash([])
      const label = `end of ${name(slices[i - 1].page)} · start of ${name(slices[i].page)}`
      const size = Math.max(12, Math.round(width / 70))
      ctx.font = `${size}px sans-serif`
      const textWidth = ctx.measureText(label).width
      ctx.fillStyle = '#fff'
      ctx.fillRect(width - textWidth - size * 1.5, y - size * 0.8, textWidth + size, size * 1.6)
      ctx.fillStyle = PAGE_BREAK
      ctx.textBaseline = 'middle'
      ctx.fillText(label, width - textWidth - size, y)
    }
    y += part.height
  })
  return out
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
 * Everything the model gets for a question about a page: an image of what the
 * reader is looking at, the PDF's text for it and around the spot, the page's
 * printed label and its section. Without a spot the image is the whole page;
 * with one it is a band around the spot (see `windowSlices`), drawn at the same
 * scale as the whole page would be, so it costs less and crosses page breaks.
 */
export async function capture(doc: PDFDocumentProxy, pick: Pick): Promise<Capture> {
  const page = await doc.getPage(pick.page)
  const whole: Box = { x: 0, y: 0, width: 1, height: 1 }
  const marked = pick.point || pick.box
  const region = cropRegion(pick)
  const base = page.getViewport({ scale: 1 })
  const pageWidth = (PAGE_IMAGE_SIDE * base.width) / Math.max(base.width, base.height)
  const centre = pick.box ? pick.box.y + pick.box.height / 2 : (pick.point?.y ?? 0.5)
  const slices = marked ? windowSlices(pick.page, centre, doc.numPages) : [{ page: pick.page, from: 0, to: 1 }]

  const [labels, outline, texts] = await Promise.all([
    doc.getPageLabels().catch(() => null),
    headings(doc),
    Promise.all(slices.map((slice) => doc.getPage(slice.page).then(placedText).catch(() => [] as PlacedText[]))),
  ])
  const label = (n: number) => labels?.[n - 1] || undefined
  const items = texts[slices.findIndex((slice) => slice.page === pick.page)]
  const [imageCanvas, cropCanvas] = await Promise.all([
    marked
      ? renderWindow(doc, pick, slices, pageWidth, (n) => contextLabel({ page: n, pageLabel: label(n) }))
      : renderRegion(page, whole, PAGE_IMAGE_SIDE),
    marked ? renderRegion(page, region, CROP_IMAGE_SIDE) : undefined,
  ])

  const pageTexts = slices.map((slice, i) => {
    const text = marked ? textInRegion(texts[i], sliceBox(slice)) : joinText(texts[i])
    const share = Math.min(1, (slice.to - slice.from) / (marked ? WINDOW_HEIGHT : 1))
    return { page: slice.page, label: label(slice.page), text: truncate(text, Math.round(MAX_PAGE_TEXT * share)) }
  })

  return {
    ...pick,
    pageLabel: label(pick.page),
    section: sectionFor(outline, pick.page),
    nearbyText: marked ? truncate(textInRegion(items, region), MAX_NEARBY_TEXT) || undefined : undefined,
    pageImage: toBase64Jpeg(imageCanvas),
    imagePages: marked ? slices.map((slice) => slice.page) : undefined,
    thumbnail: cropCanvas ? thumbnailOf(cropCanvas, pick, region) : thumbnailOf(imageCanvas, pick, whole),
    pageTexts,
  }
}

/** How a context is named on its chip: "p. 12", using the printed page number when there is one. */
export function contextLabel(context: Pick & { pageLabel?: string }): string {
  return `p. ${context.pageLabel || context.page}`
}
