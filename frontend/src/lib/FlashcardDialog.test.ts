import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PageContext } from './context'
import FlashcardDialog from './FlashcardDialog.svelte'
import type { Card, DeckView } from './flashcards'
import { Workspace } from './workspace.svelte'

const card = (id: string, front: string, back: string): Card => ({
  id,
  type: 'basic',
  front,
  back,
  extra: '',
  source: null,
  anki_guid: `g-${id}`,
  created_at: 1,
  updated_at: 1,
  last_exported_at: null,
})

const deck = (cards: Card[]): DeckView => ({ cards, deleted: [], changes: { new: cards.length, edited: 0, deleted: 0 }, exported_at: null })

const result = {
  type: 'result',
  embeddings: true,
  cards: [
    { key: 'new:0', type: 'basic', front: 'What is a **group**?', back: 'A set with an operation', extra: '', source: { doc_id: 'srv1', doc_name: 'notes.pdf', pages: [4] } },
    { key: 'new:1', type: 'cloze', front: 'A group has an {{c1::identity}}', back: '', extra: '', source: null },
  ],
  filtered: [
    {
      key: 'new:2', type: 'basic', front: 'Define a group', back: 'A set with an operation', extra: '', source: null,
      status: 'duplicate', stage: 'embedding', reason: null, score: 0.93, upgrade: false,
      match: { id: 'old1', key: null, existing: true, type: 'basic', front: 'What is a group?', back: 'A set…' },
    },
    {
      key: 'new:3', type: 'basic', front: 'What is a set with an associative operation, identity and inverses?', back: 'A group', extra: '', source: null,
      status: 'reverse', stage: 'haiku', reason: null, score: 0.85, upgrade: true,
      match: { id: 'old2', key: null, existing: true, type: 'basic', front: 'What is a group?', back: 'A set with…' },
    },
  ],
}

function lines(...events: unknown[]) {
  return new Response(events.map((e) => `${JSON.stringify(e)}\n`).join(''))
}

