<script lang="ts">
  import { formatScale, parsePageInput } from './pages'
  import PdfViewer from './PdfViewer.svelte'

  type Props = {
    /** The PDF's bytes. */
    data: Uint8Array
    onerror?: (error: unknown) => void
  }

  let { data, onerror }: Props = $props()

  // Each tab has its own page and zoom, and its own controls above the PDF.
  let viewer = $state<PdfViewer>()
  let page = $state(1)
  let pageCount = $state(0)
  let scale = $state(1)
  let pageInput = $state('1')

  // Keep the page box in sync while scrolling.
  $effect(() => {
    pageInput = String(page)
  })

  function submitPage(event: SubmitEvent) {
    event.preventDefault()
    const n = parsePageInput(pageInput, pageCount)
    if (n === null) pageInput = String(page)
    else viewer?.goToPage(n)
  }

  function onZoomSelect(event: Event) {
    const select = event.currentTarget as HTMLSelectElement
    const value = select.value
    viewer?.setZoom(value === 'page-width' || value === 'page-fit' ? value : Number(value))
    // Go back to showing the current zoom percentage.
    select.value = ''
  }

  export function zoomIn() {
    viewer?.zoomIn()
  }
  export function zoomOut() {
    viewer?.zoomOut()
  }
  export function fitWidth() {
    viewer?.setZoom('page-width')
  }
</script>

<div class="pane">
  <div class="controls">
    <nav class="group" aria-label="Pages">
      <button type="button" aria-label="Previous page" disabled={page <= 1} onclick={() => viewer?.previousPage()}
        >‹</button
      >
      <form onsubmit={submitPage}>
        <input
          class="page-input"
          aria-label="Page number"
          inputmode="numeric"
          bind:value={pageInput}
          onblur={() => (pageInput = String(page))}
        />
      </form>
      <span>of {pageCount}</span>
      <button type="button" aria-label="Next page" disabled={page >= pageCount} onclick={() => viewer?.nextPage()}
        >›</button
      >
    </nav>

    <div class="group" role="group" aria-label="Zoom">
      <button type="button" aria-label="Zoom out" onclick={() => viewer?.zoomOut()}>−</button>
      <select aria-label="Zoom level" onchange={onZoomSelect} value="">
        <option value="" disabled hidden>{formatScale(scale)}</option>
        <option value="page-width">Fit width</option>
        <option value="page-fit">Fit page</option>
        <option value="0.5">50%</option>
        <option value="1">100%</option>
        <option value="1.5">150%</option>
        <option value="2">200%</option>
      </select>
      <button type="button" aria-label="Zoom in" onclick={() => viewer?.zoomIn()}>+</button>
    </div>
  </div>

  <div class="viewer-area">
    <PdfViewer bind:this={viewer} {data} bind:page bind:pageCount bind:scale {onerror} />
  </div>
</div>

<style>
  .pane {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .controls {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.75rem;
    padding: 0.375rem 0.75rem;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }

  .group {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .group form {
    display: contents;
  }

  .page-input {
    width: 3rem;
    text-align: center;
  }

  /* PdfViewer fills this box (it positions itself absolutely). */
  .viewer-area {
    position: relative;
    flex: 1;
    min-height: 0;
  }
</style>
