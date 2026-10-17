<script lang="ts">
  import { tick } from 'svelte'
  import { type CardDraft, type CardType, cardHtml, sideNames, typeName } from './flashcards'

  type Props = {
    /** The card, changed in place as it is edited. */
    card: CardDraft
    /** The types it can switch to. */
    types: CardType[]
  }

  let { card = $bindable(), types }: Props = $props()

  type Field = 'front' | 'back' | 'extra'

  // Each side shows rendered, like answers do, and turns into a text box when clicked.
  let editing = $state<Field>()
  let root = $state<HTMLElement>()
  const names = $derived(sideNames(card.type))
  const sides = $derived<{ field: Field; name: string }[]>([
    { field: 'front', name: names.front },
    { field: 'back', name: names.back },
    // Most cards have no extra, so it only shows once there is some.
    ...(card.extra.trim() || editing === 'extra' ? [{ field: 'extra' as const, name: 'Extra' }] : []),
  ])

  async function edit(field: Field) {
    editing = field
    await tick()
    root?.querySelector<HTMLTextAreaElement>(`textarea[data-field="${field}"]`)?.focus()
  }

  function onSideKeydown(event: KeyboardEvent, field: Field) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    edit(field)
  }

  function onTextKeydown(event: KeyboardEvent) {
    // Escape only stops editing, not the dialog around it.
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    ;(event.currentTarget as HTMLElement).blur()
  }

  const rows = (text: string) => Math.min(10, Math.max(2, text.split('\n').length + Math.floor(text.length / 70)))
</script>

<div class="card-editor" bind:this={root}>
  <div class="sides">
    {#each sides as side (side.field)}
      <div class="side">
        <span class="side-name">{side.name}</span>
        {#if editing === side.field}
          <textarea
            data-field={side.field}
            rows={rows(card[side.field])}
            bind:value={card[side.field]}
            onblur={() => (editing = undefined)}
            onkeydown={onTextKeydown}
          ></textarea>
        {:else}
          <!-- Rendered Markdown and LaTeX; cardHtml sanitizes it. Click (or Enter) to edit. -->
          <div
            class="rendered"
            class:empty={!card[side.field].trim()}
            role="button"
            tabindex="0"
            title="Click to edit"
            onclick={() => edit(side.field)}
            onkeydown={(e) => onSideKeydown(e, side.field)}
          >
            {#if card[side.field].trim()}{@html cardHtml(card[side.field])}{:else}Nothing yet{/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
  <div class="tools">
    {#if types.length > 1}
      <select aria-label="Card type" bind:value={card.type}>
        {#each types as type (type)}<option value={type}>{typeName(type)}</option>{/each}
      </select>
    {:else}
      <span class="type">{typeName(card.type)}</span>
    {/if}
    {#if !card.extra.trim() && editing !== 'extra'}
      <button type="button" class="link" onclick={() => edit('extra')}>Add extra</button>
    {/if}
  </div>
</div>

<style>
  .card-editor {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    min-width: 0;
  }
  .sides {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .side {
    display: grid;
    grid-template-columns: 5.5rem 1fr;
    gap: 0.5rem;
    align-items: start;
  }
  .side-name {
    padding-top: 0.3rem;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .rendered,
  textarea {
    min-width: 0;
    box-sizing: border-box;
    padding: 0.25rem 0.5rem;
    border: 1px solid transparent;
    border-radius: var(--radius);
    font-size: 0.9rem;
    line-height: 1.45;
  }
  .rendered {
    cursor: text;
    overflow-wrap: anywhere;
  }
  .rendered:hover {
    border-color: var(--border);
  }
  .rendered:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: var(--ring);
  }
  .rendered.empty {
    color: var(--muted);
    font-style: italic;
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
  .rendered :global(code) {
    padding: 0.05em 0.3em;
    border-radius: 0.25rem;
    background: var(--hover);
    font-size: 0.85em;
  }
  .rendered :global(.katex-display) {
    margin: 0.4em 0;
    overflow-x: auto;
    overflow-y: hidden;
  }
  /* A cloze card's gaps, as Anki will hide them. */
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
  textarea {
    width: 100%;
    border-color: var(--accent);
    background: var(--surface);
    color: inherit;
    font-family: inherit;
    resize: vertical;
    box-shadow: var(--ring);
  }
  textarea:focus {
    outline: none;
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding-left: 6rem;
    font-size: 0.8rem;
  }
  select {
    padding: 0.125rem 0.25rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: inherit;
    font: inherit;
  }
  .type {
    color: var(--muted);
  }
  .link {
    padding: 0;
    border: none;
    background: none;
    color: var(--muted);
    font: inherit;
    cursor: pointer;
  }
  .link:hover {
    color: var(--accent);
    text-decoration: underline;
  }
</style>
