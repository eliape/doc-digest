<script lang="ts">
  import { tick } from 'svelte'
  import ChatPanel from './lib/ChatPanel.svelte'
  import DocPane from './lib/DocPane.svelte'
  import type { PageContext, Pick } from './lib/context'
  import { isPdfFile } from './lib/pages'
  import TopicsSidebar from './lib/TopicsSidebar.svelte'
  import { Workspace } from './lib/workspace.svelte'

  const workspace = new Workspace()
  let error = $state('')
  let dragging = $state(false)

  // Whether the sidebar and the chat panel are showing is remembered across reloads.
  const SIDEBAR_KEY = 'doc-digest.sidebarOpen'
  const CHAT_KEY = 'doc-digest.chatOpen'
  let sidebarOpen = $state(readFlag(SIDEBAR_KEY, true))
  let chatOpen = $state(readFlag(CHAT_KEY, false))

  function readFlag(key: string, fallback: boolean) {
    try {
      const value = localStorage.getItem(key)
      return value === null ? fallback : value === 'true'
    } catch {
      return fallback
    }
  }

  function saveFlag(key: string, value: boolean) {
    try {
      localStorage.setItem(key, String(value))
    } catch {
      // Storage can be unavailable (private windows); the default is fine.
    }
  }

  $effect(() => saveFlag(SIDEBAR_KEY, sidebarOpen))
  $effect(() => saveFlag(CHAT_KEY, chatOpen))

  let chatToggle = $state<HTMLButtonElement>()
  let chatPanel = $state<ChatPanel>()

  /** Whether a key press belongs to the focused element: typing, or pressing a button or link. */
  function keyIsForTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return false
    return target.isContentEditable || !!target.closest('input, textarea, select, button, a[href], [role=button], [role=tab]')
  }

  // Tabs stay mounted once opened, so switching back to one keeps its page,
  // zoom and scroll position without re-rendering.
  let mounted = $state<string[]>([])
  const panes: Record<string, DocPane> = {}

  let doc = $derived(workspace.activeDoc)

  $effect(() => {
    if (doc && !mounted.includes(doc.id)) mounted.push(doc.id)
  })

  // Unmount the panes of closed tabs and deleted topics.
  $effect(() => {
    const open = mounted.filter((id) => id in workspace.docs)
    if (open.length !== mounted.length) mounted = open
  })

  // The row the open tab's controls are shown in, and the tabs that scroll next to it.
  let controlsEl = $state<HTMLElement>()
  let tabsEl = $state<HTMLElement>()

  // Keep the open tab in view when there are more tabs than fit.
  $effect(() => {
    if (!doc) return
    tabsEl?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' })
  })

  // A mouse wheel only scrolls up and down, so let it scroll the tabs sideways.
  function scrollTabs(event: WheelEvent) {
    if (event.deltaX !== 0 || event.ctrlKey || !tabsEl) return
    tabsEl.scrollLeft += event.deltaY
  }

  // Read at call time: bind:this fills `panes` after the tab mounts.
  const pane = (): DocPane | undefined => (doc ? panes[doc.id] : undefined)

  // Clicking a spot (or selecting text) attaches it to the topic's chat and
  // opens the chat. Its images render in the background; a question sent
  // meanwhile waits for them.
  // Per topic, so a pick in another topic can't drop this one's images.
  const latestPick: Record<string, number> = {}
  const capturing: Record<string, Promise<unknown>> = {}

  function onPick(docId: string, pick: Pick) {
    const picked = workspace.docs[docId]
    const topic = workspace.topicOf(docId)
    if (!picked || !topic) return
    const n = (latestPick[topic.id] = (latestPick[topic.id] ?? 0) + 1)
    workspace.attachContext(topic.id, { ...pick, docId, docName: picked.name, pageTexts: [] })
    chatOpen = true
    tick().then(() => chatPanel?.focus())
    capturing[topic.id] = (panes[docId]?.capture(pick) ?? Promise.resolve(undefined))
      .then((captured) => {
        // Unless another pick replaced it or it was removed meanwhile.
        if (captured && n === latestPick[topic.id] && topic.context?.docId === docId) {
          workspace.attachContext(topic.id, { ...captured, docId, docName: picked.name })
        }
      })
      .catch(() => {})
  }

  /** The topic's open page as context, for a question asked without clicking anything. */
  async function openPageContext(topicId: string): Promise<PageContext | undefined> {
    const docId = workspace.topics.find((t) => t.id === topicId)?.activeDocId
    const open = docId ? workspace.docs[docId] : undefined
    const captured = docId ? await panes[docId]?.capture() : undefined
    return open && captured ? { ...captured, docId: open.id, docName: open.name } : undefined
  }

  async function send(topicId: string) {
    await capturing[topicId]
    workspace.ask(topicId, () => openPageContext(topicId))
  }

  /** Show where a chat chip or citation points: its tab, page and spot. */
  async function reveal(target: Pick & { docId: string }) {
    if (!workspace.docs[target.docId]) return
    workspace.selectDoc(target.docId)
    await tick()
    panes[target.docId]?.reveal(target)
  }

  /** The spot attached to a tab's topic, when it is in that tab's PDF. */
  function markerFor(docId: string): Pick | undefined {
    const context = workspace.topicOf(docId)?.context
    return context?.docId === docId ? context : undefined
  }

  /** A tab's indexing progress in a few words, or nothing once it is ready. */
  function indexLabel(docId: string): string | undefined {
    const state = workspace.indexing[docId]
    if (!state || state.status === 'ready') return undefined
    if (state.status === 'error') return 'Not indexed'
    if (state.status === 'indexing' && state.pageCount) {
      return `Indexing ${Math.round((100 * state.pagesDone) / state.pageCount)}%`
    }
    return 'Indexing…'
  }

  function indexTitle(docId: string): string {
    const state = workspace.indexing[docId]
    if (state?.status === 'error') {
      return `Could not index this PDF (${state.error ?? 'unknown error'}). You can still ask about the open page.`
    }
    return 'Indexing so the whole topic can be searched. You can already ask about the open page.'
  }

  let fileInput: HTMLInputElement

  async function open(file: File | undefined) {
    if (!file) return
    if (!isPdfFile(file)) {
      error = `${file.name} is not a PDF.`
      return
    }
    error = ''
    const added = workspace.addDoc(file.name, new Uint8Array(await file.arrayBuffer()))
    // Index it in the background, so the whole topic can be searched, opened or not.
    if (!workspace.indexing[added.id]) workspace.index(added.id)
  }

  function onDrop(event: DragEvent) {
    event.preventDefault()
    dragging = false
    open(event.dataTransfer?.files[0])
  }

  function onKeydown(event: KeyboardEvent) {
    const mod = event.ctrlKey || event.metaKey
    if (mod && event.key === 'o') {
      event.preventDefault()
      fileInput.click()
    }
    // Enter opens the chat, ready to type, unless it is meant for whatever has focus.
    if (event.key === 'Enter' && !mod && !event.shiftKey && !event.altKey && !event.isComposing) {
      if (workspace.activeTopic && !keyIsForTarget(event.target)) {
        event.preventDefault()
        chatOpen = true
        chatPanel?.focus()
      }
      return
    }
    if (!doc) return
    // Zoom the PDF rather than the whole page, like browser PDF viewers do.
    if (mod && (event.key === '+' || event.key === '=')) {
      event.preventDefault()
      pane()?.zoomIn()
    } else if (mod && event.key === '-') {
      event.preventDefault()
      pane()?.zoomOut()
    } else if (mod && event.key === '0') {
      event.preventDefault()
      pane()?.fitWidth()
    }
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
  <TopicsSidebar {workspace} bind:open={sidebarOpen} />

  <div class="main">
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

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    {#if workspace.activeTopic}
      <!-- One row: the tabs scroll sideways when there are many, the controls never shrink. -->
      <div class="tabrow">
        <div
          class="tabs"
          role="tablist"
          aria-label={`PDFs in ${workspace.activeTopic.name}`}
          bind:this={tabsEl}
          onwheel={scrollTabs}
        >
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
              {#if indexLabel(id)}
                <span class="index-status" class:failed={workspace.indexing[id]?.status === 'error'} title={indexTitle(id)}
                  >{indexLabel(id)}</span
                >
              {/if}
              <button type="button" class="close" aria-label={`Close ${tab.name}`} onclick={() => workspace.closeDoc(id)}
                >×</button
              >
            </div>
          {/each}
        </div>
        <button
          type="button"
          class="add-tab"
          aria-label={`Add a PDF to ${workspace.activeTopic.name}`}
          onclick={() => fileInput.click()}>+</button
        >
        <div class="controls-slot" bind:this={controlsEl}></div>
        <button
          type="button"
          class="chat-toggle"
          class:pressed={chatOpen}
          bind:this={chatToggle}
          aria-label={chatOpen ? 'Hide chat' : 'Show chat'}
          aria-expanded={chatOpen}
          aria-controls="chat-panel"
          title={chatOpen ? 'Hide chat' : `Chat about ${workspace.activeTopic.name}`}
          onclick={() => (chatOpen = !chatOpen)}>Chat</button
        >
      </div>
    {/if}

    <main class="stage">
      {#each mounted as id (id)}
        {@const d = workspace.docs[id]}
        {#if d}
          <div class="tabpanel" class:active={id === doc?.id} inert={id !== doc?.id} role="tabpanel" aria-label={d.name}>
            <DocPane
              bind:this={panes[id]}
              data={d.data}
              active={id === doc?.id}
              controlsTarget={controlsEl}
              marker={markerFor(id)}
              onpick={(p) => onPick(id, p)}
              onmarkerclick={() => {
                const topic = workspace.topicOf(id)
                if (topic) workspace.clearContext(topic.id)
              }}
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

  <ChatPanel
    bind:this={chatPanel}
    {workspace}
    bind:open={chatOpen}
    onclose={() => chatToggle?.focus()}
    onsend={send}
    onreveal={reveal}
  />
</div>

<style>
  .app {
    display: flex;
    height: 100vh;
  }

  .error {
    margin: 0;
    padding: 0.5rem 1rem;
    background: #ffebe9;
    color: #82071e;
  }

  .main {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }

  .tabrow {
    display: flex;
    align-items: flex-end;
    padding: 0.25rem 0.5rem 0;
    border-bottom: 1px solid var(--border);
    background: var(--sidebar-bg);
  }

  .tabs {
    display: flex;
    align-items: stretch;
    gap: 0.125rem;
    /* Tabs shrink and scroll; the controls beside them keep their size. */
    flex: 0 1 auto;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .controls-slot {
    flex-shrink: 0;
    margin-left: auto;
    align-self: center;
    margin-bottom: 0.25rem;
  }

  .tab {
    flex-shrink: 0;
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

  .index-status {
    flex-shrink: 0;
    font-size: 0.75rem;
    color: var(--muted);
    white-space: nowrap;
  }
  .index-status.failed {
    color: #b35900;
  }

  .add-tab {
    flex-shrink: 0;
    padding: 0.25rem 0.625rem;
    color: var(--muted);
  }

  .chat-toggle {
    flex-shrink: 0;
    align-self: center;
    margin: 0 0 0.25rem 0.25rem;
    padding: 0.125rem 0.625rem;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    background: var(--surface);
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .chat-toggle:hover {
    background: var(--hover);
  }
  .chat-toggle.pressed {
    border-color: var(--accent);
    color: var(--accent);
  }

  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
  }

  /* Inactive tabs stay laid out (so they keep their scroll position) but hidden. */
  .tabpanel {
    position: absolute;
    inset: 0;
    visibility: hidden;
  }
  .tabpanel.active {
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
