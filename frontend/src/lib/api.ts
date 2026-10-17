/** One multiple-choice question: `answer` is the index of the right choice. */
export type QuizQuestion = {
  question: string
  choices: string[]
  answer: number
  explanation: string
  /** For each choice, the mistake that leads to it; null for the right one. Older quizzes have none. */
  misconceptions?: (string | null)[]
}

/** A quiz as the model writes it. */
export type WrittenQuiz = { title: string; questions: QuizQuestion[] }

/** A quiz as the chat keeps it: with the reader's pick for each question, and what to review. */
export type QuizRecord = WrittenQuiz & { picked: (number | null)[]; recommendation?: string }

/** One turn of the conversation, as the backend reads it. */
export type AskTurn = {
  role: 'user' | 'assistant'
  text: string
  context?: Record<string, unknown>
  /** Set on the reader's turns in a Socratic session, where the model asks the questions, and on quiz requests. */
  mode?: 'socratic' | 'quiz'
  /** On the model's side: a quiz it wrote, with how the reader did. */
  quiz?: QuizRecord
}

export type AskRequest = {
  topic: string
  /** The topic's and the discussion's ids, so the answer gets the topic's notes on other discussions. */
  topic_id?: string
  chat_id?: string
  /** The backend's ids of the topic's PDFs, in tab order. */
  docs?: string[]
  /** The name each of those PDFs has in this topic, by backend id: citations use these. */
  doc_names?: Record<string, string>
  messages: AskTurn[]
  /** Which model answers. The backend's default (ANSWER_MODEL) when left out. */
  model?: string
  /** How hard the model works on answers and quizzes. The backend's default (low) when left out. */
  effort?: string
  /** The reader's own instructions for every answer, from Settings. */
  instructions?: string
  /** What the reader studies the topic for, and the conventions its answers follow, in their words. */
  purpose?: string
  conventions?: string
}

/**
 * A piece of an answer's text, a piece of the summary of the model's thinking, or a lookup
 * the model made while answering.
 */
export type AnswerEvent = { type: 'text' | 'thinking' | 'step'; text: string }

/** Something that streams an answer. `fetchAnswer` is the real one; tests pass fakes. */
export type AnswerStream = (request: AskRequest, signal?: AbortSignal) => AsyncIterable<AnswerEvent>

/**
 * Ask the backend a question and yield the answer as it arrives. The backend
 * sends newline-delimited JSON: text and thinking pieces and lookup steps, then "done" or an error.
 */
export async function* fetchAnswer(
  request: AskRequest,
  signal?: AbortSignal,
  fetchFn: typeof fetch = fetch,
): AsyncGenerator<AnswerEvent> {
  const res = await fetchFn('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  })
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
      if ((event.type === 'text' || event.type === 'thinking' || event.type === 'step') && event.text)
        yield { type: event.type, text: event.text }
      else if (event.type === 'error') throw new Error(event.message ?? 'Something went wrong while answering.')
      else if (event.type === 'done') return
    }
    if (done) throw new Error('The answer stopped before it was finished.')
  }
}

/** A failed request, with the reason the backend gives and its HTTP status. */
export class BackendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** The reason the backend gives for a failed request, as an Error. */
export async function backendError(res: Response): Promise<BackendError> {
  const detail = await res
    .json()
    .then((body: { detail?: unknown }) => (typeof body.detail === 'string' ? body.detail : undefined))
    .catch(() => undefined)
  return new BackendError(detail ?? `The backend returned an error (${res.status}). Is it running?`, res.status)
}

/** How far the backend has got with indexing a PDF. */
export type IndexStatus = {
  id: string
  status: 'queued' | 'indexing' | 'ready' | 'error'
  pages_done: number
  page_count: number
  error?: string
}

