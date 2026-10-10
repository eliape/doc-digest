<script lang="ts">
  import 'katex/dist/katex.min.css'
  import { tick } from 'svelte'
  import { clampWidth, DEFAULT_WIDTH, MIN_WIDTH, readWidth, WIDTH_KEY } from './chatWidth'
  import { contextLabel, type PageContext, type Pick } from './context'
  import Dropdown from './Dropdown.svelte'
  import { type CitableDocs, renderMarkdown } from './markdown'
  import { MODELS, savedModel, saveModel } from './models'
  import { MODES } from './modes'
  import type { Topic, Workspace } from './workspace.svelte'

  type Props = {
    workspace: Workspace
    /**
     * Whether the panel is showing. Closing it hides it and takes off the attached spot;
     * the chat stays with its topic.
     */
    open?: boolean
    /** Called after Escape or the close button hides the panel, so focus can go back to the toggle. */
    onclose?: () => void
    /** Send the topic's draft. Defaults to asking with only the attached context. */
    onsend?: (topicId: string) => void
    /** Show where a context chip or a citation points: switch to its tab, go to the page and flash the spot. */
    onreveal?: (target: Pick & { docId: string }) => void
  }

  let { workspace, open = $bindable(false), onclose, onsend, onreveal }: Props = $props()

  let topic = $derived(workspace.activeTopic)
  let composer = $state<HTMLTextAreaElement>()
  let log = $state<HTMLElement>()
  let panel = $state<HTMLElement>()

  // The panel's width in pixels. Drag its left edge to change it; it is remembered across reloads.
  let width = $state(clampWidth(readWidth()))
  let resizing = $state(false)

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

  /** What the question box asks for: once the model has asked a Socratic question, the reader's answer. */
  function placeholder(t: Topic) {
    if (t.mode === 'socratic' && t.chat.at(-1)?.mode === 'socratic') return 'Answer, or ask for a hint…'
    return t.context ? `Ask about ${contextLabel(t.context)}…` : 'Ask a question…'
  }

  function chipTitle(context: PageContext) {
    const what = context.selection ? 'Selected text' : context.point ? 'Clicked spot' : 'Page'
    return `${what} on ${contextLabel(context)} of ${context.docName}. Click to show it.`
  }

  // Follow the newest message, also while an answer streams in, but only while the reader is at
  // the bottom: scrolling up to read stops the following, and scrolling back down resumes it.
  const NEAR_BOTTOM = 24
  let following = true
  let followed: { topic?: string; length: number } = { length: 0 }

  function onLogScroll() {
    if (log) following = log.scrollHeight - log.scrollTop - log.clientHeight <= NEAR_BOTTOM
  }

  $effect(() => {
    if (!topic) return
    void topic.chat.at(-1)?.text
    void topic.chat.at(-1)?.steps?.length
    const length = topic.chat.length
    // A new question, or another topic's chat, always starts at the bottom.
    const sent = length > followed.length && topic.chat.at(-1)?.role === 'user'
    if (sent || followed.topic !== topic.id) following = true
    followed = { topic: topic.id, length }
    if (following) tick().then(() => log && (log.scrollTop = log.scrollHeight))
  })

  /** The topic's PDF names, so answers' citations of them become links. */
  let docNames = $derived(topic?.docIds.map((id) => workspace.docs[id]?.name).filter((n): n is string => !!n) ?? [])

  // The backend calls the uploaded PDFs D1, D2, … in tab order, and the model sometimes cites them that way.
  let aliases = $derived(
    Object.fromEntries(
      (topic?.docIds ?? [])
        .filter((id) => workspace.indexing[id]?.serverId && workspace.docs[id])
        .map((id, i) => [`D${i + 1}`, workspace.docs[id].name]),
    ),
  )

  /** What an answer's citations can point at; a bare "(p. 12)" means the PDF its question was asked in. */
  function citable(index: number): CitableDocs {
    const asked = topic?.chat.findLast((m, i) => i < index && m.role === 'user')?.context?.docName
    const current = asked && docNames.includes(asked) ? asked : docNames.length === 1 ? docNames[0] : undefined
    return { names: docNames, aliases, current }
  }

  /** Show the page a citation in an answer points at, in the topic's PDF of that name. */
  function onCitationClick(event: MouseEvent) {
    const citation = (event.target as Element).closest<HTMLElement>('a.citation')
    if (!citation || !topic) return
    event.preventDefault()
    const docId = topic.docIds.find((id) => workspace.docs[id]?.name === citation.dataset.doc)
    const page = Number(citation.dataset.page)
    if (docId && page) onreveal?.({ docId, page })
  }

  /** Put the cursor in the question box. */
  export function focus() {
    composer?.focus({ preventScroll: true })
  }

  /** Hide the panel. What was attached to the next question goes too, and its marker fades. */
  function close() {
    open = false
    if (topic?.context) workspace.clearContext(topic.id)
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
    // Escape takes off the attached spot, or else closes the panel, while focus is in it
    // (unless a menu in it took the Escape to close itself).
    if (e.key === 'Escape' && !e.defaultPrevented && open && panel?.contains(document.activeElement)) {
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
      <!-- Just the topic's name: the panel is already labelled Chat. -->
      {#if topic}<h2 title={topic.name}>{topic.name}</h2>{/if}
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
        <!-- In the window's top right corner, exactly where the Chat icon is while the chat is closed. -->
        <button type="button" class="icon-button" aria-label="Close chat" title="Close chat (Esc)" onclick={close}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
    </div>

    {#if topic}
      <!-- Citations are links inside the answers' HTML, so their clicks are handled here. -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
      <div class="messages" role="log" aria-label={`Chat in ${topic.name}`} bind:this={log} onclick={onCitationClick} onscroll={onLogScroll}>
        {#each topic.chat as message, index (message.id)}
          <!-- Only the model's side of a Socratic session is marked; the reader's messages look as always. -->
          <div
            class="message {message.role}"
            class:socratic={message.role === 'assistant' && message.mode === 'socratic'}
            class:error={message.status === 'error'}
          >
            {#if message.role === 'user' && message.mode === 'socratic' && !message.text}
              <!-- A session starts from a right-click, with nothing typed. -->
              <span class="session-start">Socratic session</span>
            {/if}
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
              <div class="text markdown">{@html renderMarkdown(message.text, citable(index))}</div>
            {:else if message.text}
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

      <form class="composer" class:socratic={topic.mode === 'socratic'} onsubmit={send}>
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
            placeholder={placeholder(topic)}
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
        <div class="mode" style:--dropdown-color={topic.mode === 'socratic' ? 'var(--socratic)' : undefined}>
          <Dropdown
            label="Mode"
            value={topic.mode}
            options={MODES}
            onchange={(mode) => {
              workspace.setMode(topic.id, mode)
              focus()
            }}
          />
        </div>
        <Dropdown
          label="Model"
          value={model}
          options={MODELS.map((m) => ({ value: m.id, label: m.name, title: m.hint }))}
          onchange={(id) => (model = id)}
          align="right"
        />
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
    display: flex;
    /* Anchored to the right edge, so the panel is revealed from the right and its top right
       corner (the close button) is there from the first frame. */
    justify-content: flex-end;
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
    flex-shrink: 0;
    width: var(--width);
    height: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    padding: 0 0.75rem 0.75rem;
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

  /* As tall as the tab row beside it, so the two bottom borders line up. */
  .top {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    height: var(--bar-height);
    margin: 0 -0.75rem;
    padding: 0 0.5rem 0 0.75rem;
    border-bottom: 1px solid var(--border);
  }

  h2 {
    flex: 1;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    font-size: 0.95rem;
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
    height: 1.75rem;
    padding: 0 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: inherit;
    font: inherit;
    font-size: 0.9rem;
    cursor: pointer;
  }
  .new-chat:hover:not(:disabled) {
    background: var(--hover);
  }
  .new-chat:disabled {
    color: var(--muted);
    cursor: default;
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
  /* A citation reads like a link and shows its page in the PDF. */
  .markdown :global(.citation) {
    text-decoration: underline;
    text-decoration-style: dotted;
    text-underline-offset: 0.15em;
    cursor: pointer;
  }
  .markdown :global(.citation:hover) {
    text-decoration-style: solid;
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

  /* The model's Socratic questions have a coloured edge, matching the question box's shade in that mode. */
  .message.socratic {
    box-shadow: inset 3px 0 0 var(--socratic);
  }
  /* A session started by a right-click has nothing typed, so its message says what it is. */
  .session-start {
    display: block;
    margin-bottom: 0.375rem;
    color: var(--muted);
    font-size: 0.8rem;
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
  /* In Socratic mode the box takes that mode's colour, so the mode shows where you type. */
  .composer.socratic {
    border-color: color-mix(in srgb, var(--socratic) 45%, var(--border));
  }
  .composer.socratic:focus-within {
    border-color: var(--socratic);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--socratic) 22%, transparent);
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

  /* A slim row under the box: the mode on the left, the model on the right. Negative margin
     pulls it close, so it reads as part of the box. */
  .below {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: -0.25rem;
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
</style>
