<script lang="ts">
  import 'pdfjs-dist/legacy/web/pdf_viewer.css'
  import { untrack } from 'svelte'
  import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
  import type { PDFViewer } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'
  import { type Capture, capture as captureContext, type Pick } from './context'
  import { attachZoomGestures, type Origin } from './gestures'
  import { assetOptions, loadPdfjs } from './pdfjs'
  import { isClick, isOnSelection, NOT_PICKABLE, pickAtPoint, pickSelection } from './picking'
  import type { Tool } from './tools'

  type Props = {
    /** The PDF's bytes. A new value opens a new document. */
    data: Uint8Array
    /** Current page, 1-based. Read it with bind:, change it with goToPage(). */
    page?: number
    /** The page to open the PDF at, e.g. where the reader was last time. */
    startPage?: number
    pageCount?: number
    /** Current zoom, where 1 is 100%. */
    scale?: number
    /** The spot attached to the chat, marked on its page. */
    marker?: Pick
    /**
     * Pixels on the right the chat will take when it opens. Fitting leaves them free, so opening
     * the chat does not resize the page.
     */
    reserve?: number
    /**
     * What a left click does: with `ask`, clicking a spot or selecting text calls `onpick`;
     * with `select`, clicks and selections are the browser's own.
     */
    tool?: Tool
    /** Called with the Click to ask tool when the reader clicks a spot on a page or selects text, to ask about it. */
    onpick?: (pick: Pick) => void
    /**
     * Called when the reader right-clicks a spot or their selection, with where in the window,
     * to show a menu of things to do with it. Elsewhere the browser's own menu shows.
     */
    oncontextpick?: (pick: Pick, at: { x: number; y: number }) => void
    /** Called when the reader clicks the marker, to take it off the chat. */
    onmarkerclick?: () => void
    onerror?: (error: unknown) => void
  }

  let {
    data,
    page = $bindable(1),
    startPage = 1,
    pageCount = $bindable(0),
    scale = $bindable(1),
    marker,
    reserve = 0,
    tool = 'select',
    onpick,
    oncontextpick,
    onmarkerclick,
    onerror,
  }: Props = $props()

  let container: HTMLDivElement
  let viewer = $state.raw<PDFViewer>()

  // Build the PDF.js viewer once, after the container is in the DOM.
  $effect(() => {
    let cancelled = false
    loadPdfjs().then(({ viewer: v }) => {
      if (cancelled) return
      const eventBus = new v.EventBus()
      const linkService = new v.PDFLinkService({ eventBus })
      const pdfViewer = new v.PDFViewer({ container, eventBus, linkService })
      linkService.setViewer(pdfViewer)
      // Fit new documents to the window width, like most PDF readers.
      eventBus.on('pagesinit', () => {
        fitWidth(pdfViewer)
        if (startPage > 1 && startPage <= pdfViewer.pagesCount) pdfViewer.currentPageNumber = startPage
      })
      eventBus.on('pagechanging', (e: { pageNumber: number }) => (page = e.pageNumber))
      eventBus.on('scalechanging', (e: { scale: number }) => (scale = e.scale))
      // PDF.js clears its page boxes when it re-renders them (on zoom, or when
      // scrolling back to a page), so put the markers back each time.
      eventBus.on('pagerendered', () => drawMarkers())
      viewer = pdfViewer
    })
    return () => {
      cancelled = true
      viewer?.cleanup()
      viewer = undefined
    }
  })

  // PDF.js leaves 40px beside a page that is fitted to the width.
  const FIT_MARGIN = 40

  /** Fit the page width to the viewer minus `reserve`, so the chat can open beside it later. */
  function fitWidth(pdfViewer: PDFViewer) {
    pdfViewer.currentScaleValue = 'page-width'
    const free = container.clientWidth - reserve - FIT_MARGIN
    if (reserve > 0 && free > 100) pdfViewer.currentScale = (pdfViewer.currentScale * free) / (container.clientWidth - FIT_MARGIN)
  }

  // PDF.js rounds each zoom step to whole percents, which would swallow the tiny
  // steps a pinch sends. So keep the exact target scale while a gesture lasts.
  let target: number | undefined
  let targetTimer: ReturnType<typeof setTimeout> | undefined

  function zoomBy(factor: number, origin: Origin) {
    if (!viewer) return
    target = Math.min(25, Math.max(0.1, (target ?? viewer.currentScale) * factor))
    viewer.updateScale({ scaleFactor: target / viewer.currentScale, origin, drawingDelay: 120 })
    clearTimeout(targetTimer)
    targetTimer = setTimeout(() => (target = undefined), 200)
  }

  $effect(() => attachZoomGestures(container, zoomBy))

  $effect(() => () => clearTimeout(targetTimer))

  // With the Click to ask tool, a press and release in the same place on a page is a
  // click, which picks the spot under it; a release that leaves text selected picks that text.
  let down: { x: number; y: number; focused: boolean } | undefined

  // The selection a right-click (or a Mac's ctrl+click) lands on, read before the press
  // itself can change it: on a Mac, right-clicking a word selects it.
  let rightClickedSelection: Pick | undefined

  function onPointerDown(event: PointerEvent) {
    down =
      event.button === 0 && event.isPrimary
        ? { x: event.clientX, y: event.clientY, focused: document.hasFocus() }
        : undefined
    const selection = window.getSelection()
    const secondary = event.button === 2 || (event.button === 0 && event.ctrlKey)
    rightClickedSelection =
      secondary && isOnSelection(selection, event.clientX, event.clientY) ? pickSelection(selection, container) : undefined
  }

  function onPointerUp(event: PointerEvent) {
    const start = down
    down = undefined
    if (tool !== 'ask' || !start || event.button !== 0 || !(event.target instanceof Element)) return
    if (event.target.closest(NOT_PICKABLE)) return
    const selected = pickSelection(window.getSelection(), container)
    if (selected) return onpick?.(selected)
    // A click that only brings the window to the front picks nothing.
    if (!start.focused || !isClick(start, { x: event.clientX, y: event.clientY })) return
    const pick = pickAtPoint(event.target, event.clientX, event.clientY)
    if (pick) onpick?.(pick)
  }

  // With either tool, a right-click on a spot or on the selection opens a menu for it instead of the browser's.
  function onContextMenu(event: MouseEvent) {
    const selected = rightClickedSelection
    rightClickedSelection = undefined
    // On a Mac, ctrl+click opens this menu too; the release that follows is not a click.
    down = undefined
    if (!oncontextpick || !(event.target instanceof Element) || event.target.closest(NOT_PICKABLE)) return
    const pick = selected ?? pickAtPoint(event.target, event.clientX, event.clientY)
    if (!pick) return
    event.preventDefault()
    oncontextpick(pick, { x: event.clientX, y: event.clientY })
  }

  // Markers: the attached spot, a short flash where a chip in the chat points, and spots fading out.
  let flash = $state<Pick>()
  let flashTimer: ReturnType<typeof setTimeout> | undefined

  // How long a marker takes to fade out (the .fade animation below).
  const FADE_MS = 700
  // Not state: drawing is done by hand, and these only live until they have faded.
  let fading: { pick: Pick; start: number }[] = []
  const fadeTimers = new Set<ReturnType<typeof setTimeout>>()

  /** Draw a marker that fades out straight away. */
  function fadeOut(pick: Pick) {
    const item = { pick, start: performance.now() }
    fading.push(item)
    const timer = setTimeout(() => {
      fadeTimers.delete(timer)
      fading = fading.filter((f) => f !== item)
      drawMarkers()
    }, FADE_MS)
    fadeTimers.add(timer)
    drawMarkers()
  }

  const place = (pick: Pick) => JSON.stringify([pick.page, pick.point, pick.box])

  // The attached spot fades out when it is taken off or replaced. Its images arriving
  // replace it with a copy in the same place, which is not a change.
  let drawn: Pick | undefined
  $effect(() => {
    const was = drawn
    drawn = marker
    if (was && (!marker || place(marker) !== place(was))) untrack(() => fadeOut(was))
  })

  function drawMarkers() {
    if (!container) return
    for (const el of container.querySelectorAll('.context-marker')) el.remove()
    // A redraw (zoom, scrolling back to a page) picks a fade up where it had got to.
    const now = performance.now()
    for (const { pick, start } of fading) drawMarker(pick, 'fade', now - start)
    if (marker) drawMarker(marker, 'attached')
    if (flash) drawMarker(flash, 'flash')
  }

  function drawMarker(pick: Pick, kind: 'attached' | 'flash' | 'fade', elapsed = 0) {
    // The rendered page fills its page box, so positions are percentages of it and survive zooming.
    const pageEl = container.querySelector(`.page[data-page-number="${pick.page}"]`)
    if (!pageEl) return
    const el = document.createElement('div')
    el.className = `context-marker ${pick.box ? 'box' : 'point'}${kind === 'attached' ? '' : ` ${kind}`}`
    if (elapsed) el.style.animationDelay = `-${elapsed}ms`
    const percent = (v: number) => `${v * 100}%`
    if (pick.box) {
      Object.assign(el.style, {
        left: percent(pick.box.x),
        top: percent(pick.box.y),
        width: percent(pick.box.width),
        height: percent(pick.box.height),
      })
    } else if (pick.point) {
      Object.assign(el.style, { left: percent(pick.point.x), top: percent(pick.point.y) })
    } else {
      return
    }
    if (kind === 'attached') {
      el.title = 'Attached to the chat. Click to remove it.'
      el.setAttribute('role', 'button')
      el.setAttribute('aria-label', 'Remove from the chat')
      el.addEventListener('click', () => onmarkerclick?.())
    }
    pageEl.appendChild(el)
  }

  $effect(() => {
    void marker
    void flash
    drawMarkers()
  })
  $effect(() => () => {
    clearTimeout(flashTimer)
    for (const timer of fadeTimers) clearTimeout(timer)
  })

  let pdfDocument: PDFDocumentProxy | undefined
  let opened: Uint8Array | undefined
  let current: PDFDocumentLoadingTask | undefined

  // Open a new document whenever `data` changes (once the viewer exists).
  $effect(() => {
    if (viewer) openDocument(viewer, data)
  })

  async function openDocument(pdfViewer: PDFViewer, bytes: Uint8Array) {
    if (bytes === opened) return
    opened = bytes
    const { lib } = await loadPdfjs()
    try {
      // PDF.js transfers the buffer to its worker, so hand it a copy.
      const task = lib.getDocument({ data: bytes.slice(), ...assetOptions() })
      const doc = await task.promise
      if (opened !== bytes) {
        task.destroy()
        return
      }
      const previous = current
      current = task
      page = 1
      pageCount = doc.numPages
      pdfDocument = doc
      pdfViewer.setDocument(doc)
      ;(pdfViewer.linkService as { setDocument(d: PDFDocumentProxy): void }).setDocument(doc)
      previous?.destroy()
    } catch (error) {
      onerror?.(error)
    }
  }

  $effect(() => () => {
    current?.destroy()
  })

  /** Images and text for a question about a spot or a page, or undefined before the PDF has opened. */
  export async function capture(pick: Pick): Promise<Capture | undefined> {
    return pdfDocument ? captureContext(pdfDocument, pick) : undefined
  }

  /** Scroll to a picked spot and flash it. */
  export function reveal(pick: Pick) {
    if (!viewer || pick.page < 1 || pick.page > viewer.pagesCount) return
    const view = viewer.getPageView(pick.page - 1) as { viewport: { width: number; height: number; convertToPdfPoint(x: number, y: number): number[] } } | undefined
    const spot = pick.box ? { x: pick.box.x, y: pick.box.y } : pick.point
    if (view && spot) {
      // Leave some of the page above the spot in view.
      const [x, y] = view.viewport.convertToPdfPoint(0, Math.max(0, spot.y - 0.08) * view.viewport.height)
      viewer.scrollPageIntoView({ pageNumber: pick.page, destArray: [null, { name: 'XYZ' }, x, y, null] })
    } else {
      viewer.currentPageNumber = pick.page
    }
    clearTimeout(flashTimer)
    flash = pick
    flashTimer = setTimeout(() => (flash = undefined), 1600)
  }

  /** Mark a spot for a moment: the marker fades out straight away. */
  export function markBriefly(pick: Pick) {
    fadeOut(pick)
  }

  export function goToPage(n: number) {
    if (viewer && n >= 1 && n <= viewer.pagesCount) viewer.currentPageNumber = n
  }
  export function nextPage() {
    viewer?.nextPage()
  }
  export function previousPage() {
    viewer?.previousPage()
  }
  export function zoomIn() {
    viewer?.increaseScale()
  }
  export function zoomOut() {
    viewer?.decreaseScale()
  }
  /** Set zoom to a number (1 = 100%) or a PDF.js preset like 'page-width' or 'page-fit'. */
  export function setZoom(value: number | 'page-width' | 'page-fit' | 'auto') {
    if (!viewer) return
    if (value === 'page-width') fitWidth(viewer)
    else viewer.currentScaleValue = String(value)
  }
