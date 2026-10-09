<script lang="ts">
  import { fetchHealth } from './lib/api'
  import { formatScale, isPdfFile, parsePageInput } from './lib/pages'
  import PdfViewer from './lib/PdfViewer.svelte'

  let backend = $state<'checking' | 'ok' | 'down'>('checking')

  $effect(() => {
    fetchHealth()
      .then((h) => (backend = h.status === 'ok' ? 'ok' : 'down'))
      .catch(() => (backend = 'down'))
  })

  let doc = $state.raw<{ name: string; data: Uint8Array }>()
  let error = $state('')
  let dragging = $state(false)

  let viewer = $state<PdfViewer>()
  let page = $state(1)
  let pageCount = $state(0)
  let scale = $state(1)
  let pageInput = $state('1')

  // Keep the page box in sync while scrolling.
  $effect(() => {
    pageInput = String(page)
  })

  let fileInput: HTMLInputElement

  async function open(file: File | undefined) {
    if (!file) return
    if (!isPdfFile(file)) {
      error = `${file.name} is not a PDF.`
      return
    }
    error = ''
    doc = { name: file.name, data: new Uint8Array(await file.arrayBuffer()) }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault()
    dragging = false
    open(event.dataTransfer?.files[0])
  }

  function submitPage(event: SubmitEvent) {
    event.preventDefault()
    const n = parsePageInput(pageInput, pageCount)
    if (n === null) pageInput = String(page)
    else viewer?.goToPage(n)
  }

  function onKeydown(event: KeyboardEvent) {
    if (!doc) return
    const mod = event.ctrlKey || event.metaKey
    // Zoom the PDF rather than the whole page, like browser PDF viewers do.
    if (mod && (event.key === '+' || event.key === '=')) {
      event.preventDefault()
      viewer?.zoomIn()
    } else if (mod && event.key === '-') {
      event.preventDefault()
      viewer?.zoomOut()
    } else if (mod && event.key === '0') {
      event.preventDefault()
      viewer?.setZoom('page-width')
    } else if (mod && event.key === 'o') {
      event.preventDefault()
      fileInput.click()
    }
  }

  function onZoomSelect(event: Event) {
    const select = event.currentTarget as HTMLSelectElement
    const value = select.value
    viewer?.setZoom(value === 'page-width' || value === 'page-fit' ? value : Number(value))
    // Go back to showing the current zoom percentage.
    select.value = ''
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="app"
  role="application"
  ondragover={(e) => {
    e.preventDefault()
    dragging = true
  }}
  ondragleave={(e) => {
    if (e.relatedTarget === null) dragging = false
  }}
  ondrop={onDrop}
>
  <header class="toolbar">
    <h1>doc-digest</h1>
    <button type="button" onclick={() => fileInput.click()}>Open PDF</button>
    <input
      bind:this={fileInput}
      type="file"
      accept="application/pdf,.pdf"
      hidden
      data-testid="file-input"
      onchange={(e) => {
        open(e.currentTarget.files?.[0])
        e.currentTarget.value = ''
      }}
    />

    {#if doc}
      <span class="filename" title={doc.name}>{doc.name}</span>

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
        <button
          type="button"
          aria-label="Next page"
          disabled={page >= pageCount}
          onclick={() => viewer?.nextPage()}>›</button
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
    {/if}

    <span class="status" data-state={backend} title="Backend status">
      Backend:
      {#if backend === 'checking'}checking…{:else if backend === 'ok'}connected{:else}not reachable{/if}
    </span>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <main class="stage">
    {#if doc}
      {#key doc}
        <PdfViewer
          bind:this={viewer}
          data={doc.data}
          bind:page
          bind:pageCount
          bind:scale
          onerror={() => {
            error = `Could not open ${doc?.name}. Is it a valid PDF?`
            doc = undefined
          }}
        />
      {/key}
    {:else}
      <div class="empty">
        <p>Open a PDF to start reading.</p>
        <button type="button" onclick={() => fileInput.click()}>Choose a file</button>
        <p class="hint">or drop one anywhere in this window</p>
      </div>
    {/if}
    {#if dragging}
      <div class="drop-overlay">Drop to open</div>
    {/if}
  </main>
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  .toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.75rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }

  h1 {
    font-size: 1rem;
    margin: 0;
  }

  .filename {
    max-width: 20rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
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

  .status {
    margin-left: auto;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .status[data-state='ok'] {
    color: #1a7f37;
  }
  .status[data-state='down'] {
    color: #cf222e;
  }

  .error {
    margin: 0;
    padding: 0.5rem 1rem;
    background: #ffebe9;
    color: #82071e;
  }

  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 0.5rem;
  }

  .hint {
    color: var(--muted);
    font-size: 0.9rem;
    margin: 0;
  }

  .drop-overlay {
    position: absolute;
    inset: 0.5rem;
    display: grid;
    place-items: center;
    border: 3px dashed var(--accent);
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--surface) 85%, transparent);
    font-size: 1.25rem;
    pointer-events: none;
  }
</style>
