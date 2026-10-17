import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addCards,
  cardHtml,
  cardProblem,
  clampCount,
  exportDeck,
  type FlashcardEvent,
  makeFlashcards,
  savedFlashcardOptions,
  saveFlashcardOptions,
  sourceLabel,
  typesFor,
} from './flashcards'

/** A response whose body arrives in the pieces given, like a stream from the backend. */
function streamed(pieces: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece))
      controller.close()
    },
  })
  return new Response(body)
}

afterEach(() => localStorage.clear())

describe('flashcard options', () => {
  it('starts with five Basic and Cloze cards, upgrading reverses, and remembers what is picked', () => {
    expect(savedFlashcardOptions()).toEqual({
      count: 5,
      types: ['basic', 'cloze'],
      reverse: 'upgrade',
      model: 'claude-opus-5-5',
      effort: 'medium',
    })
    saveFlashcardOptions({ count: 12, types: ['type_answer'], reverse: 'discard', model: 'claude-sonnet-5-5', effort: 'low' })
    expect(savedFlashcardOptions()).toMatchObject({ count: 12, types: ['type_answer'], reverse: 'discard', model: 'claude-sonnet-5-5' })
  })

  it('drops saved values it does not know', () => {
    localStorage.setItem('leqtern.flashcards', JSON.stringify({ count: 80, types: ['essay'], model: 'gpt', effort: 'max' }))
    expect(savedFlashcardOptions()).toMatchObject({ count: 20, types: ['basic', 'cloze'], model: 'claude-opus-5-5', effort: 'medium' })
  })

  it('keeps the count between 1 and 20', () => {
    expect(clampCount(0)).toBe(1)
    expect(clampCount(7.4)).toBe(7)
    expect(clampCount(31)).toBe(20)
    expect(clampCount(Number.NaN)).toBe(1)
  })
})

describe('cards', () => {
  it('highlights a cloze card’s gaps and renders its Markdown and maths', () => {
    const html = cardHtml('The **derivative** of $x^2$ is {{c1::$2x$::a function}}.')
    expect(html).toContain('<strong>derivative</strong>')
    expect(html).toContain('class="cloze"')
    expect(html).toContain('class="cloze-hint">(a function)')
    expect(html).toContain('katex')
  })

  it('names where a card comes from', () => {
    expect(sourceLabel({ doc_name: 'book.pdf', pages: [41] })).toBe('book.pdf, p. 41')
    expect(sourceLabel({ doc_name: 'book.pdf', pages: [43, 41, 42] })).toBe('book.pdf, pp. 41–43')
    expect(sourceLabel({ doc_name: 'book.pdf', pages: [3, 9] })).toBe('book.pdf, pp. 3, 9')
    expect(sourceLabel({ doc_name: null, pages: [], chat_id: 'c' })).toBeUndefined()
  })

  it('lets a card in Anki switch only between Basic and Basic and reversed', () => {
    expect(typesFor({ type: 'cloze', last_exported_at: null })).toHaveLength(4)
    expect(typesFor({ type: 'basic', last_exported_at: 5 })).toEqual(['basic', 'basic_reversed'])
    expect(typesFor({ type: 'cloze', last_exported_at: 5 })).toEqual(['cloze'])
  })

  it('says why a card cannot be saved', () => {
    const card = { type: 'basic' as const, front: 'Q', back: 'A', extra: '' }
    expect(cardProblem(card)).toBeUndefined()
    expect(cardProblem({ ...card, back: ' ' })).toBe('The answer is empty.')
    expect(cardProblem({ ...card, type: 'cloze', back: '' })).toMatch(/needs a gap/)
    expect(cardProblem({ ...card, type: 'cloze', front: 'A {{c1::gap}}', back: '' })).toBeUndefined()
  })
})

describe('the flashcard API', () => {
  it('yields each lookup and then the result, from lines split anywhere', async () => {
    const result = { type: 'result', cards: [{ key: 'new:0', type: 'basic', front: 'Q', back: 'A', extra: '' }], filtered: [], embeddings: true }
    const lines = `{"type":"step","text":"Reading p. 4"}\n${JSON.stringify(result)}\n`
    const fetchFn = vi.fn(async () => streamed([lines.slice(0, 20), lines.slice(20)]))
    const events: FlashcardEvent[] = []
    for await (const event of makeFlashcards('t1', { topic: 'T', topic_id: 't1', docs: [] }, undefined, fetchFn)) events.push(event)
    expect(events).toEqual([{ type: 'step', text: 'Reading p. 4' }, result])
    expect(fetchFn).toHaveBeenCalledWith('/api/topics/t1/flashcards', expect.objectContaining({ method: 'POST' }))
  })

  it('throws the backend’s error', async () => {
    const fetchFn = vi.fn(async () => streamed(['{"type":"error","message":"The model refused."}\n']))
    const run = async () => {
      for await (const _ of makeFlashcards('t1', { topic: 'T', topic_id: 't1', docs: [] }, undefined, fetchFn)) void _
    }
    await expect(run()).rejects.toThrow('The model refused.')
  })

  it('adds cards with the upgrades', async () => {
    const fetchFn = vi.fn(async () => Response.json({ added: ['a'], cards: [], deleted: [], changes: {}, exported_at: null }))
    await addCards('t1', [{ type: 'basic', front: 'Q', back: 'A', extra: '' }], ['old'], fetchFn)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/topics/t1/deck/cards')
    expect(JSON.parse(init.body as string)).toEqual({ cards: [{ type: 'basic', front: 'Q', back: 'A', extra: '' }], upgrades: ['old'] })
  })

  it('takes the export’s file name from the response', async () => {
    const headers = { 'Content-Disposition': `attachment; filename="x.apkg"; filename*=UTF-8''Leqtern%20-%20L%C3%A6ring.apkg` }
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([1, 2]), { headers }))
    const { blob, filename } = await exportDeck('t1', 'Læring', fetchFn)
    expect(filename).toBe('Leqtern - Læring.apkg')
    expect(blob.size).toBe(2)
  })
})
