<script lang="ts">
  import { type CitableDocs, renderMarkdown } from './markdown'
  import type { QuizQuestion } from './api'
  import type { Quiz } from './workspace.svelte'

  type Props = {
    quiz: Quiz
    /** The reader picked a choice for a question. Each question is answered once. */
    onpick: (question: number, choice: number) => void
    /** What the quiz's citations can point at, as in answers. */
    docs?: CitableDocs
  }

  let { quiz, onpick, docs }: Props = $props()

  const LETTERS = 'ABCDEFGH'
  const total = $derived(quiz.questions.length)

  // Which question is showing; `total` shows the results. Starts at the first one not yet
  // answered, so a quiz left halfway (or reloaded) carries on where it was.
  const firstOpen = () => {
    const i = quiz.picked.findIndex((p) => p === null)
    return i === -1 ? quiz.questions.length : i
  }
  let step = $state(firstOpen())

  let right = $derived(quiz.questions.filter((q, i) => quiz.picked[i] === q.answer).length)
  let question = $derived(quiz.questions[step])
  let picked = $derived(quiz.picked[step] ?? null)

  /** Markdown on one line: choices have no paragraphs of their own. */
  const inline = (text: string) => renderMarkdown(text, docs).replace(/^<p>|<\/p>\s*$/g, '')

  // The results ring: a circle whose coloured part is the share of right answers.
  const RADIUS = 15.5
  // Whether the ring fills up from empty: when the reader goes on to the results, not when a
  // finished quiz is shown again (after a reload or a topic switch).
  let filling = $state(false)
  // Whether the results show each question again with its choices and explanation.
  let details = $state(false)
</script>

