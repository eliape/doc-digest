import type * as PdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import type * as PdfjsViewer from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'

export type Pdfjs = { lib: typeof PdfjsLib; viewer: typeof PdfjsViewer }

let loading: Promise<Pdfjs> | undefined

/**
 * Load PDF.js and its viewer components once.
 *
 * The viewer module reads `globalThis.pdfjsLib` when it is evaluated, so the
 * core library has to be loaded and published first. Loading lazily also keeps
 * PDF.js out of the first paint.
 *
 * We use the "legacy" build: the modern one relies on very new JS features
 * (e.g. Map.prototype.getOrInsertComputed) that current Safari/WebKit, and so
 * a future Mac app's webview, does not have yet.
 */
export function loadPdfjs(): Promise<Pdfjs> {
  loading ??= (async () => {
    const [lib, { default: workerSrc }] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
    ])
    lib.GlobalWorkerOptions.workerSrc = workerSrc
    ;(globalThis as { pdfjsLib?: unknown }).pdfjsLib = lib
    const viewer = await import('pdfjs-dist/legacy/web/pdf_viewer.mjs')
    return { lib, viewer }
  })()
  return loading
}
