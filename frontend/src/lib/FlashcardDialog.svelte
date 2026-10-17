<script lang="ts">
  import CardEditor from './CardEditor.svelte'
  import type { Pick } from './context'
  import Dropdown from './Dropdown.svelte'
  import {
    addCards,
    type Candidate,
    CARD_TYPES,
    type CardDraft,
    cardHtml,
    cardProblem,
    clampCount,
    fetchDeck,
    type Filtered,
    makeFlashcards,
    MAX_CARDS,
    type Match,
    savedFlashcardOptions,
    saveFlashcardOptions,
    sourceLabel,
    typeName,
  } from './flashcards'
  import { EFFORTS, MODELS } from './models'
  import type { FlashcardSource, Workspace } from './workspace.svelte'

  type Props = {
    workspace: Workspace
    topicId: string
    source: FlashcardSource
    /** What the cards are made from, in a few words, like “Your selection on p. 41 of book.pdf”. */
    about: string
    onclose: () => void
    /** Show the page a card comes from. */
    onreveal?: (target: Pick & { docId: string }) => void
    /** Open the topic's deck, once cards were added to it. */
    onopendeck?: () => void
  }

  let { workspace, topicId, source, about, onclose, onreveal, onopendeck }: Props = $props()

  const topic = $derived(workspace.topics.find((t) => t.id === topicId))

  let options = $state(savedFlashcardOptions())
  let focus = $state('')
  let step = $state<'setup' | 'writing' | 'preview' | 'added'>('setup')
  let steps = $state<string[]>([])
  let error = $state('')
  let cards = $state<Candidate[]>([])
  let filtered = $state<Filtered[]>([])
  let checkedByMeaning = $state(true)
  let added = $state({ cards: 0, upgraded: 0 })
  let deckSize = $state<number>()
  let saving = $state(false)
  let controller: AbortController | undefined

  // Opening the menu also has the backend load its embedding model, so it is ready by the time
  // the cards are checked for duplicates.
  $effect(() => {
    fetchDeck(topicId)
      .then((deck) => (deckSize = deck.cards.length))
      .catch(() => {})
  })

  let card = $state<HTMLElement>()
  const returnTo = document.activeElement as HTMLElement | null
  $effect(() => {
    card?.querySelector<HTMLElement>('input, button.primary')?.focus()
    return () => {
      controller?.abort()
      returnTo?.focus?.()
    }
  })

  const selection = $derived(source.kind === 'pick' ? source.context.selection?.trim() : undefined)
  const upgrades = $derived([
    ...new Set(filtered.filter((f) => f.status === 'reverse' && f.upgrade && f.match?.id).map((f) => f.match!.id!)),
  ])
  const problems = $derived(cards.map(cardProblem))
  const modelOptions = MODELS.map((m) => ({ value: m.id, label: m.name, title: m.hint }))
  const effortOptions = EFFORTS.map((e) => ({ value: e.id, label: e.name, title: e.hint }))

  function toggleType(id: Candidate['type'], on: boolean) {
    options.types = on ? CARD_TYPES.map((t) => t.id).filter((t) => t === id || options.types.includes(t)) : options.types.filter((t) => t !== id)
  }

  async function make() {
    if (!options.types.length) return
    options.count = clampCount(options.count)
    saveFlashcardOptions($state.snapshot(options))
    step = 'writing'
    steps = []
    error = ''
    controller = new AbortController()
    const signal = controller.signal
    try {
      const request = await workspace.flashcardRequest(topicId, source)
      if (!request) throw new Error('What these cards were to be made from is gone.')
      const body = { ...request, ...$state.snapshot(options), ...(focus.trim() && { focus: focus.trim() }) }
      for await (const event of makeFlashcards(topicId, body, signal)) {
        if (signal.aborted) return
        if (event.type === 'step') steps.push(event.text)
        else {
          cards = event.cards
          filtered = event.filtered
          checkedByMeaning = event.embeddings
          step = 'preview'
        }
      }
    } catch (e) {
      if (signal.aborted) return
      error = e instanceof Error ? e.message : String(e)
      step = 'setup'
    }
  }

  function cancel() {
    controller?.abort()
    step = 'setup'
  }

  function bringBack(entry: Filtered) {
    filtered = filtered.filter((f) => f !== entry)
    const { key, type, front, back, extra, source } = entry
    cards.push({ key, type, front, back, extra, source })
  }

  async function add() {
    if (problems.some(Boolean) || saving) return
    saving = true
    error = ''
    try {
      const drafts: CardDraft[] = cards.map(({ type, front, back, extra, source }) => ({ type, front, back, extra, source }))
      const deck = await addCards(topicId, drafts, upgrades)
      added = { cards: deck.added.length, upgraded: upgrades.length }
      deckSize = deck.cards.length
      step = 'added'
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      saving = false
    }
  }

  /** Close, after asking when that would throw away cards not yet added. */
  function close() {
    if (step === 'preview' && (cards.length || upgrades.length) && !confirm('Close without adding these cards to the deck?')) return
    onclose()
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }

  function reveal(candidate: Candidate) {
    const doc = candidate.source?.doc_id && workspace.docOfServerId(topicId, candidate.source.doc_id)
    const page = candidate.source?.pages[0]
    if (doc && page) onreveal?.({ docId: doc, page })
  }

  const matchWhere = (match: Match) => (match.existing ? 'in your deck' : 'in this batch')

  function leftOutWhy(entry: Filtered): string {
    if (entry.status === 'reverse') return 'Asks the other way round:'
    if (entry.stage === 'lexical') return 'Worded almost the same as:'
    if (entry.stage === 'haiku') return 'Tests the same thing as:'
    return 'Means the same as:'
  }

  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
