import { fireEvent, render, screen, within } from '@testing-library/svelte'
import { tick } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import ChatPanel from './ChatPanel.svelte'
import type { PageContext } from './context'
import { chatOf, Workspace } from './workspace.svelte'

function setup() {
  const workspace = new Workspace()
  const doc = workspace.addDoc('notes.pdf', new Uint8Array([1]))
  const topic = workspace.activeTopic!
  const context: PageContext = {
    docId: doc.id,
    docName: 'notes.pdf',
    page: 12,
    pageLabel: '10',
    point: { x: 0.5, y: 0.5 },
    thumbnail: 'data:image/jpeg;base64,AAAA',
    pageTexts: [],
  }
  const onreveal = vi.fn()
  render(ChatPanel, { workspace, open: true, onreveal })
  return { workspace, topic, context, onreveal, panel: within(screen.getByRole('complementary', { name: 'Chat' })) }
}

describe('ChatPanel', () => {
  it('shows the attached spot above the question box, and removes it with × or Escape', async () => {
    const { workspace, topic, context, onreveal, panel } = setup()
    workspace.attachContext(topic.id, context)
    const chip = await panel.findByRole('button', { name: 'p. 10' })
    expect(panel.getByLabelText('Ask a question')).toHaveAttribute('placeholder', 'Ask about p. 10…')

    await fireEvent.click(chip)
    expect(onreveal).toHaveBeenCalledWith(expect.objectContaining({ page: 12 }))

    await fireEvent.click(panel.getByRole('button', { name: 'Remove from your question' }))
    expect(topic.context).toBeUndefined()

    workspace.attachContext(topic.id, context)
    const box = panel.getByLabelText('Ask a question')
    box.focus()
    await fireEvent.keyDown(box, { key: 'Escape' })
    expect(topic.context).toBeUndefined()
    // The panel stays open: the first Escape only removed the spot.
    expect(screen.getByRole('complementary', { name: 'Chat' }).inert).toBe(false)
  })

  it('keeps what was typed when a spot is attached', async () => {
    const { workspace, topic, context, panel } = setup()
    await fireEvent.input(panel.getByLabelText('Ask a question'), { target: { value: 'my own words' } })
    workspace.attachContext(topic.id, context)
    await panel.findByRole('button', { name: 'p. 10' })
    expect(panel.getByLabelText('Ask a question')).toHaveValue('my own words')
  })

  it('streams the answer under the question, which keeps its chip', async () => {
    const { workspace, topic, context, panel } = setup()
    let finish!: () => void
    vi.spyOn(workspace, 'ask').mockImplementation((id) =>
      Workspace.prototype.ask.call(workspace, id, undefined, async function* () {
        yield { type: 'step', text: 'Read book.pdf, p. 4' }
        yield { type: 'text', text: 'Partial' }
        await new Promise<void>((resolve) => (finish = resolve))
        yield { type: 'text', text: ' answer.' }
      }),
    )
    workspace.attachContext(topic.id, context)
    await fireEvent.input(panel.getByLabelText('Ask a question'), { target: { value: 'Why?' } })
    await fireEvent.click(panel.getByRole('button', { name: 'Send' }))

    const log = panel.getByRole('log')
    expect(await within(log).findByText('Partial')).toBeInTheDocument()
    expect(within(log).getByText('Read book.pdf, p. 4')).toBeInTheDocument()
    expect(within(log).getByRole('button', { name: 'p. 10' })).toBeInTheDocument()
    expect(panel.getByRole('button', { name: 'Send' })).toBeDisabled()
    finish()
    expect(await within(log).findByText('Partial answer.')).toBeInTheDocument()
  })

  it('shows no chip on a question about the open page, only on one about a spot', async () => {
    const { topic, context, panel } = setup()
    chatOf(topic).messages.push(
      { id: 'q1', role: 'user', text: 'About the page', context: { ...context, point: undefined } },
      { id: 'q2', role: 'user', text: 'About the spot', context },
    )
    const log = await panel.findByRole('log')
    expect(within(log).getAllByRole('button', { name: 'p. 10' })).toHaveLength(1)
    expect(log.querySelectorAll('.message')[0].querySelector('.chip')).toBeNull()
  })

  it('shows answers as Markdown with typeset maths, and questions as typed', async () => {
    const { topic, panel } = setup()
    chatOf(topic).messages.push(
      { id: 'q', role: 'user', text: 'What is **this** $x$?' },
      { id: 'a', role: 'assistant', text: 'It is **the variance**:\n\n$$\\sigma^2 = E[(X-\\mu)^2]$$' },
    )
    const log = await panel.findByRole('log')
    expect(log.querySelector('.user')).toHaveTextContent('What is **this** $x$?')
    expect(log.querySelector('.assistant strong')).toHaveTextContent('the variance')
    expect(log.querySelector('.assistant .katex-display')).not.toBeNull()
  })

  it('clears the chat with New chat, keeping the attached spot but not Socratic mode, and is disabled while the chat is empty', async () => {
    const { workspace, topic, context, panel } = setup()
    const button = panel.getByRole('button', { name: 'New chat' })
    expect(button).toBeDisabled()
    chatOf(topic).messages.push({ id: 'q', role: 'user', text: 'What is this?' })
    workspace.attachContext(topic.id, context)
    workspace.setMode(topic.id, 'socratic')
    await fireEvent.click(await panel.findByRole('button', { name: 'New chat' }))
    expect(chatOf(topic).messages).toEqual([])
    // The attached spot belongs to the next question, so it stays; the chat starts over in Normal mode.
    expect(topic.context).toEqual(context)
    expect(panel.getByRole('button', { name: 'Mode: Normal' })).toBeInTheDocument()
    expect(panel.getByRole('button', { name: 'New chat' })).toBeDisabled()
    expect(panel.getByLabelText('Ask a question')).toHaveFocus()
  })

  it('picks the answering model from a menu below the question box and remembers it', async () => {
    localStorage.removeItem('doc-digest.model')
    const { workspace, panel } = setup()
    const picker = panel.getByRole('button', { name: 'Model: Opus 5.5' })
    expect(workspace.answerModel).toBe('claude-opus-5-5')
    // The menu sits below the question box; the send arrow stays inside it.
    const box = panel.getByLabelText('Ask a question').closest('form')!
    expect(box).toContainElement(panel.getByRole('button', { name: 'Send' }))
    expect(box).not.toContainElement(picker)

    await fireEvent.click(picker)
    const items = within(panel.getByRole('menu', { name: 'Model' })).getAllByRole('menuitemradio')
    expect(items.map((i) => i.textContent?.trim())).toEqual(['Opus 5.5', 'Sonnet 5.5'])
    // Like the topic menu, but without icons.
    expect(items.every((i) => !i.querySelector('svg'))).toBe(true)
    await fireEvent.click(items[1])
    expect(workspace.answerModel).toBe('claude-sonnet-5-5')
    expect(localStorage.getItem('doc-digest.model')).toBe('claude-sonnet-5-5')
    expect(panel.getByRole('button', { name: 'Model: Sonnet 5.5' })).toBeInTheDocument()
    localStorage.removeItem('doc-digest.model')
  })

  it('marks the model’s Socratic questions and tints the question box, but not the reader’s messages', async () => {
    const { workspace, topic, context, panel } = setup()
    workspace.attachContext(topic.id, context, 'socratic')
    await tick()
    const box = panel.getByLabelText('Ask a question')
    // What to focus on is optional, so the box can be sent blank.
    expect(box).toHaveAttribute('placeholder', 'What should it focus on? (optional)')
    expect(panel.getByRole('button', { name: 'Send' })).toBeEnabled()
    await workspace.ask(topic.id, undefined, async function* () {
      yield { type: 'text', text: 'What does the integral add up?' }
    })
    await tick()
    const log = panel.getByRole('log')
    const [start, question] = log.querySelectorAll('.message')
    // The session starts from the right-clicked spot, with nothing typed, and looks like any question.
    expect(start).not.toHaveClass('socratic')
    expect(within(start as HTMLElement).getByText('Socratic session')).toBeInTheDocument()
    expect(within(start as HTMLElement).getByRole('button', { name: 'p. 10' })).toBeInTheDocument()
    expect(start.querySelector('.text')).toBeNull()
    expect(question).toHaveClass('socratic')
    expect(question).toHaveTextContent('What does the integral add up?')

    expect(box.closest('form')).toHaveClass('socratic')
    expect(box).toHaveAttribute('placeholder', 'Answer, or ask for a hint…')
    expect(panel.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(panel.getByRole('button', { name: 'Mode: Socratic' })).toBeInTheDocument()
  })

  it('shows a quiz to click through, with feedback on each answer and a summary at the end', async () => {
    const { workspace, topic, context, panel } = setup()
    workspace.attachContext(topic.id, context, 'quiz')
    await tick()
    const box = panel.getByLabelText('Ask a question')
    expect(box.closest('form')).toHaveClass('quiz')
    expect(box).toHaveAttribute('placeholder', 'What should the quiz cover? (optional)')
    expect(panel.getByRole('button', { name: 'Mode: Quiz' })).toBeInTheDocument()
    let reviewed!: (text: string) => void
    const api = {
      create: async () => ({
        title: 'Derivatives',
        questions: [
          { question: 'Derivative of x squared?', choices: ['x', '2x'], answer: 1, explanation: 'The power rule.' },
          { question: 'What is dx?', choices: ['A small change', 'A constant'], answer: 0, explanation: 'An infinitesimal.' },
        ],
      }),
      recommend: () => new Promise<string>((resolve) => (reviewed = resolve)),
    }
    await fireEvent.input(box, { target: { value: 'the power rule' } })
    workspace.quizApi = api
    await workspace.ask(topic.id)
    await tick()
    const [asked] = panel.getByRole('log').querySelectorAll('.message')
    expect(asked).toHaveTextContent('Quiz')
    expect(asked).toHaveTextContent('the power rule')

    const quiz = within(panel.getByRole('group', { name: 'Quiz: Derivatives' }))
    expect(quiz.getByText('Question 1 of 2')).toBeInTheDocument()
    // jsdom can't style KaTeX's MathML, so these questions have no maths.
    const choices = within(quiz.getByRole('group', { name: 'Choices' })).getAllByRole('button')
    expect(choices.map((c) => c.textContent?.trim())).toEqual(['A x', 'B 2x'])
    await fireEvent.click(choices[0])
    expect(choices[0]).toHaveClass('wrong')
    expect(choices[1]).toHaveClass('right')
    expect(choices.every((c) => (c as HTMLButtonElement).disabled)).toBe(true)
    expect(quiz.getByRole('status')).toHaveTextContent('Not quite: the answer is B.')
    expect(quiz.getByRole('status')).toHaveTextContent('The power rule.')

    await fireEvent.click(quiz.getByRole('button', { name: 'Next question' }))
    expect(quiz.getByText('Question 2 of 2')).toBeInTheDocument()
    await fireEvent.click(quiz.getByRole('button', { name: 'A small change' }))
    expect(quiz.getByRole('status')).toHaveTextContent('Right.')
    await fireEvent.click(quiz.getByRole('button', { name: 'See results' }))

    // A ring coloured for the share of right answers, with the score inside.
    const score = quiz.getByRole('img', { name: 'You got 1 of 2 right' })
    expect(score).toHaveTextContent('1/2')
    expect(score.querySelector('.done')).toHaveAttribute('stroke-dasharray', '50 100')
    // Going on to the results fills the ring up from empty.
    expect(score.querySelector('.done')).toHaveClass('filling')
    expect(quiz.getByText('Writing a note on what to review…')).toBeInTheDocument()
    reviewed('Read the power rule again.')
    await vi.waitFor(() => expect(quiz.getByText('What to review')).toBeInTheDocument())
    expect(quiz.getByText('Read the power rule again.')).toBeInTheDocument()
    expect(chatOf(topic).messages[1].quiz!.picked).toEqual([0, 0])

    // Details shows the questions again with what was picked, and hides them again.
    expect(quiz.queryByText('Derivative of x squared?')).not.toBeInTheDocument()
    await fireEvent.click(quiz.getByRole('button', { name: 'Details' }))
    expect(quiz.getByText('Derivative of x squared?')).toBeInTheDocument()
    const groups = quiz.getAllByRole('group', { name: 'Choices' })
    expect(groups).toHaveLength(2)
    const first = within(groups[0]).getAllByRole('button')
    expect(first[0]).toHaveClass('wrong')
    expect(first[1]).toHaveClass('right')
    expect(first.every((c) => (c as HTMLButtonElement).disabled)).toBe(true)
    expect(quiz.getByText('The power rule.')).toBeInTheDocument()
    await fireEvent.click(quiz.getByRole('button', { name: 'Hide details' }))
    expect(quiz.queryByText('Derivative of x squared?')).not.toBeInTheDocument()
  })

  it('switches the mode from the menu on the left below the question box', async () => {
    const { topic, panel } = setup()
    const below = panel.getByLabelText('Ask a question').closest('form')!.nextElementSibling!
    const mode = within(below as HTMLElement).getByRole('button', { name: 'Mode: Normal' })
    const model = within(below as HTMLElement).getByRole('button', { name: /^Model: / })
    // Mode on the left, model on the right.
    expect(mode.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await fireEvent.click(mode)
    const menu = panel.getByRole('menu', { name: 'Mode' })
    const items = within(menu).getAllByRole('menuitemradio')
    expect(items.map((i) => i.textContent?.trim())).toEqual(['Normal', 'Socratic', 'Quiz'])
    expect(items[0]).toHaveAttribute('aria-checked', 'true')
    expect(items[1].querySelector('svg')).not.toBeNull()
    await fireEvent.click(items[1])
    expect(chatOf(topic).mode).toBe('socratic')
    expect(panel.queryByRole('menu')).not.toBeInTheDocument()
    expect(panel.getByLabelText('Ask a question').closest('form')).toHaveClass('socratic')
    expect(panel.getByLabelText('Ask a question')).toHaveFocus()

    // Escape closes the menu but not the chat.
    await fireEvent.click(panel.getByRole('button', { name: 'Mode: Socratic' }))
    await fireEvent.keyDown(panel.getByRole('menu', { name: 'Mode' }), { key: 'Escape' })
    expect(panel.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Chat' }).inert).toBe(false)
    expect(panel.getByRole('button', { name: 'Mode: Socratic' })).toHaveFocus()
  })

  it("shows the page an answer cites when its citation is clicked", async () => {
    const { workspace, topic, context, onreveal, panel } = setup()
    const notes = topic.docIds[0]
    chatOf(topic).messages.push({ id: 'q', role: 'user', text: 'Where?', context })
    chatOf(topic).messages.push({ id: 'a', role: 'assistant', text: 'It is defined in (notes.pdf, p. 7), see also (p. 8).', status: 'done' })
    await fireEvent.click(await panel.findByRole('link', { name: /^notes\.pdf,\sp\.\s7$/ }))
    expect(onreveal).toHaveBeenLastCalledWith({ docId: notes, page: 7 })
    // A page alone points into the PDF the question was asked in.
    await fireEvent.click(panel.getByRole('link', { name: /^p\.\s8$/ }))
    expect(onreveal).toHaveBeenLastCalledWith({ docId: notes, page: 8 })
    expect(workspace.docs[notes]).toBeDefined()
  })

  it('follows a streaming answer only while the reader is at the bottom', async () => {
    const { topic, panel } = setup()
    chatOf(topic).messages.push({ id: 'q', role: 'user', text: 'Why?' }, { id: 'a', role: 'assistant', text: 'Because', status: 'streaming' })
    const log = await panel.findByRole('log')
    // jsdom has no layout, so give the log a height of 1000 viewed through a 200 window.
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 200 })
    const scrollTo = async (top: number) => {
      log.scrollTop = top
      await fireEvent.scroll(log)
    }
    const stream = async (text: string) => {
      chatOf(topic).messages[1].text = text
      await tick()
      await tick()
    }

    await scrollTo(800)
    await stream('Because of')
    expect(log.scrollTop).toBe(1000)

    // Scrolling up to read stops the following.
    await scrollTo(300)
    await stream('Because of this')
    expect(log.scrollTop).toBe(300)

    // Scrolling back to the bottom resumes it.
    await scrollTo(790)
    await stream('Because of this and that')
    expect(log.scrollTop).toBe(1000)

    // A new question always goes to the bottom.
    await scrollTo(300)
    chatOf(topic).messages.push({ id: 'q2', role: 'user', text: 'And?' })
    await tick()
    await tick()
    expect(log.scrollTop).toBe(1000)
  })

  it('quotes selected text of an answer in the question box with Reply, and shows it on the question', async () => {
    const { topic, panel } = setup()
    chatOf(topic).messages.push(
      { id: 'q', role: 'user', text: 'What is a ring?' },
      { id: 'a', role: 'assistant', text: 'A set with **two operations**.', status: 'done' },
    )
    const log = await panel.findByRole('log')
    const range = document.createRange()
    range.selectNodeContents(log.querySelector('.assistant strong')!)
    range.getBoundingClientRect = () => ({ left: 10, top: 20, width: 50, height: 10, bottom: 30, right: 60 }) as DOMRect
    log.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 500, bottom: 500, right: 300 }) as DOMRect
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)
    await fireEvent(document, new Event('selectionchange'))

    await fireEvent.click(await panel.findByRole('button', { name: 'Reply' }))
    expect(topic.quote).toBe('two operations')
    const quote = panel.getByLabelText('Replying to')
    expect(quote).toHaveTextContent('two operations')

    await fireEvent.click(panel.getByRole('button', { name: 'Remove the quote' }))
    expect(topic.quote).toBeUndefined()

    chatOf(topic).messages.push({ id: 'q2', role: 'user', text: 'Which ones?', quote: 'two operations' })
    await tick()
    expect(log.querySelectorAll('.user')[1].querySelector('.quoted')).toHaveTextContent('two operations')
  })

  it('continues the conversation from an answer in a new discussion', async () => {
    const { topic, panel } = setup()
    chatOf(topic).messages.push(
      { id: 'q', role: 'user', text: 'First?' },
      { id: 'a', role: 'assistant', text: 'One.', status: 'done' },
      { id: 'q2', role: 'user', text: 'Second?' },
      { id: 'a2', role: 'assistant', text: 'Two.', status: 'done' },
    )
    const original = chatOf(topic).id
    const buttons = await panel.findAllByRole('button', { name: 'Continue in a new chat' })
    expect(buttons).toHaveLength(2)
    await fireEvent.click(buttons[0])
    expect(chatOf(topic).id).not.toBe(original)
    const log = panel.getByRole('log')
    expect(log.querySelectorAll('.message')).toHaveLength(2)
    expect(log).toHaveTextContent('One.')
    expect(log).not.toHaveTextContent('Two.')
  })
})
