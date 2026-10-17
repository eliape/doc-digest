import { backendError } from './api'
import { type CitableDocs, renderMarkdown } from './markdown'
import { EFFORTS, type EffortId, MODELS, type ModelId } from './models'

/** The kinds of Anki card Leqtern makes. The backend accepts exactly these (deck.py's CardType). */
export type CardType = 'basic' | 'basic_reversed' | 'cloze' | 'type_answer'

export const CARD_TYPES: { id: CardType; name: string; hint: string }[] = [
  { id: 'basic', name: 'Basic', hint: 'A question and its answer' },
  { id: 'basic_reversed', name: 'Basic and reversed', hint: 'Also asked the other way round, when both ways make sense' },
  { id: 'cloze', name: 'Cloze', hint: 'A sentence or formula with its key part hidden' },
  { id: 'type_answer', name: 'Type the answer', hint: 'A short exact answer you type in' },
]

export const typeName = (type: CardType) => CARD_TYPES.find((t) => t.id === type)?.name ?? type

/** Two cards, one behind the other: flashcards. An SVG path on a 24 by 24 grid. */
export const FLASHCARD_ICON =
  'M7 4h12a1 1 0 0 1 1 1v11M4 8h12a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM7 14h6'

/** What each side of a card of `type` is called. A cloze card's back is extra text shown after it. */
export function sideNames(type: CardType): { front: string; back: string } {
  if (type === 'cloze') return { front: 'Text', back: 'Back extra' }
  if (type === 'type_answer') return { front: 'Question', back: 'Answer to type' }
  return { front: 'Front', back: 'Back' }
}

/** Where a card comes from: a PDF's pages, a discussion, or both. */
export type CardSource = { doc_id?: string | null; doc_name?: string | null; pages: number[]; chat_id?: string | null }

/** A card as it is written or edited. For a cloze card, `front` holds the {{c1::gaps}} and `back` extra text. */
export type CardDraft = { type: CardType; front: string; back: string; extra: string; source?: CardSource | null }

/** A card in a topic's deck. Its Anki GUID never changes, so Anki keeps its reviews across imports. */
export type Card = CardDraft & {
  id: string
  anki_guid: string
  created_at: number
  updated_at: number
  last_exported_at: number | null
}

/** A topic's deck, and what changed since it was last exported. */
export type DeckView = {
  cards: Card[]
  /** Cards deleted after an export: Anki still has them until they are deleted there too. */
  deleted: { id: string; front: string; deleted_at: number }[]
  changes: { new: number; edited: number; deleted: number }
  exported_at: number | null
}

/** The card a new one was found to repeat: in the deck (`id`), or earlier in the batch (`key`). */
export type Match = { id: string | null; key: string | null; existing: boolean; type: CardType; front: string; back: string }

/** A card the model wrote, to preview. `similar` is a card it may repeat that could not be checked. */
export type Candidate = CardDraft & { key: string; similar?: Match | null }

/**
 * A card the duplicate filter left out: a duplicate, or the reverse of a one-way card in the deck,
 * which with `upgrade` set turns that card into Basic and reversed when the batch is added.
 */
export type Filtered = Candidate & {
  status: 'duplicate' | 'reverse'
  stage: 'lexical' | 'embedding' | 'haiku' | null
  reason: string | null
  score: number | null
  match: Match | null
  upgrade: boolean
}

export type FlashcardResult = {
  cards: Candidate[]
  filtered: Filtered[]
  /** Whether duplicates were also checked by meaning, with the local embedding model. */
  embeddings: boolean
}

export type ReverseHandling = 'upgrade' | 'discard'

/** What the menu asks for, remembered in this browser. */
export type FlashcardOptions = {
  count: number
  types: CardType[]
  reverse: ReverseHandling
  model: ModelId
  effort: EffortId
}

/** What to make cards from, with the topic around it, as the backend reads it. */
export type FlashcardRequest = {
  topic: string
  topic_id: string
  docs: string[]
  doc_names?: Record<string, string>
  scope?: string
  conventions?: string
  instructions?: string
  chat_id?: string
  context?: Record<string, unknown>
  messages?: unknown[]
}

export type FlashcardEvent = { type: 'step'; text: string } | ({ type: 'result' } & FlashcardResult)

const OPTIONS_KEY = 'leqtern.flashcards'
export const MAX_CARDS = 20

const DEFAULT_OPTIONS: FlashcardOptions = {
  count: 5,
  types: ['basic', 'cloze'],
  reverse: 'upgrade',
  model: MODELS[0].id,
  effort: 'medium',
}

/** The options picked last time in this browser, each checked, or the defaults. */
export function savedFlashcardOptions(): FlashcardOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}') as Partial<FlashcardOptions>
    const types = (saved.types ?? []).filter((t) => CARD_TYPES.some((c) => c.id === t))
    return {
      count: Number.isInteger(saved.count) ? clampCount(saved.count!) : DEFAULT_OPTIONS.count,
      types: types.length ? types : DEFAULT_OPTIONS.types,
      reverse: saved.reverse === 'discard' ? 'discard' : 'upgrade',
      model: MODELS.find((m) => m.id === saved.model)?.id ?? DEFAULT_OPTIONS.model,
      effort: EFFORTS.find((e) => e.id === saved.effort)?.id ?? DEFAULT_OPTIONS.effort,
    }
  } catch {
    return { ...DEFAULT_OPTIONS }
  }
}

export function saveFlashcardOptions(options: FlashcardOptions) {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(options))
  } catch {
    // Not remembered without storage, like the chat's model.
  }
}

export const clampCount = (n: number) => Math.min(MAX_CARDS, Math.max(1, Math.round(n) || 1))