{#snippet choices(q: QuizQuestion, chosen: number | null, live: boolean)}
  <div class="choices" role="group" aria-label="Choices">
    {#each q.choices as choice, i (i)}
      <button
        type="button"
        class="choice"
        class:right={chosen !== null && i === q.answer}
        class:wrong={chosen === i && i !== q.answer}
        aria-pressed={chosen === i}
        disabled={!live || chosen !== null}
        onclick={() => onpick(step, i)}
      >
        <span class="letter" aria-hidden="true">{LETTERS[i]}</span>
        <span class="body">
          <span class="markdown">{@html inline(choice)}</span>
          <!-- Once answered, each wrong choice says what mistake leads to it. -->
          {#if chosen !== null && i !== q.answer && q.misconceptions?.[i]}
            <span class="why markdown">{@html inline(q.misconceptions[i]!)}</span>
          {/if}
        </span>
      </button>
    {/each}
  </div>
{/snippet}

<div class="quiz" role="group" aria-label={`Quiz: ${quiz.title}`}>
  <div class="head">
    <span class="title">{quiz.title}</span>
    <span class="progress">{step < total ? `Question ${step + 1} of ${total}` : 'Results'}</span>
  </div>

  {#if question}
    <div class="question markdown">{@html renderMarkdown(question.question, docs)}</div>
    {@render choices(question, picked, true)}
    {#if picked !== null}
      <div class="feedback" role="status">
        <p class="verdict" class:right={picked === question.answer}>
          {picked === question.answer ? 'Right.' : `Not quite: the answer is ${LETTERS[question.answer]}.`}
        </p>
        <div class="markdown">{@html renderMarkdown(question.explanation, docs)}</div>
        <button type="button" class="next" onclick={() => ((step += 1), (filling = step === total))}>
          {step + 1 < total ? 'Next question' : 'See results'}
        </button>
      </div>
    {/if}
  {:else}
    <div class="score" role="img" aria-label={`You got ${right} of ${total} right`}>
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <circle class="track" cx="18" cy="18" r={RADIUS} />
        {#if right > 0}
          <circle
            class="done"
            class:filling
            cx="18"
            cy="18"
            r={RADIUS}
            pathLength="100"
            stroke-dasharray={`${(100 * right) / total} 100`}
          />
        {/if}
      </svg>
      <span class="fraction" aria-hidden="true">{right}/{total}</span>
    </div>
    {#if right === total}
      <p class="advice">Every answer right.</p>
    {:else if quiz.recommendation}
      <div class="advice">
        <span class="label">What to review</span>
        <div class="markdown">{@html renderMarkdown(quiz.recommendation, docs)}</div>
      </div>
    {:else if quiz.reviewing === 'writing'}
      <p class="advice muted">Writing a note on what to review…</p>
    {:else if quiz.reviewing === 'failed'}
      <p class="advice muted">Could not write a note on what to review.</p>
    {/if}
    <button type="button" class="details-toggle" aria-expanded={details} onclick={() => (details = !details)}>
      {details ? 'Hide details' : 'Details'}
    </button>
    {#if details}
      <ol class="details">
        {#each quiz.questions as q, i (i)}
          {@const choice = quiz.picked[i] ?? null}
          <li>
            <div class="question markdown">
              <span class="mark" class:right={choice === q.answer} aria-label={choice === q.answer ? 'Right' : 'Wrong'}
                >{choice === q.answer ? '✓' : '✗'}</span
              >
              {@html renderMarkdown(q.question, docs)}
            </div>
            {@render choices(q, choice, false)}
            <div class="markdown explanation">{@html renderMarkdown(q.explanation, docs)}</div>
          </li>
        {/each}
      </ol>
    {/if}
  {/if}
</div>

<style>
  .quiz {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5rem;
  }
  .title {
    font-weight: 600;
  }
  .progress {
    flex-shrink: 0;
    color: var(--muted);
    font-size: 0.75rem;
  }

  .markdown :global(p) {
    margin: 0 0 0.4rem;
  }
  .markdown :global(p:last-child) {
    margin-bottom: 0;
  }

  .choices {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  /* Rows like the chat's menus: a frame, a shade on hover, green or red once answered. */
  .choice {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.4rem 0.55rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .choice:hover:not(:disabled) {
    background: var(--hover);
  }
  .choice:focus-visible,
  .next:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .choice:disabled {
    cursor: default;
  }
  .choice:disabled:not(.right):not(.wrong) {
    color: var(--muted);
  }
  .choice.right {
    border-color: var(--right);
    background: color-mix(in srgb, var(--right) 10%, var(--surface));
  }
  .choice.wrong {
    border-color: var(--danger);
    background: color-mix(in srgb, var(--danger) 10%, var(--surface));
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .why {
    font-size: 0.85em;
    color: var(--muted);
  }
  .choice.wrong .why {
    color: inherit;
  }
  .letter {
    flex-shrink: 0;
    font-weight: 600;
    color: var(--muted);
  }

  .feedback {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .verdict {
    margin: 0;
    font-weight: 600;
    color: var(--danger);
  }
  .verdict.right {
    color: var(--right);
  }
  .next {
    align-self: flex-start;
    padding: 0.3rem 0.75rem;
    border: none;
    border-radius: var(--radius);
    background: var(--quiz);
    color: #fff;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .score {
    position: relative;
    align-self: center;
    width: 5.5rem;
    height: 5.5rem;
    margin: 0.25rem 0;
  }
  .score svg {
    width: 100%;
    height: 100%;
    transform: rotate(-90deg);
  }
  .score circle {
    fill: none;
    stroke-width: 3.5;
  }
  .score .track {
    stroke: var(--border);
  }
  .score .done {
    stroke: var(--right);
    stroke-linecap: round;
  }
  .score .done.filling {
    animation: fill 0.9s 0.15s cubic-bezier(0.33, 1, 0.68, 1) backwards;
  }
  @keyframes fill {
    from {
      stroke-dasharray: 0 100;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .score .done.filling {
      animation: none;
    }
  }
  .fraction {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font-size: 1.25rem;
    font-weight: 600;
  }

  .details-toggle {
    align-self: flex-start;
    padding: 0.2rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: inherit;
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .details-toggle:hover {
    background: var(--hover);
  }
  .details-toggle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .details {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .details li {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .mark {
    float: left;
    width: 1.1rem;
    font-weight: 700;
    color: var(--danger);
  }
  .mark.right {
    color: var(--right);
  }
  .explanation {
    color: var(--muted);
    font-size: 0.9em;
  }

  .advice {
    margin: 0;
    padding: 0.5rem 0.6rem;
    border-left: 3px solid var(--quiz);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--quiz) 8%, transparent);
  }
  .advice.muted {
    color: var(--muted);
  }
  .advice .label {
    display: block;
    margin-bottom: 0.15rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--quiz);
  }
</style>
