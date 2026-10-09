<script lang="ts">
  import { tick } from 'svelte'
  import type { Workspace } from './workspace.svelte'

  type Props = {
    workspace: Workspace
    /** Whether the sidebar is expanded. When closed, a narrow strip with the two buttons remains. */
    open?: boolean
  }

  let { workspace, open = $bindable(true) }: Props = $props()

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

  // The topic whose actions menu (the three dots) is open.
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

  function remove(id: string, name: string) {
    const count = workspace.topics.find((t) => t.id === id)?.docIds.length ?? 0
    const what = count === 1 ? 'its PDF' : `its ${count} PDFs`
    if (count === 0 || confirm(`Delete “${name}” and close ${what}?`)) workspace.deleteTopic(id)
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

<aside class="topics-sidebar" class:collapsed={!expanded} class:closed={!open} id="topics-sidebar" aria-label="Topics">
  <div class="top">
    {#if expanded}<h1>doc-digest</h1>{/if}
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
    <span aria-hidden="true">＋</span>
    {#if expanded}<span>New topic</span>{/if}
  </button>

  {#if expanded}
    <div id="topics-list" class="list">
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
                onclick={() => {
                  workspace.selectTopic(topic.id)
                  // Chosen: get out of the way of its PDF.
                  open = false
                }}
                ondblclick={() => startRename(topic.id, topic.name)}
              >
                <span class="name">{topic.name}</span>
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
        {/each}
      </ul>
    </div>
  {/if}
</aside>

<style>
  .topics-sidebar {
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
    overflow: hidden auto;
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
    flex-shrink: 0;
  }

  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 0.25rem 0 0.5rem;
  }
  .collapsed .top {
    justify-content: center;
    padding: 0;
  }

  h1 {
    font-size: 1rem;
    margin: 0;
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
    font-size: 1.1rem;
    padding: 0.25rem 0.5rem;
  }
  .new {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.5rem;
    text-align: left;
  }
  /* Collapsed, both buttons are the same square, centred in the strip. */
  .collapsed .toggle,
  .collapsed .new {
    align-self: center;
    justify-content: center;
    width: 2.125rem;
    height: 2.125rem;
    padding: 0;
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

  li {
    display: flex;
    align-items: center;
    border-radius: 0.375rem;
  }
  li:hover,
  li.active {
    background: var(--hover);
  }
  li.active {
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
  li:hover .dots,
  li.active .dots,
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
