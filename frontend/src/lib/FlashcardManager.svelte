<script lang="ts">
  import CardEditor from './CardEditor.svelte'
  import type { Pick } from './context'
  import {
    type Card,
    type CardDraft,
    cardHtml,
    cardProblem,
    type DeckView,
    deleteCard,
    download,
    editCard,
    exportDeck,
    fetchDeck,
    sideNames,
    sourceLabel,
    typeName,
    typesFor,
  } from './flashcards'
  import type { Topic, Workspace } from './workspace.svelte'

  type Props = {
    workspace: Workspace
    /** The topic whose deck is shown. */
    topic: Topic
    onclose: () => void
    /** Show the page a card comes from. */
    onreveal?: (target: Pick & { docId: string }) => void
  }

  let { workspace, topic, onclose, onreveal }: Props = $props()

  let deck = $state<DeckView>()
  let error = $state('')
  let query = $state('')
  let editingId = $state<string>()
  let draft = $state<CardDraft>()
  let busy = $state(false)
  // After an export: the cards deleted here since the one before, to delete in Anki too.
  let exported = $state<{ filename: string; deleted: DeckView['deleted'] }>()

  $effect(() => {
    fetchDeck(topic.id)
      .then((d) => (deck = d))
      .catch((e: unknown) => (error = e instanceof Error ? e.message : String(e)))
  })

  let card = $state<HTMLElement>()
  const returnTo = document.activeElement as HTMLElement | null
  $effect(() => {
    card?.querySelector<HTMLElement>('input')?.focus()
    return () => returnTo?.focus?.()
  })

  /** Newest first, narrowed to the cards with every word searched for. */
  const shown = $derived.by(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const cards = [...(deck?.cards ?? [])].reverse()
    if (!words.length) return cards
    return cards.filter((c) => {
      const text = `${c.front}\n${c.back}\n${c.extra}`.toLowerCase()
      return words.every((w) => text.includes(w))
    })
  })

  const problem = $derived(draft && cardProblem(draft))

  async function run(action: () => Promise<DeckView>) {
    busy = true
    error = ''
    try {
      deck = await action()
      return true
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      return false
    } finally {
      busy = false
    }
  }

  function startEdit(c: Card) {
    editingId = c.id
    draft = { type: c.type, front: c.front, back: c.back, extra: c.extra, source: c.source }
  }

  async function save() {
    if (!editingId || !draft || problem || busy) return
    const id = editingId
    const changes = $state.snapshot(draft)
    if (await run(() => editCard(topic.id, id, changes))) editingId = draft = undefined
  }

  async function remove(c: Card) {
    const inAnki = c.last_exported_at !== null
    if (!confirm(inAnki ? 'Delete this card? It is in Anki too, so delete it there as well.' : 'Delete this card?')) return
    if (editingId === c.id) editingId = draft = undefined
    await run(() => deleteCard(topic.id, c.id))
  }

  async function exportForAnki() {
    if (busy) return
    busy = true
    error = ''
    const deleted = deck?.deleted ?? []
    try {
      const { blob, filename } = await exportDeck(topic.id, topic.name)
      download(blob, filename)
      exported = { filename, deleted }
      deck = await fetchDeck(topic.id)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
    }
  }

  function reveal(c: Card) {
    const doc = c.source?.doc_id && workspace.docOfServerId(topic.id, c.source.doc_id)
    const page = c.source?.pages[0]
    if (doc && page) onreveal?.({ docId: doc, page })
  }

  function status(c: Card): string | undefined {
    if (c.last_exported_at === null) return 'Not in Anki yet'
    if (c.updated_at > c.last_exported_at) return 'Edited since export'
    return undefined
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    // Escape first leaves an edit, then closes.
    if (editingId) editingId = draft = undefined
    else onclose()
  }

  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

  function changesLine(view: DeckView): string {
    if (view.exported_at === null) return view.cards.length ? 'Not exported yet' : ''
    const { new: added, edited, deleted } = view.changes
    if (!added && !edited && !deleted) return 'Anki has every change'
    return `Since the last export: ${added} new, ${edited} edited, ${deleted} deleted`
  }
</script>

