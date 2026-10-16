<script lang="ts">
  import { saveZoomFollowsChat } from './chatZoom'
  import { applyTheme, savedTheme, THEMES, type Theme } from './theme'
  import type { Workspace } from './workspace.svelte'

  type Props = {
    workspace: Workspace
    /** Whether the PDF's zoom follows the chat opening and closing. */
    zoomFollowsChat: boolean
    onclose: () => void
  }

  let { workspace, zoomFollowsChat = $bindable(), onclose }: Props = $props()

  let theme = $state<Theme>(savedTheme())

  function pick(next: Theme) {
    theme = next
    applyTheme(next)
  }

  function pickZoom(follow: boolean) {
    zoomFollowsChat = follow
    saveZoomFollowsChat(follow)
  }

  let card = $state<HTMLElement>()
  // Back to wherever focus was (the Settings button) once it closes.
  const returnTo = document.activeElement as HTMLElement | null
  $effect(() => {
    card?.querySelector('textarea')?.focus()
    return () => returnTo?.focus?.()
  })

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onclose()
    }
  }
</script>

<!-- Pressing the dimmed backdrop closes it, like Escape; the × does the same by keyboard. -->
<div
  class="backdrop settings-dialog"
  role="presentation"
  onpointerdown={(e) => e.target === e.currentTarget && onclose()}
  {onkeydown}
>
  <div bind:this={card} class="card" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <header>
      <h2 id="settings-title">Settings</h2>
      <button type="button" class="chrome-button close" aria-label="Close settings" onclick={onclose}>×</button>
    </header>

    <label class="field">
      <span class="label">Instructions for every answer</span>
      <span class="hint">Added to what the model is told in every topic, like “Answer in Swedish” or “I'm preparing for an exam”.</span>
      <textarea rows="6" bind:value={workspace.instructions} placeholder="Nothing yet"></textarea>
    </label>

    <div class="field">
      <span class="label" id="theme-label">Theme</span>
      <div class="segments" role="radiogroup" aria-labelledby="theme-label">
        {#each THEMES as t (t.id)}
          <button type="button" role="radio" aria-checked={theme === t.id} onclick={() => pick(t.id)}>{t.name}</button>
        {/each}
      </div>
    </div>

    <div class="field">
      <span class="label" id="zoom-label">PDF size with the chat</span>
      <span class="hint">
        {zoomFollowsChat
          ? 'The PDF opens a little bigger and shrinks to fit beside the chat when it opens, then grows back.'
          : 'The PDF keeps one size that already leaves room for the chat beside it.'}
      </span>
      <div class="segments" role="radiogroup" aria-labelledby="zoom-label">
        <button type="button" role="radio" aria-checked={zoomFollowsChat} onclick={() => pickZoom(true)}>Fit to chat</button>
        <button type="button" role="radio" aria-checked={!zoomFollowsChat} onclick={() => pickZoom(false)}>Fixed size</button>
      </div>
    </div>
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
    gap: 1.25rem;
    width: min(30rem, 100%);
    max-height: 100%;
    box-sizing: border-box;
    overflow-y: auto;
    padding: 1rem 1.25rem 1.5rem;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: var(--surface);
    box-shadow: 0 16px 48px rgb(0 0 0 / 0.3);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font-size: 1.1rem;
  }
  .close {
    font-size: 1.25rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .label {
    font-size: 0.9rem;
    font-weight: 600;
  }
  .hint {
    font-size: 0.8rem;
    color: var(--muted);
  }
  textarea {
    margin-top: 0.25rem;
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: inherit;
    font: inherit;
    font-size: 0.9rem;
    resize: vertical;
  }
  textarea:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: var(--ring);
  }
  /* Three buttons joined into one control, the picked one raised. */
  .segments {
    display: flex;
    gap: 0.125rem;
    width: fit-content;
    margin-top: 0.25rem;
    padding: 0.1875rem;
    border-radius: 0.5rem;
    background: var(--hover);
  }
  .segments button {
    padding: 0.25rem 0.875rem;
    border: none;
    border-radius: var(--radius);
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .segments button:hover {
    color: inherit;
  }
  .segments button[aria-checked='true'] {
    background: var(--surface);
    color: inherit;
    font-weight: 600;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.15);
  }
  .segments button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
</style>
