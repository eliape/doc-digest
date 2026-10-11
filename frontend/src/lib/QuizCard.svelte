<script lang="ts">
  import { type CitableDocs, renderMarkdown } from './markdown'
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

  /** Markdown on one line: choices and question titles have no paragraphs of their own. */
  const inline = (text: string) => renderMarkdown(text, docs).replace(/^<p>|<\/p>\s*$/g, '')
</script>

<div class="quiz" role="group" aria-label={`Quiz: ${quiz.title}`}>
  <div class="head">
    <span class="title">{quiz.title}</span>
    <span class="progress">{step < total ? `Question ${step + 1} of ${total}` : 'Results'}</span>
  </div>

  {#if question}
    <div class="question markdown">{@html renderMarkdown(question.question, docs)}</div>
    <div class="choices" role="group" aria-label="Choices">
      {#each question.choices as choice, i (i)}
        <button
          type="button"
          class="choice"
          class:right={picked !== null && i === question.answer}
          class:wrong={picked === i && i !== question.answer}
          aria-pressed={picked === i}
          disabled={picked !== null}
          onclick={() => onpick(step, i)}
        >
          <span class="letter" aria-hidden="true">{LETTERS[i]}</span>
          <span class="markdown">{@html inline(choice)}</span>
        </button>
      {/each}
    </div>
    {#if picked !== null}
      <div class="feedback" role="status">
        <p class="verdict" class:right={picked === question.answer}>
          {picked === question.answer ? 'Right.' : `Not quite: the answer is ${LETTERS[question.answer]}.`}
        </p>
        <div class="markdown">{@html renderMarkdown(question.explanation, docs)}</div>
        <button type="button" class="next" onclick={() => (step += 1)}>
          {step + 1 < total ? 'Next question' : 'See results'}
        </button>
      </div>
    {/if}
  {:else}
    <p class="score">You got {right} of {total} right.</p>
    <ol class="summary">
      {#each quiz.questions as q, i (i)}
        {@const choice = quiz.picked[i]}
        <li class:right={choice === q.answer}>
          <span class="mark" aria-label={choice === q.answer ? 'Right' : 'Wrong'}>{choice === q.answer ? '✓' : '✗'}</span>
          <span>
            <span class="markdown">{@html inline(q.question)}</span>
            {#if choice !== null && choice !== q.answer}
              <span class="detail">
                You said {LETTERS[choice]}, the answer is {LETTERS[q.answer]}:
                <span class="markdown">{@html inline(q.choices[q.answer])}</span>
              </span>
            {/if}
          </span>
        </li>
      {/each}
    </ol>
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
    margin: 0;
    font-weight: 600;
  }
  .summary {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .summary li {
    display: flex;
    gap: 0.4rem;
  }
  .mark {
    flex-shrink: 0;
    width: 1rem;
    font-weight: 700;
    color: var(--danger);
  }
  .summary li.right .mark {
    color: var(--right);
  }
  .detail {
    display: block;
    color: var(--muted);
    font-size: 0.85em;
  }
  .summary .markdown,
  .detail .markdown {
    display: inline;
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