<!-- Pressing the dimmed backdrop closes it, like Escape; the × does the same by keyboard. -->
<div class="backdrop flashcard-manager" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && onclose()} {onkeydown}>
  <div bind:this={card} class="card" role="dialog" aria-modal="true" aria-labelledby="flashcard-manager-title">
    <header>
      <div>
        <h2 id="flashcard-manager-title">Flashcards</h2>
        <p class="sub">
          {topic.name}{#if deck}{' · '}{plural(deck.cards.length, 'card')}{#if changesLine(deck)}{' · '}{changesLine(deck)}{/if}{/if}
        </p>
      </div>
      <button type="button" class="chrome-button close" aria-label="Close Flashcards" onclick={onclose}>×</button>
    </header>

    <div class="bar">
      <input type="search" bind:value={query} placeholder="Search cards" aria-label="Search cards" />
      <button type="button" class="primary" disabled={!deck?.cards.length || busy} onclick={exportForAnki}>Export for Anki</button>
    </div>

    {#if exported}
      <div class="notice" role="status">
        <p>
          Saved {exported.filename}. In Anki, choose File › Import and pick it: cards you already have are updated and keep
          their reviews, and new ones are added.
        </p>
        {#if exported.deleted.length}
          <p>Anki keeps cards deleted here, so delete {exported.deleted.length === 1 ? 'this one' : 'these'} there too:</p>
          <ul>{#each exported.deleted as d (d.id)}<li>{d.front}</li>{/each}</ul>
        {/if}
      </div>
    {:else if deck?.deleted.length}
      <details class="notice">
        <summary>{plural(deck.deleted.length, 'card')} deleted here {deck.deleted.length === 1 ? 'is' : 'are'} still in Anki</summary>
        <p>Exporting doesn't delete {deck.deleted.length === 1 ? 'it' : 'them'} there, so delete {deck.deleted.length === 1 ? 'it' : 'them'} in Anki too:</p>
        <ul>{#each deck.deleted as d (d.id)}<li>{d.front}</li>{/each}</ul>
      </details>
    {/if}

    {#if error}<p class="problem" role="alert">{error}</p>{/if}

    {#if !deck}
      {#if !error}<p class="empty">Loading…</p>{/if}
    {:else if !deck.cards.length}
      <p class="empty">
        No cards yet. Right-click a passage in a PDF and pick Make flashcards, or use the cards icon under an answer in the chat.
      </p>
    {:else if !shown.length}
      <p class="empty">No card has all of those words.</p>
    {:else}
      <ul class="cards">
        {#each shown as c (c.id)}
          {@const label = sourceLabel(c.source)}
          {@const note = status(c)}
          <li class="row">
            {#if editingId === c.id && draft}
              <CardEditor bind:card={draft} types={typesFor(c)} />
              {#if problem}<p class="problem">{problem}</p>{/if}
              <div class="edit-actions">
                <button type="button" class="secondary" onclick={() => (editingId = draft = undefined)}>Cancel</button>
                <button type="button" class="primary" disabled={!!problem || busy} onclick={save}>Save</button>
              </div>
            {:else}
              {@const names = sideNames(c.type)}
              <div class="sides">
                <span class="side-name">{names.front}</span>
                <div class="rendered">{@html cardHtml(c.front)}</div>
                {#if c.back.trim()}
                  <span class="side-name">{names.back}</span>
                  <div class="rendered">{@html cardHtml(c.back)}</div>
                {/if}
                {#if c.extra.trim()}
                  <span class="side-name">Extra</span>
                  <div class="rendered">{@html cardHtml(c.extra)}</div>
                {/if}
              </div>
              <div class="meta">
                <span>{typeName(c.type)}</span>
                {#if label}
                  <button type="button" class="link" title="Show this page" onclick={() => reveal(c)}>{label}</button>
                {/if}
                {#if note}<span class="status">{note}</span>{/if}
                <span class="spacer"></span>
                <button type="button" class="link" onclick={() => startEdit(c)}>Edit</button>
                <button type="button" class="link danger" onclick={() => remove(c)}>Delete</button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
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
    width: min(44rem, 100%);
    height: min(44rem, 100%);
    box-sizing: border-box;
    overflow-y: auto;
    padding: 1rem 1.25rem 1.25rem;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: var(--surface);
    box-shadow: 0 16px 48px rgb(0 0 0 / 0.3);
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
  .bar {
    display: flex;
    gap: 0.75rem;
  }
  input[type='search'] {
    flex: 1;
    min-width: 0;
    padding: 0.4rem 0.625rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: inherit;
    font: inherit;
    font-size: 0.9rem;
  }
  input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: var(--ring);
  }
  .primary,
  .secondary {
    padding: 0.4rem 0.875rem;
    border: 1px solid transparent;
    border-radius: var(--radius);
    font: inherit;
    font-size: 0.9rem;
    white-space: nowrap;
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
  .notice {
    margin: 0;
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius);
    background: var(--hover);
    font-size: 0.85rem;
  }
  .notice p {
    margin: 0 0 0.375rem;
  }
  .notice p:last-child {
    margin-bottom: 0;
  }
  .notice summary {
    cursor: pointer;
  }
  .notice ul {
    margin: 0;
    padding-left: 1.25rem;
    color: var(--muted);
  }
  .problem {
    margin: 0;
    color: var(--danger);
    font-size: 0.8rem;
  }
  .empty {
    margin: 0;
    color: var(--muted);
    font-size: 0.9rem;
  }
  .cards {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
  }
  .sides {
    display: grid;
    grid-template-columns: 5.5rem 1fr;
    gap: 0.25rem 0.5rem;
    font-size: 0.9rem;
    line-height: 1.45;
  }
  .side-name {
    padding-top: 0.1rem;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .rendered {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .rendered :global(p),
  .rendered :global(ul),
  .rendered :global(ol) {
    margin: 0 0 0.4em;
  }
  .rendered :global(:last-child) {
    margin-bottom: 0;
  }
  .rendered :global(ul),
  .rendered :global(ol) {
    padding-left: 1.25rem;
  }
  .rendered :global(.katex-display) {
    margin: 0.4em 0;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .rendered :global(.cloze) {
    padding: 0 0.2em;
    border-radius: 0.25rem;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    font-weight: 600;
  }
  .rendered :global(.cloze-hint) {
    color: var(--muted);
    font-size: 0.85em;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.75rem;
    color: var(--muted);
    font-size: 0.8rem;
  }
  .spacer {
    flex: 1;
  }
  .status {
    font-style: italic;
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
  .link.danger {
    color: var(--danger);
  }
  .edit-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
</style>
