import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FlashcardManager from './FlashcardManager.svelte'
import type { Card, DeckView } from './flashcards'
import { Workspace } from './workspace.svelte'

const card = (id: string, changes: Partial<Card>): Card => ({
  id,
  type: 'basic',
  front: 'Q',
  back: 'A',
  extra: '',
  source: null,
  anki_guid: `g-${id}`,
  created_at: 1,
  updated_at: 1,
  last_exported_at: null,
  ...changes,
})

const cards = [
  card('a', { front: 'What is a group?', back: 'A set with an operation', last_exported_at: 1 }),
  card('b', { type: 'cloze', front: 'A ring has {{c1::two}} operations', back: '', last_exported_at: 1, updated_at: 5 }),
  card('c', { front: 'What is a field?', back: 'A commutative ring with division', source: { doc_id: 'srv1', doc_name: 'notes.pdf', pages: [7] } }),
]

const view = (list: Card[], deleted: DeckView['deleted'] = []): DeckView => ({
  cards: list,
  deleted,
  changes: { new: 1, edited: 1, deleted: deleted.length },
  exported_at: 1,
})

function setup() {
  const workspace = new Workspace()
  const doc = workspace.addDoc('notes.pdf', new Uint8Array([1]))
  workspace.indexing[doc.id] = { serverId: 'srv1', status: 'ready', pagesDone: 1, pageCount: 1 }
  const topic = workspace.activeTopic!
  topic.name = 'Algebra'
  let current = view(cards, [{ id: 'z', front: 'An old card', deleted_at: 2 }])
  const requests: { url: string; method: string; body: unknown }[] = []
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    requests.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined })
    if (url.endsWith('/export')) {
      current = { ...view(cards), changes: { new: 0, edited: 0, deleted: 0 } }
      const headers = { 'Content-Disposition': `attachment; filename*=UTF-8''Leqtern%20-%20Algebra.apkg` }
      return new Response(new Uint8Array([1]), { headers })
    }
    if (method === 'PATCH') {
      const body = JSON.parse(init!.body as string) as Card
      current = view(current.cards.map((c) => (url.endsWith(`/${c.id}`) ? { ...c, ...body } : c)), current.deleted)
    }
    if (method === 'DELETE') current = view(current.cards.filter((c) => !url.endsWith(`/${c.id}`)), current.deleted)
    return Response.json(current)
  })
  vi.stubGlobal('fetch', fetchFn)
  const onreveal = vi.fn()
  const onclose = vi.fn()
  render(FlashcardManager, { workspace, topic, onclose, onreveal })
  return { doc, topic, requests, onreveal, onclose, dialog: within(screen.getByRole('dialog', { name: 'Flashcards' })) }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('FlashcardManager', () => {
  it('lists the deck newest first with what changed since the export, and searches it', async () => {
    const { dialog, onreveal, doc } = setup()
    expect(await dialog.findByText(/3 cards · Since the last export: 1 new, 1 edited, 1 deleted/)).toBeInTheDocument()
    const rows = () => dialog.getAllByRole('listitem').filter((li) => li.classList.contains('row'))
    expect(rows().map((r) => r.querySelector('.rendered')?.textContent?.trim())).toEqual([
      'What is a field?',
      'A ring has two operations',
      'What is a group?',
    ])
    expect(within(rows()[0]).getByText('Not in Anki yet')).toBeInTheDocument()
    expect(within(rows()[1]).getByText('Edited since export')).toBeInTheDocument()
    expect(dialog.getByText(/1 card deleted here is still in Anki/)).toBeInTheDocument()

    await fireEvent.click(dialog.getByRole('button', { name: 'notes.pdf, p. 7' }))
    expect(onreveal).toHaveBeenCalledWith({ docId: doc.id, page: 7 })

    await fireEvent.input(dialog.getByRole('searchbox', { name: 'Search cards' }), { target: { value: 'ring operations' } })
    expect(rows()).toHaveLength(1)
    await fireEvent.input(dialog.getByRole('searchbox', { name: 'Search cards' }), { target: { value: 'nothing like it' } })
    expect(dialog.getByText('No card has all of those words.')).toBeInTheDocument()
  })

  it('edits a card, keeping one in Anki within its note type, and deletes one', async () => {
    const { dialog, requests } = setup()
    await dialog.findByText('What is a group?')
    const group = dialog.getByText('What is a group?').closest('li')!
    await fireEvent.click(within(group).getByRole('button', { name: 'Edit' }))
    const type = within(group).getByRole('combobox', { name: 'Card type' })
    expect(within(type).getAllByRole('option').map((o) => o.textContent)).toEqual(['Basic', 'Basic and reversed'])
    await fireEvent.change(type, { target: { value: 'basic_reversed' } })
    await fireEvent.click(within(group).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(requests.some((r) => r.method === 'PATCH')).toBe(true))
    expect(requests.find((r) => r.method === 'PATCH')).toMatchObject({ url: expect.stringMatching(/\/deck\/cards\/a$/), body: { type: 'basic_reversed' } })
    await waitFor(() => expect(dialog.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument())
    expect(dialog.getByText('Basic and reversed', { selector: '.meta span' })).toBeInTheDocument()

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const field = dialog.getByText('What is a field?').closest('li')!
    await fireEvent.click(within(field).getByRole('button', { name: 'Delete' }))
    expect(window.confirm).toHaveBeenCalledWith('Delete this card?')
    await waitFor(() => expect(dialog.queryByText('What is a field?')).not.toBeInTheDocument())
  })

  it('exports the deck for Anki and lists the cards to delete there', async () => {
    const { dialog, requests } = setup()
    const createObjectURL = vi.fn(() => 'blob:x')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await dialog.findByText('What is a group?')
    await fireEvent.click(dialog.getByRole('button', { name: 'Export for Anki' }))
    expect(await dialog.findByRole('status')).toHaveTextContent('Saved Leqtern - Algebra.apkg')
    expect(dialog.getByRole('status')).toHaveTextContent('An old card')
    expect(click).toHaveBeenCalled()
    expect(requests.find((r) => r.url.endsWith('/export'))?.body).toEqual({ name: 'Algebra' })
    expect(await dialog.findByText(/Anki has every change/)).toBeInTheDocument()
  })
})
