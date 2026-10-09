<script lang="ts">
  import type { Pick } from './context'
  import { formatScale, parsePageInput } from './pages'
  import PdfViewer from './PdfViewer.svelte'
  import { type Tool, TOOLS } from './tools'

  type Props = {
    /** The PDF's bytes. */
    data: Uint8Array
    /** Whether this is the open tab. Only the open tab's controls are shown. */
    active?: boolean
    /** Where the controls go: a slot in the tab row, so they share its space. */
    controlsTarget?: HTMLElement
    /** The spot attached to the chat, if it is in this PDF. */
    marker?: Pick
    /** Pixels the chat will take beside the PDF when it opens (see PdfViewer). */
    reserve?: number
    /** What a left click on the PDF does (see PdfViewer). The controls switch it for every tab. */
    tool?: Tool
    ontoolchange?: (tool: Tool) => void
    onpick?: (pick: Pick) => void
    oncontextpick?: (pick: Pick, at: { x: number; y: number }) => void
    onmarkerclick?: () => void
    onerror?: (error: unknown) => void
  }

  let {
    data,
    active = true,
    controlsTarget,
    marker,
    reserve,
    tool,
    ontoolchange,
    onpick,
    oncontextpick,
    onmarkerclick,
    onerror,
  }: Props = $props()

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
  export function markBriefly(pick: Pick) {
    viewer?.markBriefly(pick)
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
      <button
        type="button"
        class="chrome-button"
        aria-label="Previous page"
        disabled={page <= 1}
        onclick={() => viewer?.previousPage()}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
      </button>
      <button
        type="button"
        class="chrome-button"
        aria-label="Next page"
        disabled={page >= pageCount}
        onclick={() => viewer?.nextPage()}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M19 12l-7 7-7-7" /></svg>
      </button>
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

    <span class="divider" aria-hidden="true"></span>

    <div class="group" role="group" aria-label="Zoom">
      <button type="button" class="chrome-button" aria-label="Zoom out" onclick={() => viewer?.zoomOut()}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg>
      </button>
      <button type="button" class="chrome-button" aria-label="Zoom in" onclick={() => viewer?.zoomIn()}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      </button>
      <label class="zoom">
        <select aria-label="Zoom level" onchange={onZoomSelect} value="">
          <option value="" disabled hidden>{formatScale(scale)}</option>
          <option value="page-width">Fit width</option>
          <option value="page-fit">Fit page</option>
          <option value="0.5">50%</option>
          <option value="1">100%</option>
          <option value="1.5">150%</option>
          <option value="2">200%</option>
        </select>
        <svg class="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
      </label>
    </div>

    <span class="divider" aria-hidden="true"></span>

    <!-- The open tool is shaded, like the open tab. -->
    <div class="group tools" role="group" aria-label="Tool">
      {#each TOOLS as t (t.value)}
        <button
          type="button"
          class="chrome-button"
          aria-label={t.label}
          aria-pressed={tool === t.value}
          title={t.title}
          onclick={() => ontoolchange?.(t.value)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={t.icon} /></svg>
        </button>
      {/each}
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
    {reserve}
    {tool}
    {onpick}
    {oncontextpick}
    {onmarkerclick}
    {onerror}
  />
</div>

<style>
  .controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    white-space: nowrap;
    font-size: 0.9rem;
  }

  .group {
    display: flex;
    align-items: center;
    gap: 0.125rem;
  }

  .group form {
    display: contents;
  }

  .divider {
    width: 1px;
    height: 1rem;
    background: var(--border);
  }

  /* Same field as the chat's question box: a frame that lights up in the accent colour. */
  .page-input {
    width: 2.5rem;
    height: 1.75rem;
    box-sizing: border-box;
    margin-left: 0.25rem;
    padding: 0 0.25rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: inherit;
    font: inherit;
    text-align: center;
    outline: none;
    transition:
      border-color 0.15s,
      box-shadow 0.15s;
  }
  .page-input:focus {
    border-color: var(--accent);
    box-shadow: var(--ring);
  }

  .count {
    margin-left: 0.25rem;
    color: var(--muted);
  }

  /* Like the chat's model menu: no frame, a hover shade and a small chevron. */
  .zoom {
    position: relative;
    display: flex;
    align-items: center;
    margin-left: 0.25rem;
    border-radius: var(--radius);
    color: var(--muted);
  }
  .zoom:hover,
  .zoom:focus-within {
    background: var(--hover);
    color: inherit;
  }
  .zoom select {
    appearance: none;
    height: 1.75rem;
    padding: 0 1.5rem 0 0.5rem;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    outline: none;
  }
  .zoom select option {
    color: initial;
  }
  .zoom:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .chevron {
    position: absolute;
    right: 0.4rem;
    width: 0.75rem;
    height: 0.75rem;
    pointer-events: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .tools .chrome-button {
    color: var(--muted);
  }
  .tools .chrome-button:hover,
  .tools .chrome-button[aria-pressed='true'] {
    background: var(--hover);
    color: inherit;
  }

  .viewer-area {
    position: absolute;
    inset: 0;
  }
</style>