</script>

<!-- Pressing the dimmed backdrop closes it, like Escape; the × does the same by keyboard. -->
<div class="backdrop flashcard-dialog" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && close()} {onkeydown}>
  <div bind:this={card} class="card" class:wide={step === 'preview'} role="dialog" aria-modal="true" aria-labelledby="flashcards-title">
    <header>
      <div>
        <h2 id="flashcards-title">Make flashcards</h2>
        <p class="sub">
          {topic?.name ?? 'Topic'}{#if deckSize !== undefined}{' · '}{plural(deckSize, 'card')} in its deck{/if}
        </p>
      </div>
      <button type="button" class="chrome-button close" aria-label="Close Make flashcards" onclick={close}>×</button>
    </header>

    {#if step === 'setup'}
      <div class="field">
        <span class="label">From</span>
        <span class="about">{about}</span>
        {#if selection}<blockquote>{selection.length > 280 ? `${selection.slice(0, 280)}…` : selection}</blockquote>{/if}
      </div>

      <label class="field">
        <span class="label">Focus <span class="optional">(optional)</span></span>
        <input type="text" bind:value={focus} placeholder="Like “the conditions of the theorem” or “the definitions”" />
      </label>

      <label class="field count">
        <span class="label">How many cards</span>
        <input type="number" min="1" max={MAX_CARDS} bind:value={options.count} onchange={() => (options.count = clampCount(options.count))} />
      </label>

      <fieldset class="field">
        <legend class="label">Card types</legend>
        {#each CARD_TYPES as type (type.id)}
          <label class="check">
            <input type="checkbox" checked={options.types.includes(type.id)} onchange={(e) => toggleType(type.id, e.currentTarget.checked)} />
            <span>{type.name}</span>
            <span class="hint">{type.hint}</span>
          </label>
        {/each}
        {#if !options.types.length}<span class="problem">Pick at least one type.</span>{/if}
      </fieldset>

      <fieldset class="field">
        <legend class="label">When a new card asks the reverse of a card in the deck</legend>
        <label class="check">
          <input type="radio" name="reverse" value="upgrade" bind:group={options.reverse} />
          <span>Automatically upgrade existing cards to Basic and reversed</span>
        </label>
        <label class="check">
          <input type="radio" name="reverse" value="discard" bind:group={options.reverse} />
          <span>Discard reverse</span>
        </label>
      </fieldset>

      <p class="notice">Dedup currently only supports English: in other languages it may miss duplicates, or flag cards that aren't.</p>

      {#if error}<p class="problem" role="alert">{error}</p>{/if}

      <footer>
        <div class="pickers">
          <Dropdown label="Model" value={options.model} options={modelOptions} onchange={(v) => (options.model = v)} />
          <Dropdown label="Effort" value={options.effort} options={effortOptions} onchange={(v) => (options.effort = v)} />
        </div>
        <button type="button" class="primary" disabled={!options.types.length} onclick={make}>
          Make {plural(clampCount(options.count), 'card')}
        </button>
      </footer>
    {:else if step === 'writing'}
      <div class="writing" aria-live="polite">
        <p class="busy">Writing {plural(clampCount(options.count), 'card')}…</p>
        {#if steps.length}
          <ul class="steps">{#each steps as text, i (i)}<li>{text}</li>{/each}</ul>
        {/if}
      </div>
      <footer>
        <span></span>
        <button type="button" class="secondary" onclick={cancel}>Cancel</button>
      </footer>
    {:else if step === 'preview'}
      {#if !checkedByMeaning}
        <p class="notice">
          Duplicates were only checked by wording: the local embedding model isn't installed or hasn't loaded yet.
        </p>
      {/if}
      {#if cards.length}
        <ol class="previews">
          {#each cards as candidate, i (candidate.key)}
            {@const label = sourceLabel(candidate.source)}
            <li class="preview">
              <CardEditor bind:card={cards[i]} types={CARD_TYPES.map((t) => t.id)} />
              <div class="meta">
                {#if label}
                  <button type="button" class="link" title="Show this page" onclick={() => reveal(candidate)}>{label}</button>
                {/if}
                {#if candidate.similar}
                  <span class="warning" title={candidate.similar.front}>
                    Might repeat a card {matchWhere(candidate.similar)}; it couldn't be checked.
                  </span>
                {/if}
                {#if problems[i]}<span class="problem">{problems[i]}</span>{/if}
              </div>
              <button
                type="button"
                class="chrome-button remove"
                aria-label="Leave this card out"
                title="Leave this card out"
                onclick={() => cards.splice(i, 1)}>×</button
              >
            </li>
          {/each}
        </ol>
      {:else}
        <p class="empty">Every card the model wrote repeats one you have. Bring one back below, or close and try another focus.</p>
      {/if}

      {#if filtered.length}
        <details class="tray">
          <summary>
            {plural(filtered.length, 'card')} left out as duplicates{#if upgrades.length}{' · '}{plural(upgrades.length, 'card')} in
              the deck will go both ways{/if}
          </summary>
          <ul>
            {#each filtered as entry (entry.key)}
              <li class="left-out">
                <div class="pair">
                  <div class="new-card">
                    <span class="tag">{typeName(entry.type)}</span>
                    <div class="mini">{@html cardHtml(entry.front)}</div>
                  </div>
                  {#if entry.match}
                    <div class="matched">
                      <span class="why">{leftOutWhy(entry)}</span>
                      <div class="mini">{@html cardHtml(entry.match.front)}</div>
                      <span class="where">{typeName(entry.match.type)}, {matchWhere(entry.match)}</span>
                    </div>
                  {/if}
                </div>
                <div class="actions">
                  {#if entry.status === 'reverse' && entry.match?.existing}
                    <label class="check small">
                      <input type="checkbox" bind:checked={entry.upgrade} />
                      <span>Make that card Basic and reversed</span>
                    </label>
                  {/if}
                  <button type="button" class="link" onclick={() => bringBack(entry)}>Bring back</button>
                </div>
              </li>
            {/each}
          </ul>
        </details>
      {/if}

      {#if error}<p class="problem" role="alert">{error}</p>{/if}

      <footer>
        <button type="button" class="secondary" onclick={() => (step = 'setup')}>Back</button>
        <button type="button" class="primary" disabled={(!cards.length && !upgrades.length) || problems.some(Boolean) || saving} onclick={add}>
          {cards.length || !upgrades.length ? `Add ${plural(cards.length, 'card')} to deck` : `Upgrade ${plural(upgrades.length, 'card')}`}
        </button>
      </footer>
    {:else}
      <p class="done">
        {#if added.cards}Added {plural(added.cards, 'card')} to the deck.{/if}
        {#if added.upgraded}{plural(added.upgraded, 'card')} in it now {added.upgraded === 1 ? 'goes' : 'go'} both ways.{/if}
        Export the deck for Anki from Flashcards in the topic's ⋮ menu.
      </p>
      <footer>
        <button type="button" class="secondary" onclick={() => onopendeck?.()}>Open the deck</button>
        <button type="button" class="primary" onclick={onclose}>Done</button>
      </footer>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: grid;
    place-items: center;
    padding: 1rem;
    background: rgb(0 0 0 / 0.35);
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    width: min(32rem, 100%);
    max-height: 100%;
    box-sizing: border-box;
    overflow-y: auto;
    padding: 1rem 1.25rem 1.25rem;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: var(--surface);
    box-shadow: 0 16px 48px rgb(0 0 0 / 0.3);
  }
  .card.wide {
    width: min(44rem, 100%);
  }
  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font-size: 1.1rem;
  }
  .sub {
    margin: 0.125rem 0 0;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .close {
    font-size: 1.25rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    border: none;
  }
  .label {
    padding: 0;
    font-size: 0.9rem;
    font-weight: 600;
  }
  .optional,
  .hint {
    font-size: 0.8rem;
    font-weight: normal;
    color: var(--muted);
  }
  .about {
    font-size: 0.9rem;
  }
  blockquote {
    margin: 0.25rem 0 0;
    padding: 0.375rem 0.625rem;
    border-left: 3px solid var(--border);
    color: var(--muted);
    font-size: 0.85rem;
    white-space: pre-line;
  }
  input[type='text'],
  input[type='number'] {
    padding: 0.4rem 0.625rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: inherit;
    font: inherit;
    font-size: 0.9rem;
  }
  input[type='number'] {
    width: 5rem;
  }
  input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: var(--ring);
  }
  .check {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.5rem;
    font-size: 0.9rem;
    cursor: pointer;
  }
  .check input {
    accent-color: var(--accent);
  }
  .check.small {
    font-size: 0.8rem;
  }
  .notice {
    margin: 0;
    padding: 0.5rem 0.625rem;
    border-radius: var(--radius);
    background: var(--hover);
    color: var(--muted);
    font-size: 0.8rem;
  }
  .problem {
    margin: 0;
    color: var(--danger);
    font-size: 0.8rem;
  }
  .warning {
    color: var(--muted);
    font-style: italic;
  }
  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .pickers {
    display: flex;
    gap: 0.25rem;
    font-size: 0.85rem;
  }
  .primary,
  .secondary {
    padding: 0.4rem 0.875rem;
    border: 1px solid transparent;
    border-radius: var(--radius);
    font: inherit;
    font-size: 0.9rem;
    cursor: pointer;
  }
  .primary {
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .primary:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .secondary {
    border-color: var(--border);
    background: none;
    color: inherit;
  }
  .secondary:hover {
    background: var(--hover);
  }
  .primary:focus-visible,
  .secondary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .busy {
    margin: 0;
    font-size: 0.9rem;
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.5;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .busy {
      animation: none;
    }
  }
  .steps {
    margin: 0.5rem 0 0;
    padding-left: 1.25rem;
    color: var(--muted);
    font-size: 0.8rem;
  }
  .previews {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .preview {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.5rem 2rem 0.5rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
  }
  .remove {
    position: absolute;
    top: 0.25rem;
    right: 0.25rem;
    color: var(--muted);
    font-size: 1.1rem;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    padding-left: 6rem;
    font-size: 0.8rem;
  }
  .link {
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
  .empty,
  .done {
    margin: 0;
    font-size: 0.9rem;
  }
  .tray {
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    font-size: 0.85rem;
  }
  .tray summary {
    padding: 0.5rem 0.75rem;
    color: var(--muted);
    cursor: pointer;
  }
  .tray ul {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0;
    padding: 0 0.75rem 0.75rem;
    list-style: none;
  }
  .left-out {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border);
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }
  .new-card,
  .matched {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }
  .tag,
  .why,
  .where {
    color: var(--muted);
    font-size: 0.75rem;
  }
  .mini {
    overflow-wrap: anywhere;
  }
  .mini :global(p) {
    margin: 0;
  }
  .mini :global(.cloze) {
    color: var(--accent);
    font-weight: 600;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: flex-end;
    gap: 0.5rem 1rem;
  }
</style>