/** Give the backend a PDF to keep and index. Adding the same file again is cheap: it is stored once. */
export async function uploadDoc(name: string, data: Uint8Array, fetchFn: typeof fetch = fetch): Promise<IndexStatus> {
  const res = await fetchFn(`/api/docs?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: data as BodyInit,
  })
  if (!res.ok) throw await backendError(res)
  return (await res.json()) as IndexStatus
}

/** Have the backend try indexing a PDF again after it failed. */
export async function retryIndex(id: string, fetchFn: typeof fetch = fetch): Promise<IndexStatus> {
  const res = await fetchFn(`/api/docs/${encodeURIComponent(id)}/index`, { method: 'POST' })
  if (!res.ok) throw await backendError(res)
  return (await res.json()) as IndexStatus
}

export async function fetchIndexStatus(id: string, fetchFn: typeof fetch = fetch): Promise<IndexStatus> {
  const res = await fetchFn(`/api/docs/${encodeURIComponent(id)}`)
  if (!res.ok) throw await backendError(res)
  return (await res.json()) as IndexStatus
}

/**
 * A section the index found: its heading, level (1 is the top), first page and, when
 * known, how far down that page the heading is (0 top, 1 bottom).
 */
export type IndexSection = { title: string; level: number; start_page: number; top?: number | null }

/** The sections indexed so far, in page order. Empty before the first pages are indexed. */
export async function fetchIndexSections(id: string, fetchFn: typeof fetch = fetch): Promise<IndexSection[]> {
  const res = await fetchFn(`/api/docs/${encodeURIComponent(id)}/index`)
  if (res.status === 404) return []
  if (!res.ok) throw await backendError(res)
  return ((await res.json()) as { sections?: IndexSection[] }).sections ?? []
}

/** A PDF the backend keeps, by its id, for reopening a saved tab. */
export async function fetchPdf(id: string, fetchFn: typeof fetch = fetch): Promise<Uint8Array> {
  const res = await fetchFn(`/api/docs/${encodeURIComponent(id)}/pdf`)
  if (!res.ok) throw await backendError(res)
  return new Uint8Array(await res.arrayBuffer())
}

/**
 * The workspace saved last time (an empty object before anything was saved), with the
 * revision the next save is based on.
 */
export async function fetchSavedWorkspace(fetchFn: typeof fetch = fetch): Promise<{ revision?: number } & Record<string, unknown>> {
  const res = await fetchFn('/api/workspace')
  if (!res.ok) throw await backendError(res)
  return res.json()
}

/** Where a save comes from: the revision the tab last loaded or saved, and the tab's id. */
export type SaveFrom = { base: number; writer: string }

/** What a save did: the workspace's new revision, and which released PDFs it deleted. */
export type Saved = { revision: number; deleted: string[]; later: string[] }

/**
 * Save the workspace (already turned into JSON) on disk, replacing what was saved. Fails with
 * status 409 when another tab saved since `from.base`. `release` names PDFs (backend ids) taken
 * out of a topic since the last save: the backend deletes those no topic has any more, except
 * ones uploaded moments ago, which it returns in `later` to send again.
 */
export async function saveWorkspace(
  json: string,
  from: SaveFrom,
  { keepalive = false, release = [] }: { keepalive?: boolean; release?: string[] } = {},
  fetchFn: typeof fetch = fetch,
): Promise<Saved> {
  const query = new URLSearchParams({ base: String(from.base), writer: from.writer })
  for (const id of release) query.append('release', id)
  const res = await fetchFn(`/api/workspace?${query}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: json,
    keepalive,
  })
  if (!res.ok) throw await backendError(res)
  const saved = (await res.json()) as Partial<Saved>
  return { revision: saved.revision ?? from.base, deleted: saved.deleted ?? [], later: saved.later ?? [] }
}

/** Have the model write a multiple-choice quiz for the newest turn, which asks for one. */
export async function createQuiz(request: AskRequest, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<WrittenQuiz> {
  const res = await fetchFn('/api/quiz', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  })
  if (!res.ok) throw await backendError(res)
  return (await res.json()) as WrittenQuiz
}

/** What a finished quiz was about (the request for it) and how it went. */
export type RecommendationRequest = { topic: string; about: AskTurn; quiz: QuizRecord }

/** A short note on what to review after a quiz, or null when every answer was right. */
export async function fetchRecommendation(request: RecommendationRequest, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const res = await fetchFn('/api/quiz/recommendation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!res.ok) throw await backendError(res)
  return ((await res.json()) as { text: string | null }).text
}

/** The first question of a discussion, for Haiku to name it. */
export type TitleRequest = { topic: string; about: AskTurn }

/** A few words naming a discussion, or null if none came. */
export async function fetchChatTitle(request: TitleRequest, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const res = await fetchFn('/api/chat-title', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!res.ok) throw await backendError(res)
  return ((await res.json()) as { text: string | null }).text
}

/** A turn of a discussion for the register. `key` names it, and changes when the turn does (a quiz being answered). */
export type RegisterTurn = AskTurn & { key: string }

/** A discussion the reader left, for Haiku to note what is new in it in the topic's register. */
export type DiscussionRequest = {
  topic: string
  chat_id: string
  title?: string
  /** The backend's ids of the topic's PDFs. */
  docs: string[]
  messages: RegisterTurn[]
}

/** Have Haiku note what is new in a discussion in its topic's register. Questions asked meanwhile wait for it. */
export async function noteDiscussion(topicId: string, request: DiscussionRequest, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn(`/api/topics/${encodeURIComponent(topicId)}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!res.ok) throw await backendError(res)
}

/** Delete a topic's register, when the topic is deleted. */
export async function forgetRegister(topicId: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn(`/api/topics/${encodeURIComponent(topicId)}/register`, { method: 'DELETE' })
  if (!res.ok) throw await backendError(res)
}
