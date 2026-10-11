/** One multiple-choice question: `answer` is the index of the right choice. */
export type QuizQuestion = { question: string; choices: string[]; answer: number; explanation: string }

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
  /** The backend's ids of the topic's PDFs, in tab order. */
  docs?: string[]
  messages: AskTurn[]
  /** Which model answers. The backend's default (ANSWER_MODEL) when left out. */
  model?: string
}

/** A piece of an answer's text, or a lookup the model made while answering. */
export type AnswerEvent = { type: 'text'; text: string } | { type: 'step'; text: string }

/** Something that streams an answer. `fetchAnswer` is the real one; tests pass fakes. */
export type AnswerStream = (request: AskRequest, signal?: AbortSignal) => AsyncIterable<AnswerEvent>

/**
 * Ask the backend a question and yield the answer as it arrives. The backend
 * sends newline-delimited JSON: text pieces and lookup steps, then "done" or an error.
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
      if ((event.type === 'text' || event.type === 'step') && event.text) yield { type: event.type, text: event.text }
      else if (event.type === 'error') throw new Error(event.message ?? 'Something went wrong while answering.')
      else if (event.type === 'done') return
    }
    if (done) throw new Error('The answer stopped before it was finished.')
  }
}

/** The reason the backend gives for a failed request, as an Error. */
async function backendError(res: Response): Promise<Error> {
  const detail = await res
    .json()
    .then((body: { detail?: unknown }) => (typeof body.detail === 'string' ? body.detail : undefined))
    .catch(() => undefined)
  return new Error(detail ?? `The backend returned an error (${res.status}). Is it running?`)
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

export async function fetchIndexStatus(id: string, fetchFn: typeof fetch = fetch): Promise<IndexStatus> {
  const res = await fetchFn(`/api/docs/${encodeURIComponent(id)}`)
  if (!res.ok) throw await backendError(res)
  return (await res.json()) as IndexStatus
}

/** A PDF the backend keeps, by its id, for reopening a saved tab. */
export async function fetchPdf(id: string, fetchFn: typeof fetch = fetch): Promise<Uint8Array> {
  const res = await fetchFn(`/api/docs/${encodeURIComponent(id)}/pdf`)
  if (!res.ok) throw await backendError(res)
  return new Uint8Array(await res.arrayBuffer())
}

/** The workspace saved last time, or an empty object before anything was saved. */
export async function fetchSavedWorkspace(fetchFn: typeof fetch = fetch): Promise<unknown> {
  const res = await fetchFn('/api/workspace')
  if (!res.ok) throw await backendError(res)
  return res.json()
}

/** Save the workspace (already turned into JSON) on disk, replacing what was saved. */
export async function saveWorkspace(json: string, fetchFn: typeof fetch = fetch, keepalive = false): Promise<void> {
  const res = await fetchFn('/api/workspace', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: json,
    keepalive,
  })
  if (!res.ok) throw await backendError(res)
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
