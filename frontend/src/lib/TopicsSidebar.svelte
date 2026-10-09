<script lang="ts">
  import { tick } from 'svelte'
  import type { Workspace } from './workspace.svelte'

  type Props = {
    workspace: Workspace
    /** Whether the sidebar is expanded. When closed, a narrow strip with the two buttons remains. */
    open?: boolean
  }

  let { workspace, open = $bindable(true) }: Props = $props()

  let renamingId = $state<string>()
  let draft = $state('')
  let renameInput = $state<HTMLInputElement>()

  async function startRename(id: string, name: string) {
    renamingId = id
    draft = name
    await tick()
    renameInput?.select()
  }

  function finishRename(save: boolean) {
    if (renamingId && save) workspace.renameTopic(renamingId, draft)
    renamingId = undefined
  }

  function remove(id: string, name: string) {
    const count = workspace.topics.find((t) => t.id === id)?.docIds.length ?? 0
    const what = count === 1 ? 'its PDF' : `its ${count} PDFs`
    if (count === 0 || confirm(`Delete “${name}” and close ${what}?`)) workspace.deleteTopic(id)
  }

  async function newTopic() {
    // The list (and so the name box) is hidden while collapsed.
    open = true
    const topic = workspace.createTopic()
    await startRename(topic.id, topic.name)
  }
</script>

<aside class="topics-sidebar" class:collapsed={!open} id="topics-sidebar" aria-label="Topics">
  <div class="top">
    {#if open}<h1>doc-digest</h1>{/if}
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
    {#if open}<span>New topic</span>{/if}
  </button>

  {#if open}
    <div id="topics-list" class="list">
      <h2>Topics</h2>

      {#if workspace.topics.length === 0}
        <p class="hint">Topics group the PDFs you study together, like lecture notes and the course book.</p>
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
                <span class="name">{topic.name}</span>
                <span class="count">{topic.docIds.length}</span>
              </button>
              <button
                type="button"
                class="icon"
                aria-label={`Rename ${topic.name}`}
                onclick={() => startRename(topic.id, topic.name)}>✎</button
              >
              <button
                type="button"
                class="icon"
                aria-label={`Delete ${topic.name}`}
                onclick={() => remove(topic.id, topic.name)}>×</button
              >
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
    width: 15rem;
    flex-shrink: 0;
    box-sizing: border-box;
    padding: 0.5rem 0.375rem;
    border-right: 1px solid var(--border);
    background: var(--sidebar-bg);
    overflow-y: auto;
  }
  /* Just wide enough for the two buttons. (Not named .sidebar: PDF.js's stylesheet styles that globally.) */
  .topics-sidebar.collapsed {
    width: 3rem;
    align-items: center;
  }

  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 0.25rem 0 0.5rem;
  }
  .collapsed .top {
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
  .collapsed .new {
    padding: 0.375rem 0.625rem;
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
    font-size: 0.85rem;
  }

  .icon {
    border: none;
    background: none;
    color: var(--muted);
    cursor: pointer;
    padding: 0.25rem 0.375rem;
    visibility: hidden;
  }
  li:hover .icon,
  li.active .icon,
  .icon:focus-visible {
    visibility: visible;
  }
</style>