function setup() {
  const workspace = new Workspace()
  const doc = workspace.addDoc('notes.pdf', new Uint8Array([1]))
  workspace.indexing[doc.id] = { serverId: 'srv1', status: 'ready', pagesDone: 1, pageCount: 1 }
  const topic = workspace.activeTopic!
  const context: PageContext = { docId: doc.id, docName: 'notes.pdf', page: 4, selection: 'A group is a set…', pageTexts: [] }
  const requests: { url: string; body: unknown }[] = []
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    requests.push({ url, body })
    if (url.endsWith('/flashcards')) return lines({ type: 'step', text: 'Reading p. 4' }, result)
    if (url.endsWith('/deck/cards')) return Response.json({ ...deck([card('old1', 'a', 'b'), card('n1', 'c', 'd')]), added: ['n1', 'n2'] })
    return Response.json(deck([card('old1', 'What is a group?', 'A set…'), card('old2', 'What is a group?', 'A set with…')]))
  })
  vi.stubGlobal('fetch', fetchFn)
  const onclose = vi.fn()
  const onreveal = vi.fn()
  render(FlashcardDialog, {
    workspace,
    topicId: topic.id,
    source: { kind: 'pick', context },
    about: 'Your selection on p. 4 of notes.pdf',
    onclose,
    onreveal,
  })
  return { doc, topic, requests, onclose, onreveal, dialog: within(screen.getByRole('dialog', { name: 'Make flashcards' })) }
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('FlashcardDialog', () => {
  it('asks what to make, then previews the cards with the duplicates left out, and adds them', async () => {
    const { topic, requests, onclose, onreveal, dialog, doc } = setup()
    expect(dialog.getByText('Your selection on p. 4 of notes.pdf')).toBeInTheDocument()
    expect(await dialog.findByText(/2 cards in its deck/)).toBeInTheDocument()
    expect(dialog.getByRole('checkbox', { name: /^Basic A question/ })).toBeChecked()
    expect(dialog.getByRole('checkbox', { name: /^Cloze/ })).toBeChecked()
    expect(dialog.getByRole('checkbox', { name: /^Type the answer/ })).not.toBeChecked()
    expect(dialog.getByRole('radio', { name: /Automatically upgrade/ })).toBeChecked()
    expect(dialog.getByText(/only supports English/)).toBeInTheDocument()

    await fireEvent.input(dialog.getByRole('spinbutton', { name: 'How many cards' }), { target: { value: '2' } })
    await fireEvent.input(dialog.getByRole('textbox', { name: /Focus/ }), { target: { value: 'the axioms' } })
    await fireEvent.click(dialog.getByRole('button', { name: 'Make 2 cards' }))

    expect(await dialog.findByRole('button', { name: 'Add 2 cards to deck' })).toBeInTheDocument()
    expect(dialog.getByText('group', { selector: 'strong' })).toBeInTheDocument()
    const made = requests.find((r) => r.url.endsWith('/flashcards'))!.body
    expect(made).toMatchObject({ topic_id: topic.id, count: 2, types: ['basic', 'cloze'], reverse: 'upgrade', focus: 'the axioms', context: { page: 4 } })
    expect(dialog.getByText('identity')).toHaveClass('cloze')

    // The tray says what was left out and which deck cards will go both ways.
    const tray = dialog.getByText(/2 cards left out as duplicates · 1 card in the deck will go both ways/)
    await fireEvent.click(tray)
    const upgrade = dialog.getByRole('checkbox', { name: 'Make that card Basic and reversed' })
    expect(upgrade).toBeChecked()
    await fireEvent.click(upgrade)
    expect(dialog.getByText('2 cards left out as duplicates')).toBeInTheDocument()
    await fireEvent.click(upgrade)

    // A duplicate can be brought back, and a card left out.
    await fireEvent.click(dialog.getAllByRole('button', { name: 'Bring back' })[0])
    expect(dialog.getAllByRole('button', { name: 'Leave this card out' })).toHaveLength(3)
    await fireEvent.click(dialog.getAllByRole('button', { name: 'Leave this card out' })[1])

    await fireEvent.click(dialog.getByRole('button', { name: 'notes.pdf, p. 4' }))
    expect(onreveal).toHaveBeenCalledWith({ docId: doc.id, page: 4 })

    await fireEvent.click(dialog.getByRole('button', { name: 'Add 2 cards to deck' }))
    expect(await dialog.findByText(/Added 2 cards to the deck/)).toBeInTheDocument()
    const added = requests.find((r) => r.url.endsWith('/deck/cards'))!.body as { cards: { front: string }[]; upgrades: string[] }
    expect(added.cards.map((c) => c.front)).toEqual(['What is a **group**?', 'Define a group'])
    expect(added.upgrades).toEqual(['old2'])
    expect(JSON.parse(localStorage.getItem('leqtern.flashcards')!)).toMatchObject({ count: 2 })

    await fireEvent.click(dialog.getByRole('button', { name: 'Done' }))
    expect(onclose).toHaveBeenCalled()
  })

  it('edits a card in the preview by clicking its rendered side', async () => {
    const { requests, dialog } = setup()
    await fireEvent.click(dialog.getByRole('button', { name: /^Make 5 cards/ }))
    const side = await dialog.findByText('A set with an operation', { selector: '.rendered p' })
    await fireEvent.click(side.closest('.rendered')!)
    const box = dialog.getByDisplayValue('A set with an operation')
    await fireEvent.input(box, { target: { value: '' } })
    expect(dialog.getByText('The answer is empty.')).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: /^Add 2 cards/ })).toBeDisabled()
    await fireEvent.input(box, { target: { value: 'A **monoid** with inverses' } })
    await fireEvent.blur(box)
    expect(dialog.getByText('monoid').tagName).toBe('STRONG')
    await fireEvent.click(dialog.getByRole('button', { name: /^Add 2 cards/ }))
    await waitFor(() => expect(requests.some((r) => r.url.endsWith('/deck/cards'))).toBe(true))
  })

  it('goes back to the menu with the reason when making cards fails', async () => {
    const { dialog } = setup()
    vi.stubGlobal('fetch', vi.fn(async () => lines({ type: 'error', message: 'The model stopped.' })))
    await fireEvent.click(dialog.getByRole('button', { name: /^Make 5 cards/ }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('The model stopped.')
    expect(dialog.getByRole('button', { name: /^Make 5 cards/ })).toBeInTheDocument()
  })
})
