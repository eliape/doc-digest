import { fireEvent, render, screen, within } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import ChatPanel from './ChatPanel.svelte'
import type { PageContext } from './context'
import { Workspace } from './workspace.svelte'

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
    topic.chat.push(
      { id: 'q1', role: 'user', text: 'About the page', context: { ...context, point: undefined } },
      { id: 'q2', role: 'user', text: 'About the spot', context },
    )
    const log = await panel.findByRole('log')
    expect(within(log).getAllByRole('button', { name: 'p. 10' })).toHaveLength(1)
    expect(log.querySelectorAll('.message')[0].querySelector('.chip')).toBeNull()
  })

  it('shows answers as Markdown with typeset maths, and questions as typed', async () => {
    const { topic, panel } = setup()
    topic.chat.push(
      { id: 'q', role: 'user', text: 'What is **this** $x$?' },
      { id: 'a', role: 'assistant', text: 'It is **the variance**:\n\n$$\\sigma^2 = E[(X-\\mu)^2]$$' },
    )
    const log = await panel.findByRole('log')
    expect(log.querySelector('.user')).toHaveTextContent('What is **this** $x$?')
    expect(log.querySelector('.assistant strong')).toHaveTextContent('the variance')
    expect(log.querySelector('.assistant .katex-display')).not.toBeNull()
  })

  it('clears the chat with New chat, keeping the attached spot, and is disabled while the chat is empty', async () => {
    const { workspace, topic, context, panel } = setup()
    const button = panel.getByRole('button', { name: 'New chat' })
    expect(button).toBeDisabled()
    topic.chat.push({ id: 'q', role: 'user', text: 'What is this?' })
    workspace.attachContext(topic.id, context)
    await fireEvent.click(await panel.findByRole('button', { name: 'New chat' }))
    expect(topic.chat).toEqual([])
    // The attached spot belongs to the next question, so it stays.
    expect(topic.context).toEqual(context)
    expect(panel.getByRole('button', { name: 'New chat' })).toBeDisabled()
    expect(panel.getByLabelText('Ask a question')).toHaveFocus()
  })

  it('picks the answering model below the question box and remembers it', async () => {
    localStorage.removeItem('doc-digest.model')
    const { workspace, panel } = setup()
    const picker = panel.getByLabelText('Model') as HTMLSelectElement
    expect(picker.value).toBe('claude-opus-5-5')
    expect(workspace.answerModel).toBe('claude-opus-5-5')
    // The menu sits below the question box; the send arrow stays inside it.
    const box = panel.getByLabelText('Ask a question').closest('form')!
    expect(box).toContainElement(panel.getByRole('button', { name: 'Send' }))
    expect(box).not.toContainElement(picker)

    await fireEvent.change(picker, { target: { value: 'claude-sonnet-5-5' } })
    expect(workspace.answerModel).toBe('claude-sonnet-5-5')
    expect(localStorage.getItem('doc-digest.model')).toBe('claude-sonnet-5-5')
    localStorage.removeItem('doc-digest.model')
  })

  it("shows the page an answer cites when its citation is clicked", async () => {
    const { workspace, topic, onreveal, panel } = setup()
    const notes = topic.docIds[0]
    topic.chat.push({ id: 'q', role: 'user', text: 'Where?' })
    topic.chat.push({ id: 'a', role: 'assistant', text: 'It is defined in (notes.pdf, p. 7).', status: 'done' })
    const citation = await panel.findByRole('link', { name: /^notes\.pdf,\sp\.\s7$/ })
    await fireEvent.click(citation)
    expect(onreveal).toHaveBeenCalledWith({ docId: notes, page: 7 })
    expect(workspace.docs[notes]).toBeDefined()
  })
})
