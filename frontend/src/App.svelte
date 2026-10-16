<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { fetchIndexSections, fetchPdf, fetchSavedWorkspace, saveWorkspace } from './lib/api'
  import { chatReserve } from './lib/chatWidth'
  import ChatPanel from './lib/ChatPanel.svelte'
  import ContextMenu, { type MenuItem } from './lib/ContextMenu.svelte'
  import DocPane from './lib/DocPane.svelte'
  import type { Heading, PageContext, Pick } from './lib/context'
  import { ASK_ICON, QUIZ_ICON, SOCRATIC_ICON } from './lib/modes'
  import { currentEntry, fromIndex, type ReadingSpot } from './lib/outline'
  import OutlinePanel from './lib/OutlinePanel.svelte'
  import { isPdfFile } from './lib/pages'
  import { savedTool, saveTool, type Tool } from './lib/tools'
  import SettingsDialog from './lib/SettingsDialog.svelte'
  import { savedZoomFollowsChat } from './lib/chatZoom'
  import TopicProfileDialog from './lib/TopicProfileDialog.svelte'
  import TopicsSidebar from './lib/TopicsSidebar.svelte'
  import { type Mode, Workspace } from './lib/workspace.svelte'

  const workspace = new Workspace()
  let error = $state('')
  let dragging = $state(false)

  // The topics, tabs and chats are saved on disk through the backend and come back on load.
  // Saving only starts once the saved ones are back, so a failed load can't overwrite them.
  let restored = $state(false)

  onMount(async () => {
    try {
      const docIds = await workspace.restore(await fetchSavedWorkspace(), fetchPdf)
      for (const id of docIds) workspace.index(id)
      restored = true
    } catch {
      error = 'Could not load your saved topics. Is the backend running? Reload to try again.'
    }
  })

  let unsaved: string | undefined
  let saveTimer: ReturnType<typeof setTimeout> | undefined

  function saveNow(keepalive = false) {
    clearTimeout(saveTimer)
    if (unsaved === undefined) return
    const json = unsaved
    unsaved = undefined
    saveWorkspace(json, fetch, keepalive).catch(() => {
      unsaved ??= json
      error = 'Could not save your topics. Is the backend running?'
    })
  }

  // Save shortly after each change, and right away when the page is closed.
  $effect(() => {
    const json = JSON.stringify(workspace.snapshot())
    if (!restored) return
    unsaved = json
    clearTimeout(saveTimer)
    saveTimer = setTimeout(saveNow, 500)
  })

  // Every load starts with the topics open and the chat closed.
  let sidebarOpen = $state(true)
  let settingsOpen = $state(false)
  // Whether the PDF's zoom follows the chat opening and closing. Set in Settings.
  let zoomFollowsChat = $state(savedZoomFollowsChat())
  // The topic whose Conventions and purpose are being edited, if any.
  let profileTopicId = $state<string>()
  const profileTopic = $derived(workspace.topics.find((t) => t.id === profileTopicId))
  // Whether each topic's chat is showing, so a topic opens the way it was left. Not saved:
  // the chat starts hidden on every load.
  let chatOpenBy = $state<Record<string, boolean>>({})
  const chatOpen = $derived(!!workspace.activeTopicId && !!chatOpenBy[workspace.activeTopicId])
  function setChatOpen(open: boolean, topicId = workspace.activeTopicId) {
    if (topicId) chatOpenBy[topicId] = open
  }

  /** A discussion picked (or started) in the sidebar: show it, ready to type. */
  function openChatFromSidebar() {
    setChatOpen(true)
    tick().then(() => chatPanel?.focus())
  }

  // What a left click on the PDF does. Each topic keeps its own, the same in all its tabs,
  // remembered in this browser; `picked` holds the picks made since the page loaded.
  let picked = $state<Record<string, Tool>>({})
  let tool = $derived.by<Tool>(() => {
    const id = workspace.activeTopic?.id
    return id ? (picked[id] ?? savedTool(id)) : 'select'
  })

  function setTool(value: Tool) {
    const id = workspace.activeTopic?.id
    if (!id) return
    picked[id] = value
    saveTool(
      id,
      value,
      workspace.topics.map((t) => t.id),
    )
  }

  let chatToggle = $state<HTMLButtonElement>()
  let chatPanel = $state<ChatPanel>()

  /** Whether a key press is typing into a text field, or meant for an open dialog or menu. */
  function keyIsForTarget(target: EventTarget | null) {
    if (document.querySelector('[aria-modal=true], [role=menu]')) return true
    if (!(target instanceof HTMLElement)) return false
    return target.isContentEditable || !!target.closest('input, textarea, select, [contenteditable]')
  }

  // Tabs stay mounted once opened, so switching back to one keeps its page,
  // zoom and scroll position without re-rendering.
  let mounted = $state<string[]>([])
  const panes: Record<string, DocPane> = {}

  let doc = $derived(workspace.activeDoc)

  // The browser tab names the open topic.
  $effect(() => {
    const name = workspace.activeTopic?.name.trim()
    document.title = name ? `${name} · Leqtern` : 'Leqtern'
  })

  $effect(() => {
    if (doc && !mounted.includes(doc.id)) mounted.push(doc.id)
  })

  // Unmount the panes of closed tabs and deleted topics. A reopened tab starts fresh at its last page.
  $effect(() => {
    const open = mounted.filter((id) => workspace.isTabOpen(id))
    if (open.length !== mounted.length) mounted = open
  })

  // The row the open tab's controls are shown in, and the tabs that scroll next to it.
  let controlsEl = $state<HTMLElement>()
  let tabsEl = $state<HTMLElement>()

  // Keep the open tab in view when there are more tabs than fit, also when the row
  // narrows (the chat opening, the window shrinking).
  $effect(() => {
    if (!doc || !tabsEl) return
    const el = tabsEl
    const reveal = () =>
      el.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' })
    reveal()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(reveal)
    observer.observe(el)
    return () => observer.disconnect()
  })

  // A mouse wheel only scrolls up and down, so let it scroll the tabs sideways.
  // Reordering tabs by dragging them. `dropAt` is the place in the row the tab would land, shown
  // as a line (`dropX`, in the scrolled row's own pixels) between two tabs.
  const TAB_TYPE = 'application/x-leqtern-tab'
  let dragTab = $state<string>()
  let dropAt = $state<number>()
  let dropX = $state(0)
  // While a tab is dragged, the PDF, the chat and the sidebar ignore the pointer, so the browser
  // has nothing to auto-scroll when the drag nears the top or bottom of the window.
  let tabDragging = $state(false)

  // A small card to carry along, in place of the browser's picture of the tab's text. It is made
  // outside the page's styles, so it is styled here, with the page's colours.
  function dragCard(name: string): HTMLElement {
    const card = document.createElement('div')
    const icon = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none;color:var(--accent)"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5"/></svg>'
    card.innerHTML = `${icon}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>`
    card.lastElementChild!.textContent = name
    card.style.cssText =
      'position:fixed;top:-100px;left:-100px;display:flex;align-items:center;gap:0.5rem;max-width:14rem;' +
      'padding:0.4rem 0.7rem;border:1px solid var(--border);border-radius:0.5rem;background:var(--surface);' +
      'color:inherit;font:0.85rem system-ui,sans-serif;box-shadow:0 6px 18px rgb(0 0 0 / 0.22);pointer-events:none'
    return card
  }

  function startTabDrag(event: DragEvent, id: string) {
    dragTab = id
    const data = event.dataTransfer
    if (!data) return
    data.setData(TAB_TYPE, id)
    data.effectAllowed = 'move'
    const card = dragCard(workspace.docs[id]?.name ?? '')
    document.body.appendChild(card)
    data.setDragImage(card, 16, 16)
    // The browser has taken its picture by the next turn.
    setTimeout(() => {
      card.remove()
      // Not at once: changing the page while the drag starts can cancel it.
      if (dragTab === id) tabDragging = true
    })
  }

  /** Where in the row a drag at this x lands, and the x of the line that shows it. */
  function dragTabOver(event: DragEvent) {
    if (dragTab === undefined || !tabsEl) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    const tabs = [...tabsEl.querySelectorAll<HTMLElement>('.tab')]
    let at = tabs.findIndex((t) => {
      const box = t.getBoundingClientRect()
      return event.clientX < box.left + box.width / 2
    })
    if (at === -1) at = tabs.length
    dropAt = at
    const next = tabs[at]
    const before = tabs[at - 1]
    dropX = next && before ? (before.offsetLeft + before.offsetWidth + next.offsetLeft) / 2 : next ? next.offsetLeft - 1 : before ? before.offsetLeft + before.offsetWidth + 1 : 0
  }

  function dropTab(event: DragEvent) {
    if (dragTab === undefined) return
    event.preventDefault()
    const from = (workspace.activeTopic?.openDocIds ?? []).indexOf(dragTab)
    if (dropAt !== undefined && from !== -1) workspace.moveTab(dragTab, dropAt > from ? dropAt - 1 : dropAt)
    endTabDrag()
  }

  function endTabDrag() {
    dragTab = undefined
    tabDragging = false
    dropAt = undefined
  }

  // The line shows only where dropping would change the order.
  const dropLine = $derived.by(() => {
    const from = dragTab === undefined ? -1 : (workspace.activeTopic?.openDocIds.indexOf(dragTab) ?? -1)
    return dropAt !== undefined && from !== -1 && dropAt !== from && dropAt !== from + 1
  })

  function scrollTabs(event: WheelEvent) {
    if (event.deltaX !== 0 || event.ctrlKey || !tabsEl) return
    tabsEl.scrollLeft += event.deltaY
  }

  // Read at call time: bind:this fills `panes` after the tab mounts.
  const pane = (): DocPane | undefined => (doc ? panes[doc.id] : undefined)

  // Asking about a spot (or selected text), by a click with the Click to ask tool or
  // from the right-click menu, attaches it to the topic's chat in the mode it is for
  // and opens the chat. Its images render in the background; a question sent
  // meanwhile waits for them.
  // Per topic, so a pick in another topic can't drop this one's images.
  const latestPick: Record<string, number> = {}
  const capturing: Record<string, Promise<unknown>> = {}

  function onPick(docId: string, pick: Pick, mode: Mode = 'normal') {
    const picked = workspace.docs[docId]
    const topic = workspace.topicOf(docId)
    if (!picked || !topic) return
    const n = (latestPick[topic.id] = (latestPick[topic.id] ?? 0) + 1)
    workspace.attachContext(topic.id, { ...pick, docId, docName: picked.name, pageTexts: [] }, mode)
    setChatOpen(true, topic.id)
    tick().then(() => chatPanel?.focus())
    capturing[topic.id] = (panes[docId]?.capture(pick) ?? Promise.resolve(undefined))
      .then((captured) => {
        // Unless another pick replaced it or it was removed meanwhile.
        if (captured && n === latestPick[topic.id] && topic.context?.docId === docId) {
          workspace.fillContext(topic.id, { ...captured, docId, docName: picked.name })
        }
      })
      .catch(() => {})
  }

  // Right-clicking a spot (or the selection) opens a menu of ways to study it, with either tool.
  type MenuTarget = { docId: string; pick: Pick; x: number; y: number }
  let menu = $state.raw<MenuTarget>()

  /** Put text on the clipboard, as the browser's own Copy would. */
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // No clipboard API (a page served over plain http): copy the selection the old way.
      document.execCommand('copy')
    }
  }

  /**
   * What the menu offers for a right-clicked spot or selection. Each of Ask, Socratic and
   * Quiz me attaches it to the chat, as a click with the Click to ask tool does, in the mode
   * it is for: Ask waits for a question, Socratic and Quiz me for what to focus on, if anything.
   */
  function menuItems({ docId, pick }: MenuTarget): MenuItem[] {
    const items: MenuItem[] = [
      {
        label: 'Ask',
        icon: ASK_ICON,
        hint: 'Attach it to the chat to ask about it',
        onselect: () => onPick(docId, pick),
      },
      {
        label: 'Socratic',
        icon: SOCRATIC_ICON,
        hint: 'Work it out by answering questions',
        onselect: () => onPick(docId, pick, 'socratic'),
      },
      {
        label: 'Quiz me',
        icon: QUIZ_ICON,
        hint: 'Test yourself with a few questions',
        onselect: () => onPick(docId, pick, 'quiz'),
      },
    ]
    const text = pick.selection
    if (text) {
      items.push({
        label: 'Copy',
        divider: true,
        // Two sheets, one on top of the other.
        icon: 'M10 9h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM15 9V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h4',
        onselect: () => copy(text),
      })
    }
    return items
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

  /** Open each PDF as a tab in the active topic. Several at once all go into the same topic. */
  async function open(files: FileList | File[] | null | undefined) {
    const list = Array.from(files ?? [])
    if (!list.length) return
    const pdfs = list.filter(isPdfFile)
    const skipped = list.filter((f) => !isPdfFile(f)).map((f) => f.name)
    error = skipped.length ? `${skipped.join(', ')} ${skipped.length === 1 ? 'is' : 'are'} not a PDF.` : ''
    if (!pdfs.length) return
    // Get the topics out of the way of the new PDFs, once.
    sidebarOpen = false
    // Read them all first, so a slow file can't reorder the tabs.
    const loaded = await Promise.all(pdfs.map(async (f) => [f.name, new Uint8Array(await f.arrayBuffer())] as const))
    const added = loaded.map(([name, data]) => workspace.addDoc(name, data))
    // Land on the first one, as the reader picked them.
    workspace.selectDoc(added[0].id)
    // Index them in the background, so the whole topic can be searched, opened or not.
    for (const doc of added) if (!workspace.indexing[doc.id]) workspace.index(doc.id)
  }

  function onDrop(event: DragEvent) {
    event.preventDefault()
    dragging = false
    open(event.dataTransfer?.files)
  }

  // The open tab's chapters and sections, shown over the PDF by the button left of the tabs.
  // The PDF's own bookmarks when it has them, else the sections the index has found so far.
  let outlineOpen = $state(false)
  let outline = $state<{ docId: string; entries: Heading[] }>()

  $effect(() => {
    if (!outlineOpen || !doc) return
    const id = doc.id
    const serverId = workspace.indexing[id]?.serverId
    // Look again as indexing gets further, so a new PDF's outline fills in.
    void workspace.indexing[id]?.pagesDone
    let stale = false
    ;(async () => {
      const bookmarks = (await panes[id]?.outline()) ?? []
      const entries = bookmarks.length
        ? bookmarks.map((b) => ({ ...b, level: Math.min(b.level, 3) }))
        : serverId
          ? fromIndex(await fetchIndexSections(serverId).catch(() => []))
          : []
      if (!stale) outline = { docId: id, entries }
    })()
    return () => {
      stale = true
    }
  })

  // Where each tab is being read, and where the headings on that page are, so the outline
  // can mark the section being read, switching as a heading scrolls past.
  let reading = $state<Record<string, ReadingSpot>>({})
  let pageSpots = $state.raw<{ entries: Heading[]; page: number; spots: (number | undefined)[] }>()

  $effect(() => {
    if (!outlineOpen || !doc || outline?.docId !== doc.id) return
    const id = doc.id
    const entries = outline.entries
    const page = reading[id]?.page ?? workspace.pages[id] ?? 1
    if (pageSpots?.entries === entries && pageSpots.page === page) return
    let stale = false
    Promise.all(entries.map((e) => (e.page === page ? (panes[id]?.spotOf(e) ?? undefined) : undefined))).then((spots) => {
      if (!stale) pageSpots = { entries, page, spots }
    })
    return () => {
      stale = true
    }
  })

  let currentSection = $derived.by(() => {
    if (!doc || outline?.docId !== doc.id) return -1
    const at = reading[doc.id] ?? { page: workspace.pages[doc.id] ?? 1, y: 0 }
    const spots = pageSpots?.entries === outline.entries && pageSpots.page === at.page ? pageSpots.spots : []
    return currentEntry(outline.entries, at, spots)
  })

  function outlineEmpty(docId: string): string {
    const state = workspace.indexing[docId]
    if (state?.status === 'error') return 'This PDF has no outline of its own, and it could not be indexed to make one.'
    if (state && state.status !== 'ready') return 'This PDF has no outline of its own. One will appear here as it is indexed.'
    return 'No chapters or sections were found in this PDF.'
  }

  function goToSection(heading: Heading) {
    pane()?.goToHeading(heading)
    outlineOpen = false
  }

  function onKeydown(event: KeyboardEvent) {
    const mod = event.ctrlKey || event.metaKey
    if (event.key === 'Escape' && outlineOpen && !(event.target as Element | null)?.closest?.('#chat-panel')) {
      outlineOpen = false
      return
    }
    if (mod && event.key === 'o') {
      event.preventDefault()
      fileInput.click()
    }
    // C opens the chat, ready to type, or closes it, unless the key is typing or meant for a menu.
    // (Enter and Escape stay with focused buttons and the browser's full screen.)
    if (event.key.toLowerCase() === 'c' && !mod && !event.shiftKey && !event.altKey && !event.isComposing && !event.repeat) {
      if (workspace.activeTopic && !keyIsForTarget(event.target)) {
        event.preventDefault()
        // Closing by key leaves focus where it was, or on the page if it was in the chat:
        // focusing the toggle from a key press would show its outline and tooltip.
        if (chatOpen) chatPanel?.close(false)
        else {
          setChatOpen(true)
          tick().then(() => chatPanel?.focus())
        }
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

<svelte:window onkeydown={onKeydown} onpagehide={() => saveNow(true)} />

<div
  class="app"
  class:tab-dragging={tabDragging}
  role="application"
  ondragover={(e) => {
    // Only files dropped from outside show the drop overlay, not a tab being reordered.
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    dragging = true
  }}
  ondragleave={(e) => {
    if (e.relatedTarget === null) dragging = false
  }}
  ondrop={onDrop}
  onpointerdown={(e) => {
    // Pressing anywhere but the sidebar (the PDF, the tabs, the chat) folds the topics away.
    // A pointer shortcut: the menu button does the same by keyboard.
    const target = e.target as Element
    if (!target.closest('#topics-sidebar, .settings-dialog, .topic-profile-dialog')) sidebarOpen = false
    // The outline closes too, unless the press is in it or on its button.
    if (!target.closest('#topics-sidebar, #doc-outline, .outline-toggle')) outlineOpen = false
  }}
>
  <TopicsSidebar
    {workspace}
    bind:open={sidebarOpen}
    {chatOpen}
    onopenchat={openChatFromSidebar}
    onopensettings={() => (settingsOpen = true)}
    onupload={() => fileInput.click()}
    onopenprofile={(id) => (profileTopicId = id)}
  />
  {#if settingsOpen}<SettingsDialog {workspace} bind:zoomFollowsChat onclose={() => (settingsOpen = false)} />{/if}
  {#if profileTopic}<TopicProfileDialog topic={profileTopic} onclose={() => (profileTopicId = undefined)} />{/if}

  <div class="main">
    <input
      bind:this={fileInput}
      type="file"
      accept="application/pdf,.pdf"
      multiple
      hidden
      data-testid="file-input"
      onchange={(e) => {
        open(e.currentTarget.files)
        e.currentTarget.value = ''
      }}
    />

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    {#if workspace.activeTopic}
      <!-- One row: the tabs scroll sideways when there are many, the controls never shrink. -->
      <div class="tabrow" class:chat-closed={!chatOpen}>
        <button
          type="button"
          class="icon-button outline-toggle"
          class:pressed={outlineOpen}
          disabled={!doc}
          aria-label="Outline"
          aria-expanded={outlineOpen}
          aria-controls="doc-outline"
          title="Outline"
          onclick={() => (outlineOpen = !outlineOpen)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M8 12h12M8 18h12" /></svg>
        </button>
        <!-- Not focusable itself: its tabs are, and the drag handlers only take drops. -->
        <!-- svelte-ignore a11y_interactive_supports_focus -->
        <div
          class="tabs"
          role="tablist"
          aria-label={`PDFs in ${workspace.activeTopic.name}`}
          bind:this={tabsEl}
          onwheel={scrollTabs}
          ondragover={dragTabOver}
          ondrop={dropTab}
        >
          {#each workspace.activeTopic.openDocIds as id (id)}
            {@const tab = workspace.docs[id]}
            <div
              class="tab"
              class:active={id === doc?.id}
              class:dragged={id === dragTab}
              role="presentation"
              draggable="true"
              ondragstart={(e) => startTabDrag(e, id)}
              ondragend={endTabDrag}
            >
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
              <button type="button" class="close" aria-label={`Close ${tab.name}`} onclick={() => workspace.closeDoc(id)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
          {/each}
          {#if dropLine}<div class="drop-line" style:left={`${dropX}px`} aria-hidden="true"></div>{/if}
        </div>
        <button
          type="button"
          class="chrome-button add-tab"
          aria-label={`Add a PDF to ${workspace.activeTopic.name}`}
          title="Add a PDF"
          onclick={() => fileInput.click()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
        <div class="controls-slot" bind:this={controlsEl}></div>
        <!-- Fixed in the window's top right corner. The chat panel opens over that corner and
             shows its close button in the same spot, so this fades out while the chat is open. -->
        <button
          type="button"
          class="icon-button chat-toggle"
          class:hidden={chatOpen}
          inert={chatOpen}
          bind:this={chatToggle}
          aria-label="Show chat"
          aria-keyshortcuts="C"
          aria-expanded={chatOpen}
          aria-controls="chat-panel"
          onclick={() => setChatOpen(!chatOpen)}
        >
          <span class="tip" aria-hidden="true">Chat <kbd>C</kbd></span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"
            />
          </svg>
        </button>
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
              startPage={workspace.pages[id]}
              onpagechange={(page) => (workspace.pages[id] = page)}
              onreadingspot={(spot) => (reading[id] = spot)}
              active={id === doc?.id}
              controlsTarget={controlsEl}
              marker={markerFor(id)}
              reserve={chatOpen || zoomFollowsChat ? 0 : chatReserve()}
              {chatOpen}
              followChat={zoomFollowsChat}
              {tool}
              ontoolchange={setTool}
              onpick={(p) => onPick(id, p)}
              oncontextpick={(pick, at) => (menu = { docId: id, pick, ...at })}
              onmarkerclick={() => {
                const topic = workspace.topicOf(id)
                if (topic) workspace.clearContext(topic.id)
              }}
              onerror={() => {
                error = `Could not open ${d.name}. Is it a valid PDF?`
                workspace.removeDoc(id)
              }}
            />
          </div>
        {/if}
      {/each}

      {#if outlineOpen && doc}
        <OutlinePanel
          entries={outline?.docId === doc.id ? outline.entries : undefined}
          empty={outlineEmpty(doc.id)}
          current={currentSection}
          ongo={goToSection}
          onclose={() => (outlineOpen = false)}
        />
      {/if}

      {#if !workspace.activeTopic}
        <div class="empty">
          <p>Open a PDF to start reading.</p>
          <button type="button" onclick={() => fileInput.click()}>Choose a file</button>
          <p class="hint">or drop PDFs anywhere in this window</p>
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

  <!-- The toggle is inert while the chat is open, so focus can only go back once it is not. -->
  <ChatPanel
    bind:this={chatPanel}
    {workspace}
    bind:open={() => chatOpen, setChatOpen}
    onclose={() => tick().then(() => chatToggle?.focus())}
    onsend={send}
    onreveal={reveal}
  />

  {#if menu}
    <ContextMenu x={menu.x} y={menu.y} label="Study this" items={menuItems(menu)} onclose={() => (menu = undefined)} />
  {/if}
</div>

<style>
  .app {
    position: relative;
    display: flex;
    height: 100vh;
  }
  .app.tab-dragging :is(.stage, :global(#chat-panel), :global(#topics-sidebar)) {
    pointer-events: none;
  }

  .error {
    margin: 0;
    padding: 0.5rem 1rem;
    background: #ffebe9;
    color: #82071e;
  }

  /* The sidebar floats over this, so it only makes room for its collapsed strip. */
  .main {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    margin-left: var(--sidebar-strip);
  }

  /* The chrome around the PDF shares the sidebar's and the chat's background, shapes and hover shade. */
  .tabrow {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem;
    border-bottom: 1px solid var(--border);
    background: var(--sidebar-bg);
    transition: padding-right 0.2s ease;
  }
  /* Room for the chat icon in the corner. With the chat open, the panel takes that corner. */
  .tabrow.chat-closed {
    padding-right: calc(0.5rem + 1.75rem + 0.25rem);
  }
  @media (prefers-reduced-motion: reduce) {
    .tabrow {
      transition: none;
    }
  }

  .tabs {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    /* Tabs shrink and scroll; the controls beside them keep their size. */
    flex: 0 1 auto;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
    position: relative;
  }

  .controls-slot {
    flex-shrink: 0;
    margin-left: auto;
  }

  /* A tab is a row like the sidebar's topics: no frame, a shade on hover and the open one. */
  .tab {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    max-width: 14rem;
    height: 1.75rem;
    border-radius: var(--radius);
    color: var(--muted);
    font-size: 0.9rem;
  }
  .tab.dragged {
    opacity: 0.45;
  }
  /* Where the dragged tab will land: a line between two tabs. */
  .drop-line {
    position: absolute;
    top: 0.125rem;
    bottom: 0.125rem;
    width: 2px;
    margin-left: -1px;
    border-radius: 1px;
    background: var(--accent);
    pointer-events: none;
  }
  .tab:hover,
  .tab.active {
    background: var(--hover);
  }
  .tab.active {
    color: inherit;
  }

  .tab [role='tab'] {
    overflow: hidden;
    height: 100%;
    padding: 0 0.25rem 0 0.625rem;
    border: none;
    border-radius: var(--radius);
    background: none;
    color: inherit;
    font: inherit;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }
  .tab [role='tab']:focus-visible,
  .tab .close:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .tab .close {
    flex-shrink: 0;
    display: grid;
    place-items: center;
    width: 1.25rem;
    height: 1.25rem;
    margin-right: 0.25rem;
    padding: 0;
    border: none;
    border-radius: var(--radius);
    background: none;
    color: inherit;
    cursor: pointer;
    opacity: 0.6;
  }
  .tab .close:hover {
    background: color-mix(in srgb, currentColor 14%, transparent);
    opacity: 1;
  }
  .tab .close svg {
    width: 0.75rem;
    height: 0.75rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.2;
    stroke-linecap: round;
  }

  .index-status {
    flex-shrink: 0;
    margin-right: 0.125rem;
    font-size: 0.7rem;
    color: var(--muted);
    white-space: nowrap;
  }
  .index-status.failed {
    color: #b35900;
  }

  .add-tab {
    flex-shrink: 0;
    color: var(--muted);
  }
  .add-tab:hover {
    color: inherit;
  }

  .outline-toggle {
    color: var(--muted);
  }
  .outline-toggle:hover,
  .outline-toggle.pressed {
    color: inherit;
  }
  .outline-toggle.pressed {
    background: var(--hover);
  }
  .outline-toggle:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .chat-toggle {
    position: fixed;
    top: 0.25rem;
    right: 0.5rem;
    z-index: 5;
    transition: opacity 0.15s;
  }
  .chat-toggle.hidden {
    opacity: 0;
    pointer-events: none;
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
