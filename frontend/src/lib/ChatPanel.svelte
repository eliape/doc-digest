<script lang="ts">
  import 'katex/dist/katex.min.css'
  import { tick } from 'svelte'
  import { contextLabel, type PageContext } from './context'
  import { renderMarkdown } from './markdown'
  import { MODELS, savedModel, saveModel } from './models'
  import type { Workspace } from './workspace.svelte'

  type Props = {
    workspace: Workspace
    /** Whether the panel is showing. Closing it only hides it: the chat stays with its topic. */
    open?: boolean
    /** Called after Escape or the close button hides the panel, so focus can go back to the toggle. */
    onclose?: () => void
    /** Send the topic's draft. Defaults to asking with only the attached context. */
    onsend?: (topicId: string) => void
    /** Show where a context chip points: switch to its tab and flash the spot. */
    onreveal?: (context: PageContext) => void
  }

  let { workspace, open = $bindable(false), onclose, onsend, onreveal }: Props = $props()

  let topic = $derived(workspace.activeTopic)
  let composer = $state<HTMLTextAreaElement>()
  let log = $state<HTMLElement>()
  let panel = $state<HTMLElement>()

  // The panel's width in pixels. Drag its left edge to change it; it is remembered across reloads.
  const WIDTH_KEY = 'doc-digest.chatWidth'
  const DEFAULT_WIDTH = 384
  const MIN_WIDTH = 280
  let width = $state(clampWidth(readWidth()))
  let resizing = $state(false)

  /** Keep the panel between a usable minimum and leaving room for the PDF. */
  function clampWidth(px: number) {
    const max = Math.max(MIN_WIDTH, Math.min(window.innerWidth * 0.7, window.innerWidth - 320))
    return Math.round(Math.min(max, Math.max(MIN_WIDTH, px)))
  }

  function readWidth() {
    try {
      return Number(localStorage.getItem(WIDTH_KEY)) || DEFAULT_WIDTH
    } catch {
      return DEFAULT_WIDTH
    }
  }

  function setWidth(px: number) {
    width = clampWidth(px)
    try {
      localStorage.setItem(WIDTH_KEY, String(width))
    } catch {
      // Storage can be unavailable (private windows); the width just isn't remembered.
    }
  }

  function startResize(event: PointerEvent) {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture?.(event.pointerId)
    const startX = event.clientX
    const startWidth = width
    resizing = true
    const move = (e: PointerEvent) => setWidth(startWidth + startX - e.clientX)
    const stop = () => {
      resizing = false
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', stop)
      handle.removeEventListener('pointercancel', stop)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
  }

  function onHandleKeydown(event: KeyboardEvent) {
    // The left edge moves with the arrow keys: left widens the panel, right narrows it.
    const step = event.shiftKey ? 64 : 16
    if (event.key === 'ArrowLeft') setWidth(width + step)
    else if (event.key === 'ArrowRight') setWidth(width - step)
    else return
    event.preventDefault()
  }

  // Focus the question box when the panel opens or the topic changes under it.
  $effect(() => {
    if (open && topic) tick().then(() => composer?.focus({ preventScroll: true }))
  })

  /** How many of the topic's PDFs the backend is still indexing. */
  let indexingCount = $derived(
    topic?.docIds.filter((id) => {
      const status = workspace.indexing[id]?.status
      return status === 'uploading' || status === 'queued' || status === 'indexing'
    }).length ?? 0,
  )

  let answering = $derived(topic ? workspace.isAnswering(topic.id) : false)

  // The model that answers, picked next to the send button and remembered in this browser.
  let model = $state(savedModel())
  $effect(() => {
    workspace.answerModel = model
    saveModel(model)
  })

  // The question box grows with its text (up to its max-height, then it scrolls).
  $effect(() => {
    void topic?.draft
    if (!composer) return
    composer.style.height = 'auto'
    composer.style.height = `${composer.scrollHeight}px`
  })


  /**
   * Whether a question was about a spot the reader clicked or selected. Questions
   * asked without one carry the open page, which is always included, so they get no chip.
   */
  function pointedAt(context: PageContext) {
    return !!(context.point || context.selection)
  }

  /** The chip's name, with the PDF's name when the topic has several. */
  function chipName(context: PageContext) {
    const several = (topic?.docIds.length ?? 0) > 1
    return several ? `${contextLabel(context)} · ${context.docName}` : contextLabel(context)
  }

  function chipTitle(context: PageContext) {
    const what = context.selection ? 'Selected text' : context.point ? 'Clicked spot' : 'Page'
    return `${what} on ${contextLabel(context)} of ${context.docName}. Click to show it.`
  }

  // Keep the newest message in view, also while an answer streams in.
  $effect(() => {
    if (!topic) return
    void topic.chat.length
    void topic.chat.at(-1)?.text
    void topic.chat.at(-1)?.steps?.length
    tick().then(() => log?.lastElementChild?.scrollIntoView?.({ block: 'end' }))
  })

  /** Put the cursor in the question box. */
  export function focus() {
    composer?.focus({ preventScroll: true })
  }

  function close() {
    open = false
    onclose?.()
  }

  function send(event?: SubmitEvent) {
    event?.preventDefault()
    if (!topic || answering) return
    if (onsend) onsend(topic.id)
    else workspace.ask(topic.id)
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
  onresize={() => (width = clampWidth(width))}
  onkeydown={(e) => {
    // Escape takes off the attached spot, or else closes the panel, while focus is in it.
    if (e.key === 'Escape' && open && panel?.contains(document.activeElement)) {
      if (topic?.context) workspace.clearContext(topic.id)
      else close()
    }
  }}
/>

<!-- Stays mounted while closed so it can slide; inert keeps it out of focus and screen readers. -->
<aside
  class="chat-panel"
  class:open
  class:resizing
  style:--width={`${width}px`}
  id="chat-panel"
  aria-label="Chat"
  inert={!open}
  bind:this={panel}
>
  <!-- A focusable separator is an interactive widget (like a slider), which Svelte's check does not know. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="resize-handle"
    role="separator"
    aria-label="Resize chat"
    aria-orientation="vertical"
    aria-valuenow={width}
    aria-valuemin={MIN_WIDTH}
    tabindex="0"
    title="Drag to resize. Double-click to reset."
    onpointerdown={startResize}
    ondblclick={() => setWidth(DEFAULT_WIDTH)}
    onkeydown={onHandleKeydown}
  ></div>
  <div class="inner">
    <div class="top">
      <div class="title">
        <h2>Chat</h2>
        {#if topic}<span class="topic" title={topic.name}>{topic.name}</span>{/if}
      </div>
      <div class="actions">
        <button
          type="button"
          class="new-chat"
          title="Clear this topic's chat and start over"
          disabled={!topic || topic.chat.length === 0}
          onclick={() => {
            if (!topic) return
            workspace.newChat(topic.id)
            focus()
          }}>New chat</button
        >
        <button type="button" class="close" aria-label="Close chat" title="Close chat (Esc)" onclick={close}>×</button>
      </div>
    </div>

    {#if topic}
      <div class="messages" role="log" aria-label={`Chat in ${topic.name}`} bind:this={log}>
        {#each topic.chat as message (message.id)}
          <div class="message {message.role}" class:error={message.status === 'error'}>
            {#if message.context && pointedAt(message.context)}
              <button
                type="button"
                class="chip small"
                title={chipTitle(message.context)}
                onclick={() => onreveal?.(message.context!)}
              >
                {#if message.context.thumbnail}<img src={message.context.thumbnail} alt="" />{/if}
                <span>{chipName(message.context)}</span>
              </button>
            {/if}
            {#if message.steps?.length}
              <ul class="steps" aria-label="Looked up">
                {#each message.steps as step, i (i)}<li>{step}</li>{/each}
              </ul>
            {/if}
            {#if message.status === 'streaming' && !message.text}
              <span class="thinking">Thinking…</span>
            {:else if message.role === 'assistant'}
              <!-- Answers are Markdown with LaTeX maths; renderMarkdown sanitizes the HTML. -->
              <div class="text markdown">{@html renderMarkdown(message.text)}</div>
            {:else}
              <span class="text">{message.text}</span>
            {/if}
          </div>
        {:else}
          <p class="hint">
            Ask about anything in {topic.name}. Every PDF in this topic is part of the context, and the chat stays here
            when you switch tabs.
          </p>
        {/each}
      </div>

      {#if indexingCount}
        <p class="indexing" role="status">
          Indexing {indexingCount === 1 ? '1 PDF' : `${indexingCount} PDFs`}. You can already ask about the open page;
          the rest of the topic becomes searchable as indexing finishes.
        </p>
      {/if}

      <form class="composer" onsubmit={send}>
        {#if topic.context}
          {@const context = topic.context}
          <div class="attached" aria-label="Attached to your question">
            <button type="button" class="chip" title={chipTitle(context)} onclick={() => onreveal?.(context)}>
              {#if context.thumbnail}<img src={context.thumbnail} alt="" />{/if}
              <span>{chipName(context)}</span>
              {#if context.selection}<span class="quote">“{context.selection}”</span>{/if}
            </button>
            <button
              type="button"
              class="remove"
              aria-label="Remove from your question"
              title="Remove (Esc)"
              onclick={() => workspace.clearContext(topic.id)}>×</button
            >
          </div>
        {/if}
        <div class="input">
          <textarea
            bind:this={composer}
            bind:value={topic.draft}
            aria-label="Ask a question"
            placeholder={topic.context ? `Ask about ${contextLabel(topic.context)}…` : 'Ask a question…'}
            rows="1"
            onkeydown={onComposerKeydown}
          ></textarea>
          <div class="controls">
            <button
              type="submit"
              class="send"
              aria-label="Send"
              title="Send (Enter)"
              disabled={!topic.draft.trim() || answering}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 10l-5 5 5 5" /><path d="M20 4v7a4 4 0 0 1-4 4H4" /></svg>
            </button>
          </div>
        </div>
      </form>
      <!-- Below the box, so it never takes room from the question's lines. -->
      <div class="below">
        <label class="model" title={MODELS.find((m) => m.id === model)?.hint}>
          <span class="visually-hidden">Model</span>
          <select bind:value={model}>
            {#each MODELS as m (m.id)}
              <option value={m.id}>{m.name}</option>
            {/each}
          </select>
          <svg class="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
        </label>
      </div>
    {:else}
      <p class="hint">Open a PDF to start a chat about it.</p>
    {/if}
  </div>
</aside>

<style>
  /* In the layout (not floating), so the PDF narrows and nothing is covered. */
  .chat-panel {
    position: relative;
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

  /* No animation while dragging, so the edge follows the pointer. */
  .chat-panel.resizing {
    transition: none;
    user-select: none;
  }

  /* A thin strip on the left edge, highlighted when hovered or dragged. */
  .resize-handle {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 6px;
    z-index: 1;
    cursor: col-resize;
    touch-action: none;
  }
  .resize-handle:hover,
  .resize-handle:focus-visible,
  .resizing .resize-handle {
    background: var(--accent);
    opacity: 0.5;
    outline: none;
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
    .chat-panel.open,
    .inner {
      width: min(var(--width), 100vw);
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

  .actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .new-chat {
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    background: var(--surface);
    color: inherit;
    font: inherit;
    font-size: 0.85rem;
    padding: 0.125rem 0.5rem;
    cursor: pointer;
  }
  .new-chat:hover:not(:disabled) {
    background: var(--hover);
  }
  .new-chat:disabled {
    color: var(--muted);
    cursor: default;
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
    overflow-wrap: anywhere;
  }
  .text {
    white-space: pre-wrap;
  }
  .text.markdown {
    white-space: normal;
  }
  .markdown :global(:first-child) {
    margin-top: 0;
  }
  .markdown :global(:last-child) {
    margin-bottom: 0;
  }
  .markdown :global(p),
  .markdown :global(ul),
  .markdown :global(ol),
  .markdown :global(pre),
  .markdown :global(table),
  .markdown :global(blockquote) {
    margin: 0 0 0.6em;
  }
  .markdown :global(ul),
  .markdown :global(ol) {
    padding-left: 1.4em;
  }
  .markdown :global(h1),
  .markdown :global(h2),
  .markdown :global(h3),
  .markdown :global(h4) {
    font-size: 1em;
    margin: 0.8em 0 0.4em;
  }
  .markdown :global(code) {
    font-size: 0.9em;
    padding: 0.1em 0.3em;
    border-radius: 0.25rem;
    background: var(--hover);
  }
  .markdown :global(pre) {
    padding: 0.5em 0.75em;
    border-radius: 0.375rem;
    background: var(--hover);
    overflow-x: auto;
  }
  .markdown :global(pre code) {
    padding: 0;
    background: none;
  }
  .markdown :global(blockquote) {
    padding-left: 0.75em;
    border-left: 3px solid var(--border);
    color: var(--muted);
  }
  .markdown :global(table) {
    border-collapse: collapse;
    display: block;
    overflow-x: auto;
  }
  .markdown :global(th),
  .markdown :global(td) {
    border: 1px solid var(--border);
    padding: 0.25em 0.5em;
  }
  .markdown :global(a) {
    color: var(--accent);
  }
  /* Wide equations scroll sideways instead of overflowing the panel. */
  .markdown :global(.math-display) {
    overflow-x: auto;
    overflow-y: hidden;
    margin: 0 0 0.6em;
  }
  .markdown :global(.katex-display) {
    margin: 0.25em 0;
  }
  /* Keep inline maths like "n − 1" on one line. */
  .markdown :global(.katex) {
    font-size: 1.1em;
    white-space: nowrap;
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

  .message.error {
    color: var(--error, #82071e);
    background: #ffebe9;
    border-color: #ffcecb;
  }

  .steps {
    margin: 0 0 0.375rem;
    padding: 0;
    list-style: none;
    color: var(--muted);
    font-size: 0.8rem;
  }
  .steps li::before {
    content: '↳ ';
  }

  .indexing {
    margin: 0;
    color: var(--muted);
    font-size: 0.8rem;
  }

  .thinking {
    color: var(--muted);
  }

  .chip {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    padding: 0.25rem;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    background: var(--surface);
    color: inherit;
    font: inherit;
    font-size: 0.85rem;
    text-align: left;
    cursor: pointer;
  }
  .chip:hover {
    background: var(--hover);
  }
  .chip img {
    flex-shrink: 0;
    width: 4rem;
    max-height: 3rem;
    object-fit: cover;
    object-position: center;
    border-radius: 0.25rem;
    border: 1px solid var(--border);
  }
  .chip span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip .quote {
    color: var(--muted);
  }
  .chip.small {
    margin-bottom: 0.375rem;
    font-size: 0.8rem;
    white-space: normal;
  }
  .chip.small img {
    width: 3rem;
    max-height: 2.25rem;
  }

  .attached {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .attached .chip {
    flex: 1;
  }
  .remove {
    border: none;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 1.1rem;
    padding: 0.25rem 0.5rem;
    border-radius: 0.375rem;
    cursor: pointer;
  }
  .remove:hover {
    background: var(--hover);
  }

  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 0.9rem;
  }

  /* One rounded box holding the attached spot, the question and its controls. */
  .composer {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.375rem;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: var(--surface);
    transition:
      border-color 0.15s,
      box-shadow 0.15s;
  }
  .composer:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
  }

  .input {
    position: relative;
  }

  textarea {
    display: block;
    width: 100%;
    box-sizing: border-box;
    min-height: 2.25rem;
    max-height: 12rem;
    overflow-y: auto;
    resize: none;
    font: inherit;
    line-height: 1.4;
    /* Room for the send arrow at the right. */
    padding: 0.4rem 2.5rem 0.4rem 0.5rem;
    border: none;
    outline: none;
    background: none;
    color: inherit;
  }

  /* Pinned to the bottom right, so the arrow stays on the last line as the question grows. */
  .controls {
    position: absolute;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
  }

  /* A slim row under the box. Negative margin pulls it close, so it reads as part of the box. */
  .below {
    display: flex;
    justify-content: flex-end;
    margin-top: -0.25rem;
  }

  .model {
    position: relative;
    display: flex;
    align-items: center;
    border-radius: 0.375rem;
    color: var(--muted);
  }
  .model:hover,
  .model:focus-within {
    background: var(--hover);
    color: inherit;
  }
  .model select {
    appearance: none;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    font-size: 0.75rem;
    line-height: 1.2;
    padding: 0.15rem 1.2rem 0.15rem 0.4rem;
    cursor: pointer;
    outline: none;
  }
  .model select option {
    color: initial;
  }
  .chevron {
    position: absolute;
    right: 0.35rem;
    width: 0.75rem;
    height: 0.75rem;
    pointer-events: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .send {
    display: grid;
    place-items: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
    transition:
      background 0.15s,
      transform 0.1s;
  }
  .send:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 85%, #000);
  }
  .send:active:not(:disabled) {
    transform: scale(0.94);
  }
  .send:disabled {
    background: var(--hover);
    color: var(--muted);
    cursor: default;
  }
  .send svg {
    width: 1rem;
    height: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
