<script lang="ts">
  import 'pdfjs-dist/legacy/web/pdf_viewer.css'
  import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
  import type { PDFViewer } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'
  import { loadPdfjs } from './pdfjs'

  type Props = {
    /** The PDF's bytes. A new value opens a new document. */
    data: Uint8Array
    /** Current page, 1-based. Read it with bind:, change it with goToPage(). */
    page?: number
    pageCount?: number
    /** Current zoom, where 1 is 100%. */
    scale?: number
    onerror?: (error: unknown) => void
  }

  let {
    data,
    page = $bindable(1),
    pageCount = $bindable(0),
    scale = $bindable(1),
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
      eventBus.on('pagesinit', () => (pdfViewer.currentScaleValue = 'page-width'))
      eventBus.on('pagechanging', (e: { pageNumber: number }) => (page = e.pageNumber))
      eventBus.on('scalechanging', (e: { scale: number }) => (scale = e.scale))
      viewer = pdfViewer
    })
    return () => {
      cancelled = true
      viewer?.cleanup()
      viewer = undefined
    }
  })

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
      const task = lib.getDocument({ data: bytes.slice() })
      const doc = await task.promise
      if (opened !== bytes) {
        task.destroy()
        return
      }
      const previous = current
      current = task
      page = 1
      pageCount = doc.numPages
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
    if (viewer) viewer.currentScaleValue = String(value)
  }
</script>

<div class="viewer-container" bind:this={container} data-testid="pdf-viewer">
  <div class="pdfViewer"></div>
</div>

<style>
  /* PDF.js requires its scroll container to be absolutely positioned. */
  .viewer-container {
    position: absolute;
    inset: 0;
    overflow: auto;
    background: var(--viewer-bg);
  }
</style>
