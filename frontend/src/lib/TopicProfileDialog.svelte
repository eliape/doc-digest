<script lang="ts">
  import type { Topic } from './workspace.svelte'

  type Props = {
    /** The topic whose scope and conventions are edited. Changes are saved as they are typed. */
    topic: Topic
    onclose: () => void
  }

  let { topic, onclose }: Props = $props()

  let card = $state<HTMLElement>()
  // Back to wherever focus was once it closes.
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
  class="backdrop topic-profile-dialog"
  role="presentation"
  onpointerdown={(e) => e.target === e.currentTarget && onclose()}
  {onkeydown}
>
  <div bind:this={card} class="card" role="dialog" aria-modal="true" aria-labelledby="topic-profile-title">
    <header>
      <div>
        <h2 id="topic-profile-title">Scope and conventions</h2>
        <p class="topic-name">{topic.name}</p>
      </div>
      <button type="button" class="chrome-button close" aria-label="Close scope and conventions" onclick={onclose}>×</button>
    </header>

    <label class="field">
      <span class="label">Syllabus / scope</span>
      <span class="hint">What the topic covers and what you study it for. Paste the course syllabus or the chapters on the exam, or write something like “Exam in TMA4100 on 12 December” or “Background for my thesis”.</span>
      <textarea rows="7" bind:value={topic.scope} placeholder="Nothing yet"></textarea>
    </label>

    <label class="field">
      <span class="label">Conventions</span>
      <span class="hint">Notation and conventions answers should follow, like “j is the imaginary unit” or “Clockwise torque is positive”.</span>
      <textarea rows="5" bind:value={topic.conventions} placeholder="Nothing yet"></textarea>
    </label>
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
    width: min(34rem, 100%);
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
    align-items: flex-start;
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font-size: 1.1rem;
  }
  .topic-name {
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
</style>
