<script lang="ts">
  import { tick } from 'svelte'
  import { fade } from 'svelte/transition'
  import type { Heading } from './context'
  import { currentEntry } from './outline'

  type Props = {
    /** The chapters and sections, or undefined while they load. */
    entries?: Heading[]
    /** What to say when there are no entries. */
    empty: string
    /** The page being read, to mark the section it is in. */
    page: number
    /** Called with the page of the entry clicked. */
    ongo: (page: number) => void
    onclose: () => void
  }

  let { entries, empty, page, ongo, onclose }: Props = $props()

  // Fades in and out as it is toggled, or just appears for those who prefer less motion.
  const fadeMs = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 180

  let list = $state<HTMLElement>()
  let current = $derived(entries ? currentEntry(entries, page) : -1)

  // Open at the section being read.
  $effect(() => {
    if (!entries?.length || !list) return
    const el = list
    tick().then(() => el.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: 'center' }))
  })
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<nav
  id="doc-outline"
  class="outline"
  aria-label="Outline"
  transition:fade|global={{ duration: fadeMs }}
  onkeydown={(e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onclose()
    }
  }}
>
  {#if entries?.length}
    <ol bind:this={list}>
      {#each entries as entry, i (i)}
        <li>
          <button
            type="button"
            class="level-{entry.level}"
            aria-current={i === current}
            title={entry.title}
            onclick={() => ongo(entry.page)}>{entry.title}</button
          >
        </li>
      {/each}
    </ol>
  {:else if entries}
    <p class="empty">{empty}</p>
  {/if}
</nav>

<style>
  /* Hovers over the PDF below the toggle: gray on the left, fading out to the right. */
  .outline {
    --outline-fade: #d6dbe1;
    --outline-text: #3d444d;
    position: absolute;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 6;
    width: min(26rem, 85%);
    overflow-y: auto;
    padding: 0.5rem 4rem 1rem 0.5rem;
    background: linear-gradient(
      to right,
      color-mix(in srgb, var(--outline-fade) 97%, transparent) 0%,
      color-mix(in srgb, var(--outline-fade) 85%, transparent) 55%,
      transparent 100%
    );
    color: var(--outline-text);
    font-size: 0.9rem;
    scrollbar-width: thin;
  }
  @media (prefers-color-scheme: dark) {
    .outline {
      --outline-fade: #2d333b;
      --outline-text: #c9d1d9;
    }
  }

  ol {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  button {
    display: block;
    width: 100%;
    padding: 0.25rem 0.5rem;
    border: none;
    border-radius: var(--radius);
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    line-height: 1.3;
    cursor: pointer;
  }
  button:hover {
    background: color-mix(in srgb, currentColor 10%, transparent);
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  /* The section being read: a band in the accent colour with a bar on its left edge. */
  button[aria-current='true'] {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    box-shadow: inset 3px 0 0 var(--accent);
    color: color-mix(in srgb, var(--accent) 70%, var(--outline-text));
    font-weight: 600;
  }
  button[aria-current='true']:hover {
    background: color-mix(in srgb, var(--accent) 24%, transparent);
  }

  .level-1 {
    margin-top: 0.25rem;
    font-weight: 500;
  }
  .level-2 {
    padding-left: 1.25rem;
  }
  .level-3,
  .level-4,
  .level-5 {
    padding-left: 2rem;
    font-size: 0.85rem;
  }

  .empty {
    margin: 0.25rem 0.5rem;
  }
</style>
