<script lang="ts">
  import type { Pick } from './context'
  import { formatScale, parsePageInput } from './pages'
  import PdfViewer from './PdfViewer.svelte'

  type Props = {
    /** The PDF's bytes. */
    data: Uint8Array
    /** Whether this is the open tab. Only the open tab's controls are shown. */
    active?: boolean
    /** Where the controls go: a slot in the tab row, so they share its space. */
    controlsTarget?: HTMLElement
    /** The spot attached to the chat, if it is in this PDF. */
    marker?: Pick
    onpick?: (pick: Pick) => void
    onmarkerclick?: () => void
    onerror?: (error: unknown) => void
  }

  let { data, active = true, controlsTarget, marker, onpick, onmarkerclick, onerror }: Props = $props()

  // Each tab has its own page and zoom, which its controls show while it is open.
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

  /** Move an element into another one (and take it out again when it goes away). */
  function portal(node: HTMLElement, target: HTMLElement) {
    target.appendChild(node)
    return { destroy: () => node.remove() }
  }

  /** Images and text for a question about a spot, or about the page being read when no spot is given. */
  export function capture(pick: Pick = { page }) {
    return viewer?.capture(pick) ?? Promise.resolve(undefined)
  }
  export function reveal(pick: Pick) {
    viewer?.reveal(pick)
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

{#if active && controlsTarget}
  <div class="controls" role="toolbar" aria-label="PDF controls" use:portal={controlsTarget}>
    <div class="group" role="group" aria-label="Pages">
      <button type="button" aria-label="Previous page" disabled={page <= 1} onclick={() => viewer?.previousPage()}
        >↑</button
      >
      <button type="button" aria-label="Next page" disabled={page >= pageCount} onclick={() => viewer?.nextPage()}
        >↓</button
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
      <span class="count">of {pageCount}</span>
    </div>

    <div class="group" role="group" aria-label="Zoom">
      <button type="button" aria-label="Zoom out" onclick={() => viewer?.zoomOut()}>−</button>
      <button type="button" aria-label="Zoom in" onclick={() => viewer?.zoomIn()}>+</button>
      <select aria-label="Zoom level" onchange={onZoomSelect} value="">
        <option value="" disabled hidden>{formatScale(scale)}</option>
        <option value="page-width">Fit width</option>
        <option value="page-fit">Fit page</option>
        <option value="0.5">50%</option>
        <option value="1">100%</option>
        <option value="1.5">150%</option>
        <option value="2">200%</option>
      </select>
    </div>
  </div>
{/if}

<!-- PdfViewer fills this box (it positions itself absolutely). -->
<div class="viewer-area">
  <PdfViewer
    bind:this={viewer}
    {data}
    bind:page
    bind:pageCount
    bind:scale
    {marker}
    {onpick}
    {onmarkerclick}
    {onerror}
  />
</div>

<style>
  .controls {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0 0.5rem;
    white-space: nowrap;
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

  .viewer-area {
    position: absolute;
    inset: 0;
  }
</style>
