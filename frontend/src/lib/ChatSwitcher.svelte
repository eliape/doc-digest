<script lang="ts">
  import { tick } from 'svelte'
  import { chatOf, chatTitle, discussions, type Topic, type Workspace } from './workspace.svelte'

  type Props = {
    workspace: Workspace
    topic: Topic
    /** Called after a discussion is picked, so focus can go to the question box. */
    onpick?: () => void
  }

  let { workspace, topic, onpick }: Props = $props()

  let open = $state(false)
  let root = $state<HTMLElement>()
  let trigger = $state<HTMLButtonElement>()

  let current = $derived(chatOf(topic))
  // Only discussions with something in them are listed, never an empty "New chat".
  let listed = $derived(discussions(topic))

  const items = () => Array.from(root?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])

  async function show() {
    open = true
    await tick()
    const els = items()
    const at = els[Math.max(0, listed.findIndex((c) => c.id === current.id))]
    at?.focus()
    at?.scrollIntoView?.({ block: 'nearest' })
  }

  function hide(refocus = true) {
    open = false
    if (refocus) trigger?.focus()
  }

  function pick(chatId: string) {
    hide(false)
    workspace.selectChat(topic.id, chatId)
    onpick?.()
  }

  $effect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!root?.contains(event.target as Node)) hide(false)
    }
    window.addEventListener('pointerdown', outside, true)
    return () => window.removeEventListener('pointerdown', outside, true)
  })

  function onMenuKeydown(event: KeyboardEvent) {
    const els = items()
    const i = els.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'ArrowDown') els[(i + 1) % els.length]?.focus()
    else if (event.key === 'ArrowUp') els[(i - 1 + els.length) % els.length]?.focus()
    else if (event.key === 'Home') els[0]?.focus()
    else if (event.key === 'End') els.at(-1)?.focus()
    else if (event.key === 'Escape') hide()
    else if (event.key === 'Tab') hide(false)
    else return
    // Escape only closes this menu, not the chat around it.
    if (event.key !== 'Tab') event.preventDefault()
    event.stopPropagation()
  }
</script>

<div class="switcher" bind:this={root}>
  {#if !listed.length}
    <!-- Nothing to switch to: just the title, without the arrow. -->
    <h2 class="trigger static" title={`${chatTitle(current)} · ${topic.name}`}>
      <span class="title" class:empty={!current.messages.length}>{chatTitle(current)}</span>
    </h2>
  {:else}
  <!-- The title and the arrow are one button. -->
  <button
    type="button"
    class="trigger"
    bind:this={trigger}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={`Discussion: ${chatTitle(current)}`}
    title={`${chatTitle(current)} · ${topic.name}`}
    onclick={() => (open ? hide() : show())}
    onkeydown={(e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        show()
      }
    }}
  >
    <span class="title" class:empty={!current.messages.length}>{chatTitle(current)}</span>
    <svg class="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
  </button>
  {/if}
  {#if open && listed.length}
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div class="popup-menu" role="menu" aria-label={`Discussions in ${topic.name}`} onkeydown={onMenuKeydown}>
      {#each listed as chat (chat.id)}
        <button
          type="button"
          role="menuitemradio"
          aria-checked={chat.id === current.id}
          title={chatTitle(chat)}
          onclick={() => pick(chat.id)}
        >
          <span class="title">{chatTitle(chat)}</span>
          {#if workspace.isChatAnswering(chat)}<span class="busy" aria-label="answering"></span>{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .switcher {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
  }

  .trigger {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    max-width: 100%;
    min-width: 0;
    padding: 0.2rem 0.4rem;
    margin-left: -0.4rem;
    border: none;
    border-radius: var(--radius);
    background: none;
    color: inherit;
    font: inherit;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
  }
  .static {
    margin-top: 0;
    margin-bottom: 0;
    cursor: default;
  }
  .trigger:not(.static):hover,
  .trigger[aria-expanded='true'] {
    background: var(--hover);
  }
  .trigger:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* An empty "New chat" is greyed, so it reads as not started yet. */
  .title.empty {
    color: var(--muted);
  }
  .chevron {
    flex-shrink: 0;
    width: 0.85rem;
    height: 0.85rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
    color: var(--muted);
    /* Points down while the list is closed and turns to point up while it is open. */
    transition: transform 0.18s ease;
  }
  .trigger[aria-expanded='true'] .chevron {
    transform: rotate(180deg);
  }
  @media (prefers-reduced-motion: reduce) {
    .chevron {
      transition: none;
    }
  }

  /* Opens downwards from the header; a long list scrolls. */
  .popup-menu {
    position: absolute;
    top: calc(100% + 0.25rem);
    left: -0.4rem;
    z-index: 5;
    width: max-content;
    min-width: 12rem;
    max-width: min(22rem, calc(100vw - 2rem));
    max-height: min(60vh, 24rem);
    overflow-y: auto;
  }
  .popup-menu > button {
    justify-content: space-between;
  }
  .popup-menu [aria-checked='true'] {
    font-weight: 600;
  }
  .busy {
    flex-shrink: 0;
    width: 0.4rem;
    height: 0.4rem;
    border-radius: 50%;
    background: var(--accent);
  }
</style>
