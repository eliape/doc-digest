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
        yield 'Partial'
        await new Promise<void>((resolve) => (finish = resolve))
        yield ' answer.'
      }),
    )
    workspace.attachContext(topic.id, context)
    await fireEvent.input(panel.getByLabelText('Ask a question'), { target: { value: 'Why?' } })
    await fireEvent.click(panel.getByRole('button', { name: 'Send' }))

    const log = panel.getByRole('log')
    expect(await within(log).findByText('Partial')).toBeInTheDocument()
    expect(within(log).getByRole('button', { name: 'p. 10' })).toBeInTheDocument()
    expect(panel.getByRole('button', { name: 'Send' })).toBeDisabled()
    finish()
    expect(await within(log).findByText('Partial answer.')).toBeInTheDocument()
  })
})
