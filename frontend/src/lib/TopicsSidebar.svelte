<script lang="ts">
  import { tick } from 'svelte'
  import { slide } from 'svelte/transition'
  import { FLASHCARD_ICON } from './flashcards'
  import { marquee } from './marquee'
  import { chatOf, chatTitle, discussions, type Workspace } from './workspace.svelte'

  type Props = {
    workspace: Workspace
    /** Whether the sidebar is expanded. When closed, a narrow strip with the two buttons remains. */
    open?: boolean
    /** Called when a discussion is picked, to show it in the chat. */
    onopenchat?: () => void
    /** Whether the chat is showing. Only then is its discussion marked as the open one. */
    chatOpen?: boolean
    /** Called by the Settings button at the bottom. */
    onopensettings?: () => void
    /** Called by the Upload source row: ask for PDFs to add to the open topic. */
    onupload?: () => void
    /** Called by Conventions and purpose in a topic's menu. */
    onopenprofile?: (topicId: string) => void
    /** Called by Flashcards in a topic's menu: open its deck. */
    onopenflashcards?: (topicId: string) => void
  }

  let {
    workspace,
    open = $bindable(true),
    onopenchat,
    chatOpen = false,
    onopensettings,
    onupload,
    onopenprofile,
    onopenflashcards,
  }: Props = $props()

  // A topic's discussions slide open and shut, quickly, unless motion is reduced.
  const listSlide = () => ({
    duration: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 150,
  })

  // On collapse the contents stay until the sidebar has narrowed, so they slide away with it.
  const SLIDE_MS = 200
  let lingering = $state(false)
  let wasOpen = open
  $effect(() => {
    if (open) {
      wasOpen = true
      lingering = false
      return
    }
    if (!wasOpen) return
    wasOpen = false
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    lingering = true
    const timer = setTimeout(() => (lingering = false), reduced ? 0 : SLIDE_MS)
    return () => clearTimeout(timer)
  })
  const expanded = $derived(open || lingering)

  // The topic or discussion whose actions menu (the three dots) is open.
  let menuId = $state<string>()

  function closeMenu(event: Event) {
    if (menuId && !(event.target as Element | null)?.closest?.('.topic-menu, .dots')) menuId = undefined
  }

  let renamingId = $state<string>()
  let draft = $state('')
  let renameInput = $state<HTMLInputElement>()

  async function startRename(id: string, name: string) {
    renamingId = id
    draft = name
    await tick()
    renameInput?.select()
  }

  // The topic whose first name is being typed. Naming it is the last step of creating it.
  let creatingId: string | undefined
  // What was open before it, to go back to if the new topic is cancelled.
  let topicBeforeCreating: string | undefined

  function finishRename(save: boolean) {
    const id = renamingId
    // Renaming ends first, so the box going away can't finish it a second time.
    renamingId = undefined
    const creating = id !== undefined && id === creatingId
    creatingId = undefined
    if (!id) return
    if (creating && !save) {
      // Cancelling a new topic takes the placeholder away again and leaves the sidebar as it was.
      workspace.deleteTopic(id)
      if (topicBeforeCreating) workspace.selectTopic(topicBeforeCreating)
      return
    }
    if (save) workspace.renameTopic(id, draft)
    // A new topic is ready once it is named: get out of the way of the PDF.
    if (creating) open = false
  }

  /** Take a PDF out of its topic. Unlike closing its tab, the model no longer sees it. */
  function removeSource(id: string, name: string) {
    if (confirm(`Delete “${name}” from this topic? The chat will no longer draw on it.`)) workspace.removeDoc(id)
  }

  function remove(id: string, name: string) {
    const topic = workspace.topics.find((t) => t.id === id)
    const pdfs = topic?.docIds.length ?? 0
    const chats = topic ? discussions(topic).length : 0
    if (!pdfs && !chats) return workspace.deleteTopic(id)
    const discussed = chats === 1 ? ' and its discussion' : chats ? ` and its ${chats} discussions` : ''
    const closed = pdfs === 1 ? 'close its PDF' : pdfs ? `close its ${pdfs} PDFs` : ''
    const question = closed && discussed ? `“${name}”${discussed}, and ${closed}` : `“${name}”${discussed}${closed && ` and ${closed}`}`
    if (confirm(`Delete ${question}?`)) workspace.deleteTopic(id)
  }

  function openChat(topicId: string, chatId: string) {
    workspace.selectTopic(topicId)
    workspace.selectChat(topicId, chatId)
    // Picked: get out of the way and show it.
    open = false
    onopenchat?.()
  }

  function newDiscussion(topicId: string) {
    workspace.newChat(topicId)
    open = false
    onopenchat?.()
  }

  function removeChat(topicId: string, chatId: string, title: string) {
    if (confirm(`Delete the discussion “${title}”?`)) workspace.deleteChat(topicId, chatId)
  }

  async function newTopic() {
    // The list (and so the name box) is hidden while collapsed.
    open = true
    topicBeforeCreating = workspace.activeTopicId
    const topic = workspace.createTopic()
    creatingId = topic.id
    await startRename(topic.id, topic.name)
  }
