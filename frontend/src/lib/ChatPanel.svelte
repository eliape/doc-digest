<script lang="ts">
  import { tick } from 'svelte'
  import type { Workspace } from './workspace.svelte'

  type Props = {
    workspace: Workspace
    /** Whether the panel is showing. Closing it only hides it: the chat stays with its topic. */
    open?: boolean
    /** Called after Escape or the close button hides the panel, so focus can go back to the toggle. */
    onclose?: () => void
  }

  let { workspace, open = $bindable(false), onclose }: Props = $props()

  let topic = $derived(workspace.activeTopic)
  let composer = $state<HTMLTextAreaElement>()
  let log = $state<HTMLElement>()
  let panel = $state<HTMLElement>()

  // Focus the question box when the panel opens or the topic changes under it.
  $effect(() => {
    if (open && topic) tick().then(() => composer?.focus({ preventScroll: true }))
  })

  // Keep the newest message in view.
  $effect(() => {
    if (!topic) return
    void topic.chat.length
    tick().then(() => log?.lastElementChild?.scrollIntoView?.({ block: 'end' }))
  })

  function close() {
    open = false
    onclose?.()
  }

  function send(event?: SubmitEvent) {
    event?.preventDefault()
    if (topic) workspace.sendMessage(topic.id, topic.draft)
  }

  function onComposerKeydown(event: KeyboardEvent) {
    // Enter sends, Shift+Enter starts a new line, as in most chat apps.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      send()
    }
  }
</script>

<svelte:window
  onkeydown={(e) => {
    // Escape closes the panel while focus is in it.
    if (e.key === 'Escape' && open && panel?.contains(document.activeElement)) close()
  }}
/>

<!-- Stays mounted while closed so it can slide; inert keeps it out of focus and screen readers. -->
<aside
  class="chat-panel"
  class:open
  id="chat-panel"
  aria-label="Chat"
  inert={!open}
  bind:this={panel}
>
  <div class="inner">
    <div class="top">
      <div class="title">
        <h2>Chat</h2>
        {#if topic}<span class="topic" title={topic.name}>{topic.name}</span>{/if}
      </div>
      <button type="button" class="close" aria-label="Close chat" title="Close chat (Esc)" onclick={close}>×</button>
    </div>

    {#if topic}
      <div class="messages" role="log" aria-label={`Chat in ${topic.name}`} bind:this={log}>
        {#each topic.chat as message (message.id)}
          <div class="message {message.role}">{message.text}</div>
        {:else}
          <p class="hint">
            Ask about anything in {topic.name}. Every PDF in this topic is part of the context, and the chat stays here
            when you switch tabs.
          </p>
        {/each}
        {#if topic.chat.length > 0 && !topic.chat.some((m) => m.role === 'assistant')}
          <p class="hint">Answers are not connected yet. They arrive with the next build step.</p>
        {/if}
      </div>

      <form class="composer" onsubmit={send}>
        <textarea
          bind:this={composer}
          bind:value={topic.draft}
          aria-label="Ask a question"
          placeholder="Ask a question…"
          rows="3"
          onkeydown={onComposerKeydown}
        ></textarea>
        <button type="submit" disabled={!topic.draft.trim()}>Send</button>
      </form>
    {:else}
      <p class="hint">Open a PDF to start a chat about it.</p>
    {/if}
  </div>
</aside>

<style>
  /* In the layout (not floating), so the PDF narrows and nothing is covered. */
  .chat-panel {
    --width: 24rem;
    flex-shrink: 0;
    width: 0;
    height: 100vh;
    overflow: hidden;
    background: var(--sidebar-bg);
    border-left: 1px solid transparent;
    transition:
      width 0.2s ease,
      border-color 0.2s;
  }
  .chat-panel.open {
    width: var(--width);
    border-left-color: var(--border);
  }

  /* Fixed width while the outer box animates, so the text does not reflow as it slides. */
  .inner {
    width: var(--width);
    height: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    padding: 0.5rem 0.75rem 0.75rem;
    gap: 0.5rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .chat-panel {
      transition: none;
    }
  }

  /* On narrow windows the PDF would get too thin, so the panel covers it instead. */
  @media (max-width: 48rem) {
    .chat-panel {
      position: fixed;
      top: 0;
      right: 0;
      z-index: 10;
      box-shadow: -4px 0 16px rgb(0 0 0 / 0.15);
    }
    .chat-panel:not(.open) {
      box-shadow: none;
    }
    .chat-panel,
    .inner {
      --width: min(24rem, 100vw);
    }
  }

  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .title {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    min-width: 0;
  }

  h2 {
    font-size: 1rem;
    margin: 0;
  }

  .topic {
    color: var(--muted);
    font-size: 0.85rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .close {
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    font-size: 1.25rem;
    line-height: 1;
    padding: 0.25rem 0.5rem;
    border-radius: 0.375rem;
    cursor: pointer;
  }
  .close:hover {
    background: var(--hover);
  }

  .messages {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .message {
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .message.user {
    align-self: flex-end;
    max-width: 85%;
    background: var(--hover);
  }
  .message.assistant {
    background: var(--surface);
    border: 1px solid var(--border);
  }

  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 0.9rem;
  }

  .composer {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  textarea {
    resize: none;
    font: inherit;
    padding: 0.5rem;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    background: var(--surface);
    color: inherit;
  }

  .composer button {
    align-self: flex-end;
  }
</style>