const CLOZE = /\{\{c\d+::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g

export const hasCloze = (text: string) => new RegExp(CLOZE.source).test(text)

/** A card's side as HTML: Markdown and LaTeX like answers, with a cloze card's gaps highlighted. */
export function cardHtml(text: string, docs?: CitableDocs): string {
  const marked = text.replace(CLOZE, (_, answer: string, hint?: string) =>
    `<span class="cloze">${answer}</span>${hint ? ` <span class="cloze-hint">(${hint})</span>` : ''}`,
  )
  return renderMarkdown(marked, docs)
}

/** "book.pdf, p. 41" or "book.pdf, pp. 41–43", or undefined for a card from no page. */
export function sourceLabel(source?: CardSource | null): string | undefined {
  if (!source?.doc_name) return undefined
  const pages = [...new Set(source.pages)].sort((a, b) => a - b)
  if (!pages.length) return source.doc_name
  if (pages.length === 1) return `${source.doc_name}, p. ${pages[0]}`
  const run = pages.at(-1)! - pages[0] === pages.length - 1
  return `${source.doc_name}, pp. ${run ? `${pages[0]}–${pages.at(-1)}` : pages.join(', ')}`
}

/** The types a card in the deck can switch to: any before it is in Anki, then only within its Anki note type. */
export function typesFor(card: Pick<Card, 'type' | 'last_exported_at'>): CardType[] {
  if (card.last_exported_at === null) return CARD_TYPES.map((t) => t.id)
  const basics: CardType[] = ['basic', 'basic_reversed']
  return basics.includes(card.type) ? basics : [card.type]
}

/** Why a card can't be saved as it is, or undefined. */
export function cardProblem(card: CardDraft): string | undefined {
  if (!card.front.trim()) return 'The question is empty.'
  if (card.type === 'cloze') return hasCloze(card.front) ? undefined : 'A cloze card needs a gap, like {{c1::this}}.'
  if (!card.back.trim()) return 'The answer is empty.'
  return undefined
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const deckUrl = (topicId: string) => `/api/topics/${encodeURIComponent(topicId)}/deck`

export async function fetchDeck(topicId: string, fetchFn: typeof fetch = fetch): Promise<DeckView> {
  const res = await fetchFn(deckUrl(topicId))
  if (!res.ok) throw await backendError(res)
  return (await res.json()) as DeckView
}

/**
 * Have the model write cards and check them for duplicates, yielding each lookup it makes
 * and then the result. The backend sends newline-delimited JSON, like answers.
 */
export async function* makeFlashcards(
  topicId: string,
  request: FlashcardRequest & Partial<FlashcardOptions> & { focus?: string },
  signal?: AbortSignal,
  fetchFn: typeof fetch = fetch,
): AsyncGenerator<FlashcardEvent> {
  const res = await fetchFn(`/api/topics/${encodeURIComponent(topicId)}/flashcards`, { ...json(request), signal })
  if (!res.ok || !res.body) throw await backendError(res)
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffered = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (value) buffered += value
    const lines = buffered.split('\n')
    buffered = done ? '' : lines.pop()!
    for (const line of lines) {
      if (!line.trim()) continue
      const event = JSON.parse(line) as { type: string; text?: string; message?: string }
      if (event.type === 'step' && event.text) yield { type: 'step', text: event.text }
      else if (event.type === 'result') {
        yield event as FlashcardEvent
        return
      }
      else if (event.type === 'error') throw new Error(event.message ?? 'Something went wrong while making cards.')
    }
    if (done) throw new Error('Making the cards stopped before it was finished.')
  }
}

/** Add the cards approved in the preview, and turn the cards named in `upgrades` into Basic and reversed. */
export async function addCards(
  topicId: string,
  cards: CardDraft[],
  upgrades: string[],
  fetchFn: typeof fetch = fetch,
): Promise<DeckView & { added: string[] }> {
  const res = await fetchFn(`${deckUrl(topicId)}/cards`, json({ cards, upgrades }))
  if (!res.ok) throw await backendError(res)
  return (await res.json()) as DeckView & { added: string[] }
}

export async function editCard(topicId: string, cardId: string, card: CardDraft, fetchFn: typeof fetch = fetch): Promise<DeckView> {
  const res = await fetchFn(`${deckUrl(topicId)}/cards/${encodeURIComponent(cardId)}`, { ...json(card), method: 'PATCH' })
  if (!res.ok) throw await backendError(res)
  return (await res.json()) as DeckView
}

export async function deleteCard(topicId: string, cardId: string, fetchFn: typeof fetch = fetch): Promise<DeckView> {
  const res = await fetchFn(`${deckUrl(topicId)}/cards/${encodeURIComponent(cardId)}`, { method: 'DELETE' })
  if (!res.ok) throw await backendError(res)
  return (await res.json()) as DeckView
}

/** The deck as an Anki package, with the file name to save it as. Its cards then count as exported. */
export async function exportDeck(topicId: string, name: string, fetchFn: typeof fetch = fetch): Promise<{ blob: Blob; filename: string }> {
  const res = await fetchFn(`${deckUrl(topicId)}/export`, json({ name }))
  if (!res.ok) throw await backendError(res)
  const disposition = res.headers.get('Content-Disposition') ?? ''
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
  const filename = encoded ? decodeURIComponent(encoded) : `Leqtern - ${name}.apkg`
  return { blob: await res.blob(), filename }
}

/** Delete a topic's deck, when the topic is deleted. */
export async function forgetDeck(topicId: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn(deckUrl(topicId), { method: 'DELETE' })
  if (!res.ok) throw await backendError(res)
}

/** Save a file the browser was handed, as a download. */
export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
