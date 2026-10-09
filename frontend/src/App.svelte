<script lang="ts">
  import { fetchHealth } from './lib/api'
  import { formatScale, isPdfFile, parsePageInput } from './lib/pages'
  import PdfViewer from './lib/PdfViewer.svelte'
  import TopicsSidebar from './lib/TopicsSidebar.svelte'
  import { Workspace } from './lib/workspace.svelte'

  let backend = $state<'checking' | 'ok' | 'down'>('checking')

  $effect(() => {
    fetchHealth()
      .then((h) => (backend = h.status === 'ok' ? 'ok' : 'down'))
      .catch(() => (backend = 'down'))
  })

  const workspace = new Workspace()
  let error = $state('')
  let dragging = $state(false)

  const SIDEBAR_KEY = 'doc-digest.sidebarOpen'
  let sidebarOpen = $state(readSidebarOpen())

  function readSidebarOpen() {
    try {
      return localStorage.getItem(SIDEBAR_KEY) !== 'false'
    } catch {
      return true
    }
  }

  $effect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, String(sidebarOpen))
    } catch {
      // Storage can be unavailable (private windows); the default is fine.
    }
  })

  // Each tab keeps its own page and zoom. Tabs stay mounted once opened, so
  // switching back to one keeps its scroll position without re-rendering.
  type View = { page: number; pageCount: number; scale: number }
  let views = $state<Record<string, View>>({})
  let mounted = $state<string[]>([])
  const viewers: Record<string, PdfViewer> = {}

  let doc = $derived(workspace.activeDoc)
  let view = $derived(doc ? views[doc.id] : undefined)

  $effect(() => {
    if (doc && !mounted.includes(doc.id)) {
      views[doc.id] = { page: 1, pageCount: 0, scale: 1 }
      mounted.push(doc.id)
    }
  })

  // Unmount the viewers of closed tabs and deleted topics.
  $effect(() => {
    const open = mounted.filter((id) => id in workspace.docs)
    if (open.length !== mounted.length) {
      for (const id of mounted) if (!open.includes(id)) delete views[id]
      mounted = open
    }
  })

  // Read at call time: bind:this fills `viewers` after the tab mounts.
  const viewer = (): PdfViewer | undefined => (doc ? viewers[doc.id] : undefined)

  let pageInput = $state('1')

  // Keep the page box in sync while scrolling and switching tabs.
  $effect(() => {
    pageInput = String(view?.page ?? 1)
  })

  let fileInput: HTMLInputElement

  async function open(file: File | undefined) {
    if (!file) return
    if (!isPdfFile(file)) {
      error = `${file.name} is not a PDF.`
      return
    }
    error = ''
    workspace.addDoc(file.name, new Uint8Array(await file.arrayBuffer()))
  }

  function onDrop(event: DragEvent) {
    event.preventDefault()
    dragging = false
    open(event.dataTransfer?.files[0])
  }

  function submitPage(event: SubmitEvent) {
    event.preventDefault()
    if (!view) return
    const n = parsePageInput(pageInput, view.pageCount)
    if (n === null) pageInput = String(view.page)
    else viewer()?.goToPage(n)
  }

  function onKeydown(event: KeyboardEvent) {
    const mod = event.ctrlKey || event.metaKey
    if (mod && event.key === 'o') {
      event.preventDefault()
      fileInput.click()
    }
    if (!doc) return
    // Zoom the PDF rather than the whole page, like browser PDF viewers do.
    if (mod && (event.key === '+' || event.key === '=')) {
      event.preventDefault()
      viewer()?.zoomIn()
    } else if (mod && event.key === '-') {
      event.preventDefault()
      viewer()?.zoomOut()
    } else if (mod && event.key === '0') {
      event.preventDefault()
      viewer()?.setZoom('page-width')
    }
  }

  function onZoomSelect(event: Event) {
    const select = event.currentTarget as HTMLSelectElement
    const value = select.value
    viewer()?.setZoom(value === 'page-width' || value === 'page-fit' ? value : Number(value))
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
    <button
      type="button"
      class="sidebar-toggle"
      aria-label={sidebarOpen ? 'Hide topics' : 'Show topics'}
      aria-expanded={sidebarOpen}
      aria-controls={sidebarOpen ? 'topics-sidebar' : undefined}
      onclick={() => (sidebarOpen = !sidebarOpen)}>☰</button
    >
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

    {#if doc && view}
      <nav class="group" aria-label="Pages">
        <button
          type="button"
          aria-label="Previous page"
          disabled={view.page <= 1}
          onclick={() => viewer()?.previousPage()}>‹</button
        >
        <form onsubmit={submitPage}>
          <input
            class="page-input"
            aria-label="Page number"
            inputmode="numeric"
            bind:value={pageInput}
            onblur={() => (pageInput = String(view?.page ?? 1))}
          />
        </form>
        <span>of {view.pageCount}</span>
        <button
          type="button"
          aria-label="Next page"
          disabled={view.page >= view.pageCount}
          onclick={() => viewer()?.nextPage()}>›</button
        >
      </nav>

      <div class="group" role="group" aria-label="Zoom">
        <button type="button" aria-label="Zoom out" onclick={() => viewer()?.zoomOut()}>−</button>
        <select aria-label="Zoom level" onchange={onZoomSelect} value="">
          <option value="" disabled hidden>{formatScale(view.scale)}</option>
          <option value="page-width">Fit width</option>
          <option value="page-fit">Fit page</option>
          <option value="0.5">50%</option>
          <option value="1">100%</option>
          <option value="1.5">150%</option>
          <option value="2">200%</option>
        </select>
        <button type="button" aria-label="Zoom in" onclick={() => viewer()?.zoomIn()}>+</button>
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

  <div class="body">
    {#if sidebarOpen}
      <TopicsSidebar {workspace} />
    {/if}

    <div class="main">
      {#if workspace.activeTopic && workspace.activeTopic.docIds.length > 0}
        <div class="tabs" role="tablist" aria-label={`PDFs in ${workspace.activeTopic.name}`}>
          {#each workspace.activeTopic.docIds as id (id)}
            {@const tab = workspace.docs[id]}
            <div class="tab" class:active={id === doc?.id}>
              <button
                type="button"
                role="tab"
                aria-selected={id === doc?.id}
                title={tab.name}
                onclick={() => workspace.selectDoc(id)}>{tab.name}</button
              >
              <button type="button" class="close" aria-label={`Close ${tab.name}`} onclick={() => workspace.closeDoc(id)}
                >×</button
              >
            </div>
          {/each}
          <button
            type="button"
            class="add-tab"
            aria-label={`Add a PDF to ${workspace.activeTopic.name}`}
            onclick={() => fileInput.click()}>+</button
          >
        </div>
      {/if}

      <main class="stage">
        {#each mounted as id (id)}
          {@const d = workspace.docs[id]}
          {#if d && views[id]}
            <div class="pane" class:active={id === doc?.id} role="tabpanel" aria-label={d.name}>
              <PdfViewer
                bind:this={viewers[id]}
                data={d.data}
                bind:page={views[id].page}
                bind:pageCount={views[id].pageCount}
                bind:scale={views[id].scale}
                onerror={() => {
                  error = `Could not open ${d.name}. Is it a valid PDF?`
                  workspace.closeDoc(id)
                }}
              />
            </div>
          {/if}
        {/each}

        {#if !workspace.activeTopic}
          <div class="empty">
            <p>Open a PDF to start reading.</p>
            <button type="button" onclick={() => fileInput.click()}>Choose a file</button>
            <p class="hint">or drop one anywhere in this window</p>
          </div>
        {:else if !doc}
          <div class="empty">
            <p>Add a PDF to {workspace.activeTopic.name}.</p>
            <button type="button" onclick={() => fileInput.click()}>Choose a file</button>
            <p class="hint">Each PDF in a topic opens as a tab, so you can switch between them.</p>
          </div>
        {/if}
        {#if dragging}
          <div class="drop-overlay">Drop to open</div>
        {/if}
      </main>
    </div>
  </div>
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

  .sidebar-toggle {
    border: none;
    background: none;
    color: inherit;
    font-size: 1.1rem;
    cursor: pointer;
    padding: 0.125rem 0.375rem;
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

  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .main {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }

  .tabs {
    display: flex;
    align-items: stretch;
    gap: 0.125rem;
    padding: 0.25rem 0.5rem 0;
    border-bottom: 1px solid var(--border);
    background: var(--sidebar-bg);
    overflow-x: auto;
  }

  .tab {
    display: flex;
    align-items: center;
    max-width: 14rem;
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: 0.375rem 0.375rem 0 0;
  }
  .tab.active {
    background: var(--surface);
    border-color: var(--border);
    margin-bottom: -1px;
  }

  .tab button,
  .add-tab {
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .tab [role='tab'] {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0.25rem 0.25rem 0.25rem 0.625rem;
    color: var(--muted);
  }
  .tab.active [role='tab'] {
    color: inherit;
  }

  .tab .close {
    color: var(--muted);
    padding: 0.25rem 0.5rem;
  }

  .add-tab {
    padding: 0.25rem 0.625rem;
    color: var(--muted);
  }

  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
  }

  /* Inactive tabs stay laid out (so they keep their scroll position) but hidden. */
  .pane {
    position: absolute;
    inset: 0;
    visibility: hidden;
  }
  .pane.active {
    visibility: visible;
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