</script>

<div
  class="viewer-container"
  class:ask={tool === 'ask'}
  bind:this={container}
  data-testid="pdf-viewer"
  role="presentation"
  onpointerdown={onPointerDown}
  onpointerup={onPointerUp}
  oncontextmenu={onContextMenu}
>
  <div class="pdfViewer"></div>
</div>

<style>
  /* PDF.js requires its scroll container to be absolutely positioned. */
  .viewer-container {
    position: absolute;
    inset: 0;
    overflow: auto;
    background: var(--viewer-bg);
    /* Scrolling stays native, but pinches go to us instead of zooming the page. */
    touch-action: pan-x pan-y;
  }

  /* With Click to ask, the pointer is a hand over the pages (text too), so the tool shows where it acts. */
  .viewer-container.ask :global(.page),
  .viewer-container.ask :global(.textLayer :is(span, br)) {
    cursor: pointer;
  }

  /* Markers are added inside PDF.js's page boxes, outside this component's markup. */
  .viewer-container :global(.context-marker) {
    position: absolute;
    z-index: 3;
    box-sizing: border-box;
    border: 3px solid var(--marker, #e5221b);
    cursor: pointer;
  }
  .viewer-container :global(.context-marker.point) {
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 50%;
    transform: translate(-50%, -50%);
    box-shadow: 0 0 0 2px rgb(255 255 255 / 0.8);
  }
  .viewer-container :global(.context-marker.box) {
    margin: -3px;
    border-width: 2px;
    border-radius: 3px;
    background: rgb(229 34 27 / 0.08);
  }
  .viewer-container :global(.context-marker.flash) {
    pointer-events: none;
    animation: context-flash 1.6s ease-out forwards;
  }
  @keyframes context-flash {
    0%,
    60% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }
  .viewer-container :global(.context-marker.fade) {
    pointer-events: none;
    animation: context-fade 0.7s ease-in forwards;
  }
  @keyframes context-fade {
    to {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .viewer-container :global(.context-marker.flash),
    .viewer-container :global(.context-marker.fade) {
      animation: none;
    }
  }
</style>