</script>

<svelte:window onpointerdown={closeMenu} onkeydown={(e) => e.key === 'Escape' && (menuId = undefined)} />

<aside class="topics-sidebar" class:closed={!open} id="topics-sidebar" aria-label="Topics">
  <div class="top">
    {#if expanded}<h1 class="fade">Leqtern</h1>{/if}
    <button
      type="button"
      class="toggle"
      aria-label={open ? 'Hide topics' : 'Show topics'}
      aria-expanded={open}
      aria-controls="topics-list"
      onclick={() => (open = !open)}>☰</button
    >
  </div>

  <button type="button" class="new" aria-label="New topic" title="New topic" onclick={newTopic}>
    <span class="plus" aria-hidden="true">＋</span>
    {#if expanded}<span class="fade">New topic</span>{/if}
  </button>

  {#if expanded}
    <div id="topics-list" class="list fade">
      <h2>Topics</h2>

      {#if workspace.topics.length === 0}
        <p class="hint">Topics group the PDFs you study together, like lecture notes, old exams and the course book.</p>
      {/if}

      <ul>
        {#each workspace.topics as topic (topic.id)}
          <li class:active={topic.id === workspace.activeTopicId}>
            {#if renamingId === topic.id}
              <form
                onsubmit={(e) => {
                  e.preventDefault()
                  finishRename(true)
                }}
              >
                <input
                  bind:this={renameInput}
                  bind:value={draft}
                  aria-label="Topic name"
                  onblur={() => finishRename(true)}
                  onkeydown={(e) => e.key === 'Escape' && finishRename(false)}
                />
              </form>
            {:else}
              <button
                type="button"
                class="topic"
                aria-current={topic.id === workspace.activeTopicId ? 'true' : undefined}
                title="Double-click to rename"
                onclick={() => workspace.selectTopic(topic.id)}
                ondblclick={() => startRename(topic.id, topic.name)}
              >
                <span class="name" use:marquee><span>{topic.name}</span></span>
                <span class="count">{topic.docIds.length}</span>
              </button>
              <button
                type="button"
                class="dots"
                aria-label={`Actions for ${topic.name}`}
                aria-haspopup="menu"
                aria-expanded={menuId === topic.id}
                onclick={() => (menuId = menuId === topic.id ? undefined : topic.id)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="5" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="12" cy="19" r="1.4" />
                </svg>
              </button>
              {#if menuId === topic.id}
                <div class="topic-menu" role="menu" aria-label={`Actions for ${topic.name}`}>
                  <button
                    type="button"
                    role="menuitem"
                    onclick={() => {
                      menuId = undefined
                      startRename(topic.id, topic.name)
                    }}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" /></svg>
                    Rename
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onclick={() => {
                      menuId = undefined
                      onopenprofile?.(topic.id)
                    }}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7" /></svg>
                    Conventions and purpose
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onclick={() => {
                      menuId = undefined
                      onopenflashcards?.(topic.id)
                    }}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d={FLASHCARD_ICON} /></svg>
                    Flashcards
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    class="danger"
                    onclick={() => {
                      menuId = undefined
                      remove(topic.id, topic.name)
                    }}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5" /></svg>
                    Delete
                  </button>
                </div>
              {/if}
            {/if}
          </li>
          {#if topic.id === workspace.activeTopicId && renamingId !== topic.id}
            {@const listed = discussions(topic)}
            {@const discussionsOpen = topic.discussionsOpen !== false}
            {@const sourcesOpen = !!topic.sourcesOpen}
            <!-- The open topic's discussions, on a soft line that forks out to each title. -->
            <li class="discussions" transition:slide={listSlide()}>
              <h3>
                <button
                  type="button"
                  class="list-toggle"
                  id={`discussions-${topic.id}`}
                  aria-expanded={discussionsOpen}
                  onclick={() => (topic.discussionsOpen = !discussionsOpen)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
                  Discussions
                </button>
              </h3>
              {#if discussionsOpen}
              <ul aria-labelledby={`discussions-${topic.id}`} transition:slide={listSlide()}>
                <!-- Opens an empty discussion in the chat. Never marked: it is an action, not a discussion. -->
                <li class="discussion">
                  <div class="row">
                    <button type="button" class="topic new-discussion" onclick={() => newDiscussion(topic.id)}>
                      <span aria-hidden="true">＋</span>
                      <span class="name">New discussion</span>
                    </button>
                  </div>
                </li>
                {#each listed as chat (chat.id)}
                  {@const title = chatTitle(chat)}
                  {@const current = chatOpen && chat.id === chatOf(topic).id}
                  <li class="discussion">
                    <div class="row" class:active={current}>
                      <button
                        type="button"
                        class="topic"
                        aria-current={current ? 'true' : undefined}
                        {title}
                        onclick={() => openChat(topic.id, chat.id)}
                      >
                        <span class="name" use:marquee><span>{title}</span></span>
                      </button>
                      <button
                        type="button"
                        class="dots"
                        aria-label={`Actions for ${title}`}
                        aria-haspopup="menu"
                        aria-expanded={menuId === chat.id}
                        onclick={() => (menuId = menuId === chat.id ? undefined : chat.id)}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <circle cx="12" cy="5" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="12" cy="19" r="1.4" />
                        </svg>
                      </button>
                      {#if menuId === chat.id}
                        <div class="topic-menu" role="menu" aria-label={`Actions for ${title}`}>
                          <button
                            type="button"
                            role="menuitem"
                            class="danger"
                            onclick={() => {
                              menuId = undefined
                              removeChat(topic.id, chat.id, title)
                            }}
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5" /></svg>
                            Delete
                          </button>
                        </div>
                      {/if}
                    </div>
                  </li>
                {/each}
              </ul>
              {/if}
            </li>
            <!-- The topic's PDFs. Closing a tab only takes it off the tab row; it stays here to reopen. -->
            <li class="discussions sources" transition:slide={listSlide()}>
              <h3>
                <button
                  type="button"
                  class="list-toggle"
                  id={`sources-${topic.id}`}
                  aria-expanded={sourcesOpen}
                  onclick={() => (topic.sourcesOpen = !sourcesOpen)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
                  Sources
                </button>
              </h3>
              {#if sourcesOpen}
              <ul aria-labelledby={`sources-${topic.id}`} transition:slide={listSlide()}>
                <!-- Asks for PDFs to add to the topic. An action, never marked. -->
                <li class="discussion">
                  <div class="row">
                    <button type="button" class="topic new-discussion" onclick={() => onupload?.()}>
                      <span aria-hidden="true">＋</span>
                      <span class="name">Upload source</span>
                    </button>
                  </div>
                </li>
                {#each topic.docIds as id (id)}
                  {@const name = workspace.docs[id]?.name ?? ''}
                  {@const isOpen = topic.openDocIds.includes(id)}
                  <li class="discussion">
                    <div class="row" class:active={isOpen && id === topic.activeDocId}>
                      <button
                        type="button"
                        class="topic"
                        aria-current={isOpen && id === topic.activeDocId ? 'true' : undefined}
                        title={isOpen ? name : `${name} (closed, click to open)`}
                        onclick={() => workspace.openDoc(id)}
                      >
                        <span class="name" use:marquee><span>{name}</span></span>
                        {#if isOpen}<span class="open-mark" role="img" aria-label="Open"></span>{/if}
                      </button>
                      <button
                        type="button"
                        class="dots"
                        aria-label={`Actions for ${name}`}
                        aria-haspopup="menu"
                        aria-expanded={menuId === id}
                        onclick={() => (menuId = menuId === id ? undefined : id)}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <circle cx="12" cy="5" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="12" cy="19" r="1.4" />
                        </svg>
                      </button>
                      {#if menuId === id}
                        <div class="topic-menu" role="menu" aria-label={`Actions for ${name}`}>
                          <button
                            type="button"
                            role="menuitem"
                            class="danger"
                            onclick={() => {
                              menuId = undefined
                              removeSource(id, name)
                            }}
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5" /></svg>
                            Delete
                          </button>
                        </div>
                      {/if}
                    </div>
                  </li>
                {/each}
              </ul>
              {/if}
            </li>
          {/if}
        {/each}
      </ul>
    </div>
  {/if}

  <!-- At the bottom, in the same fixed cell as the plus, so it stays put in the collapsed strip too. -->
  <button type="button" class="new settings" aria-label="Settings" title="Settings" onclick={() => onopensettings?.()}>
    <span class="plus" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="3" />
        <path
          d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"
        />
      </svg>
    </span>
    {#if expanded}<span class="fade">Settings</span>{/if}
  </button>
</aside>

<style>
  .topics-sidebar {
    /* The room inside the collapsed strip (its width less padding and border): both icons are centred in a cell this wide. */
    --icon-cell: calc(var(--sidebar-strip) - 0.75rem - 1px);
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    /* Floats over the page rather than pushing it: the page only keeps room for the collapsed strip. */
    position: absolute;
    inset: 0 auto 0 0;
    z-index: 30;
    width: 15rem;
    box-sizing: border-box;
    padding: 0.5rem 0.375rem;
    border-right: 1px solid var(--border);
    /* Slightly see-through and blurred, so it reads as lying on top of the PDF. */
    background: color-mix(in srgb, var(--sidebar-bg) 82%, transparent);
    backdrop-filter: blur(14px);
    box-shadow: var(--sidebar-shadow);
    overflow: hidden;
    white-space: nowrap;
    /* Slides like the chat panel. */
    transition:
      width 0.2s ease,
      background-color 0.2s ease,
      backdrop-filter 0.2s ease,
      box-shadow 0.2s ease;
  }
  /* Just wide enough for the two buttons. (Not named .sidebar: PDF.js's stylesheet styles that globally.) */
  .topics-sidebar.closed {
    width: var(--sidebar-strip);
    background: var(--sidebar-bg);
    backdrop-filter: blur(0);
    box-shadow: 6px 0 28px transparent;
  }
  @media (prefers-reduced-motion: reduce) {
    .topics-sidebar {
      transition: none;
    }
  }

  /* The list keeps its full width while the sidebar opens, so it is revealed rather than reflowed. */
  .list {
    width: calc(15rem - 0.75rem);
    /* Takes what room is left between the buttons, and scrolls when the topics need more. */
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    scrollbar-width: thin;
  }

  /*
   * The two buttons sit in the same place whether the sidebar is open or shut (the menu button at the
   * right edge, the plus in a fixed cell at the left), and the text beside them fades out while the
   * sidebar narrows. So when the text is finally taken away at the end, nothing moves.
   */
  .fade {
    transition: opacity 0.15s ease;
  }
  .closed .fade {
    opacity: 0;
  }

  .top {
    display: flex;
    flex-shrink: 0;
    align-items: center;
  }

  h1 {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    margin: 0;
    /* An indent, not a margin: a margin can't shrink, so it would shove the menu button out of the narrowing sidebar. */
    text-indent: 0.5rem;
    font-size: 1rem;
  }

  .toggle,
  .new {
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    border-radius: 0.375rem;
  }
  .toggle {
    flex-shrink: 0;
    width: var(--icon-cell);
    height: 2.125rem;
    margin-left: auto;
    padding: 0;
    font-size: 1.1rem;
  }
  .new {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    width: 100%;
    height: 2.125rem;
    padding: 0;
    overflow: hidden;
    text-align: left;
  }
  .plus {
    flex-shrink: 0;
    width: var(--icon-cell);
    text-align: center;
  }
  /* Pushed to the bottom; with a long list it comes after it. */
  .settings {
    flex-shrink: 0;
    margin-top: auto;
    font-size: 0.9rem;
  }
  .settings .plus {
    display: grid;
    place-items: center;
  }
  .settings svg {
    width: 1.05rem;
    height: 1.05rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .toggle:hover,
  .new:hover {
    background: var(--hover);
  }

  h2 {
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    margin: 0.75rem 0.5rem 0.25rem;
  }

  .hint {
    white-space: normal;
    margin: 0 0.5rem;
    font-size: 0.85rem;
    color: var(--muted);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  /* Rounded rows with a 2px gap between them, so neighbouring highlights never touch. */
  li {
    display: flex;
    align-items: center;
    margin-block: 1px;
    border-radius: 0.375rem;
  }
  li:hover {
    background: var(--row-hover);
  }
  li.active {
    background: var(--selected);
    font-weight: 600;
  }

  li form {
    flex: 1;
    padding: 0.25rem;
  }
  li input {
    width: 100%;
    box-sizing: border-box;
  }

  .topic {
    flex: 1;
    min-width: 0;
    display: flex;
    gap: 0.5rem;
    padding: 0.375rem 0.5rem;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    font-size: 0.85rem;
    text-align: left;
    cursor: pointer;
  }

  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* A long name scrolls on hover (see marquee.ts): its text moves as a block, without the ellipsis. */
  .name:global(.scrolling) {
    text-overflow: clip;
  }
  .name:global(.scrolling) > span {
    display: inline-block;
  }

  .count {
    color: var(--muted);
    font-weight: normal;
    font-size: 0.75rem;
  }

  .dots {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 1.5rem;
    height: 1.5rem;
    margin-right: 0.25rem;
    padding: 0;
    border: none;
    border-radius: var(--radius);
    background: none;
    color: var(--muted);
    cursor: pointer;
    visibility: hidden;
  }
  .dots svg {
    width: 1rem;
    height: 1rem;
    fill: currentColor;
  }
  .dots:hover,
  .dots[aria-expanded='true'] {
    background: color-mix(in srgb, var(--muted) 18%, transparent);
    color: inherit;
  }
  li:hover > .dots,
  li.active > .dots,
  .dots:focus-visible,
  .dots[aria-expanded='true'] {
    visibility: visible;
  }
  .dots:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  /* Opens under the dots, like the chat's model menu. */
  li {
    position: relative;
  }
  .topic-menu {
    position: absolute;
    top: calc(100% + 0.125rem);
    right: 0.25rem;
    z-index: 5;
    display: flex;
    flex-direction: column;
    min-width: 8rem;
    padding: 0.25rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.18);
    font-size: 0.85rem;
    font-weight: normal;
  }
  .topic-menu button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.5rem;
    border: none;
    border-radius: var(--radius);
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .topic-menu button:hover,
  .topic-menu button:focus-visible {
    background: var(--hover);
    outline: none;
  }
  /* The open topic's discussions: indented, under a small header, on a soft line down the left. */
  li.discussions {
    display: block;
    margin-block: 0;
    padding: 0 0 0.375rem 0.875rem;
    font-weight: normal;
  }
  li.discussions:hover {
    background: none;
  }
  h3 {
    margin: 0.25rem 0 0.125rem 0.25rem;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  .list-toggle {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    padding: 0;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-transform: inherit;
    letter-spacing: inherit;
    cursor: pointer;
  }
  .list-toggle svg {
    width: 0.8rem;
    height: 0.8rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 0.18s ease;
  }
  .list-toggle[aria-expanded='true'] svg {
    transform: rotate(90deg);
  }
  @media (prefers-reduced-motion: reduce) {
    .list-toggle svg {
      transition: none;
    }
  }
  li.discussions ul {
    --branch: color-mix(in srgb, var(--muted) 35%, transparent);
    margin-left: 0.5rem;
  }
  li.discussion {
    margin-block: 0;
    padding-left: 0.75rem;
  }
  li.discussion:hover {
    background: none;
  }
  .row {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    /* The 2px gap lives on the row, so the branch line beside the rows stays unbroken. */
    margin-block: 1px;
    border-radius: 0.375rem;
  }
  .row:hover {
    background: var(--row-hover);
  }
  .row.active {
    background: var(--selected);
    font-weight: 600;
  }
  .row .topic {
    padding: 0.25rem 0.5rem;
    font-size: 0.8rem;
  }
  /* A small dot after the name of each PDF that is open as a tab. */
  .open-mark {
    flex: none;
    align-self: center;
    width: 0.375rem;
    height: 0.375rem;
    margin-left: 0.375rem;
    border-radius: 50%;
    background: var(--muted);
  }
  .new-discussion {
    gap: 0.375rem;
    color: var(--muted);
  }
  .row:hover .dots,
  .row.active .dots {
    visibility: visible;
  }
  /* The line down the left, and a short branch out to each title; the last one turns the corner. */
  li.discussion::before,
  li.discussion::after {
    content: '';
    position: absolute;
    left: 0;
    pointer-events: none;
  }
  li.discussion::before {
    top: 0;
    bottom: 0;
    border-left: 1px solid var(--branch);
  }
  li.discussion::after {
    top: 50%;
    width: 0.625rem;
    border-top: 1px solid var(--branch);
  }
  li.discussion:last-child::before {
    bottom: 50%;
    width: 0.625rem;
    border-bottom: 1px solid var(--branch);
    border-bottom-left-radius: 0.375rem;
  }
  li.discussion:last-child::after {
    display: none;
  }

  .topic-menu .danger {
    color: var(--danger);
  }
  .topic-menu svg {
    width: 0.95rem;
    height: 0.95rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
