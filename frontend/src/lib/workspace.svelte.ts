import {
  type AnswerStream,
  type AskRequest,
  createQuiz,
  fetchAnswer,
  fetchIndexStatus,
  fetchRecommendation,
  type IndexStatus,
  type QuizRecord,
  type RecommendationRequest,
  uploadDoc,
  type WrittenQuiz,
} from './api'
import type { PageContext } from './context'

/** A PDF opened in a topic. Each one is a tab. */
export type Doc = { id: string; name: string; data: Uint8Array }

/**
 * A quiz in the chat, with the reader's pick for each question (null until answered) and,
 * once they have answered them all, a note on what to review while `reviewing` is 'writing'.
 */
export type Quiz = QuizRecord & { reviewing?: 'writing' | 'failed' }

/**
 * One message in a topic's chat. A question carries the context it was asked
 * about; an answer is `streaming` while it arrives and `error` if it failed.
 * `mode` marks the messages of a Socratic session, and a quiz request with the
 * model's quiz. The reader's words in either may be empty: they only pointed at something.
 */
export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  context?: PageContext
  mode?: 'socratic' | 'quiz'
  status?: 'streaming' | 'done' | 'error'
  /** The lookups the model made while answering, e.g. "Read book.pdf, pp. 4–5". */
  steps?: string[]
  /** On the model's side: the quiz it wrote, which the reader clicks through. */
  quiz?: Quiz
}

/**
 * How far the backend has got with indexing a PDF. `serverId` is the backend's
 * id for it, known once the upload is done; questions can name it from then on.
 */
export type IndexState = {
  serverId?: string
  status: 'uploading' | IndexStatus['status']
  pagesDone: number
  pageCount: number
  error?: string
}

/** The backend calls indexing uses. Tests pass fakes. */
export type IndexApi = {
  upload: (name: string, data: Uint8Array) => Promise<IndexStatus>
  status: (serverId: string) => Promise<IndexStatus>
}

const realIndexApi: IndexApi = { upload: (name, data) => uploadDoc(name, data), status: (id) => fetchIndexStatus(id) }

/** The backend calls quizzes use. Tests pass fakes. */
export type QuizApi = {
  create: (request: AskRequest, signal?: AbortSignal) => Promise<WrittenQuiz>
  recommend: (request: RecommendationRequest) => Promise<string | null>
}

const realQuizApi: QuizApi = { create: (r, signal) => createQuiz(r, signal), recommend: (r) => fetchRecommendation(r) }

/**
 * How a topic's chat answers: `normal` answers questions; `socratic` has the model
 * ask the reader questions that lead them to the answer instead of explaining;
 * `quiz` has it write a multiple-choice quiz to click through.
 */
export type Mode = 'normal' | 'socratic' | 'quiz'

/**
 * A named group of PDFs that are read and asked about together. Each topic has
 * one chat, shared by all its tabs, and `draft` is the unsent question in it.
 * `context` is the spot the reader last clicked, attached to the next question.
 * `mode` is how the chat answers, picked in the chat or by a right-click.
 */
export type Topic = {
  id: string
  name: string
  docIds: string[]
  activeDocId?: string
  chat: ChatMessage[]
  draft: string
  context?: PageContext
  mode: Mode
}

/** One saved tab: the backend keeps its PDF, so only its id and where the reader was are saved. */
export type SavedDoc = {
  id: string
  name: string
  serverId: string
  page?: number
}

/** One saved topic. Its chat is saved without the page images, which only the newest question needs. */
export type SavedTopic = Omit<Topic, 'docIds' | 'draft' | 'context'> & {
  docs: SavedDoc[]
}

/** What is saved on disk (through the backend) so the workspace is back after a reload. */
export type SavedWorkspace = {
  version: 1
  activeTopicId?: string
  topics: SavedTopic[]
}

let nextId = 0
const newId = () => `${Date.now().toString(36)}-${nextId++}`

/** Topic name for a PDF opened without a topic: its file name without `.pdf`. */
export function topicNameFor(fileName: string): string {
  return fileName.replace(/\.pdf$/i, '') || fileName
}

/** The topics in the sidebar, their tabs, and which ones are selected. */
export class Workspace {
  topics = $state<Topic[]>([])
  // Raw: the PDF bytes should not be wrapped in reactive proxies.
  docs = $state.raw<Record<string, Doc>>({})
  activeTopicId = $state<string>()
  /** The model that answers new questions, picked in the chat. */
  answerModel = $state<string>()
  /** Indexing progress per PDF (by tab id). */
  indexing = $state<Record<string, IndexState>>({})
  /** The page each tab was last on, so it opens there next time. */
  pages = $state<Record<string, number>>({})
  // Uploads still on their way, so a question can wait for its PDFs' ids.
  private uploads: Record<string, Promise<unknown>> = {}
  // Stops each topic's answer that is still arriving. Not state: nothing renders from it.
  private answering = new Map<string, AbortController>()
  /** Where quizzes and notes on what to review come from. Tests swap in a fake. */
  quizApi: QuizApi = realQuizApi

  activeTopic = $derived(this.topics.find((t) => t.id === this.activeTopicId))
  activeDoc = $derived(this.activeTopic?.activeDocId ? this.docs[this.activeTopic.activeDocId] : undefined)

  topicOf(docId: string): Topic | undefined {
    return this.topics.find((t) => t.docIds.includes(docId))
  }

  createTopic(name = 'New topic'): Topic {
    this.topics.push({ id: newId(), name, docIds: [], chat: [], draft: '', mode: 'normal' })
    const topic = this.topics[this.topics.length - 1]
    this.activeTopicId = topic.id
    return topic
  }

  selectTopic(id: string) {
    if (this.topics.some((t) => t.id === id)) this.activeTopicId = id
  }

  renameTopic(id: string, name: string) {
    const topic = this.topics.find((t) => t.id === id)
    if (topic && name.trim()) topic.name = name.trim()
  }

  deleteTopic(id: string) {
    const index = this.topics.findIndex((t) => t.id === id)
    if (index === -1) return
    const [topic] = this.topics.splice(index, 1)
    this.answering.get(id)?.abort()
    this.docs = omit(this.docs, topic.docIds)
    for (const docId of topic.docIds) {
      delete this.indexing[docId]
      delete this.pages[docId]
    }
    if (this.activeTopicId === id) {
      this.activeTopicId = (this.topics[index] ?? this.topics[index - 1])?.id
    }
  }

  /**
   * Add a PDF as a tab in the active topic and switch to it. With no topic
   * selected, it starts a new topic named after the file. Adding the same file
   * to a topic twice just switches to its existing tab.
   */
  addDoc(name: string, data: Uint8Array): Doc {
    const topic = this.activeTopic ?? this.createTopic(topicNameFor(name))
    const existing = topic.docIds.map((id) => this.docs[id]).find((d) => d.name === name && sameBytes(d.data, data))
    if (existing) {
      topic.activeDocId = existing.id
      return existing
    }
    const doc = { id: newId(), name, data }
    this.docs = { ...this.docs, [doc.id]: doc }
    topic.docIds.push(doc.id)
    topic.activeDocId = doc.id
    return doc
  }

  /**
   * Send a PDF to the backend, which indexes it in the background, and follow
   * its progress until it is ready or fails. Stops following once the tab is closed.
   */
  async index(docId: string, api: IndexApi = realIndexApi, pollMs = 1500): Promise<void> {
    const doc = this.docs[docId]
    if (!doc) return
    // A PDF reopened from the saved workspace is already on the backend: just follow it.
    const known = this.indexing[docId]?.serverId
    this.indexing[docId] = { serverId: known, status: known ? 'queued' : 'uploading', pagesDone: 0, pageCount: 0 }
    const update = (s: IndexStatus) => {
      if (!(docId in this.docs)) return false
      this.indexing[docId] = { serverId: s.id, status: s.status, pagesDone: s.pages_done, pageCount: s.page_count, error: s.error }
      return s.status !== 'ready' && s.status !== 'error'
    }
    try {
      const upload = known ? api.status(known) : api.upload(doc.name, doc.data)
      this.uploads[docId] = upload.catch(() => {})
      let status = await upload
      while (update(status)) {
        await new Promise((resolve) => setTimeout(resolve, pollMs))
        if (!(docId in this.docs)) return
        status = await api.status(status.id)
      }
    } catch (error) {
      if (docId in this.docs) {
        const message = error instanceof Error ? error.message : String(error)
        this.indexing[docId] = { ...this.indexing[docId], status: 'error', error: message }
      }
    } finally {
      delete this.uploads[docId]
    }
  }

  /**
   * Attach what the reader pointed at to the topic's next question, replacing what was attached,
   * and switch to the mode it is for: a plain click or Ask is for asking (Normal); Socratic and
   * Quiz me in the right-click menu wait for what to focus on, then start.
   */
  attachContext(topicId: string, context: PageContext, mode: Mode = 'normal') {
    const topic = this.topics.find((t) => t.id === topicId)
    if (!topic) return
    topic.context = context
    topic.mode = mode
  }

  /** Replace the attached spot with the same spot and its images, once they are rendered. */
  fillContext(topicId: string, context: PageContext) {
    const topic = this.topics.find((t) => t.id === topicId)
    if (topic) topic.context = context
  }

  clearContext(topicId: string) {
    const topic = this.topics.find((t) => t.id === topicId)
    if (topic) topic.context = undefined
  }

  /**
   * Start the topic's chat over: forget its questions and answers, stop an answer that is
   * still arriving and go back to Normal mode. What belongs to the next question (the draft
   * and the attached spot) stays, and so do the tabs.
   */
  newChat(topicId: string) {
    const topic = this.topics.find((t) => t.id === topicId)
    if (!topic) return
    this.answering.get(topicId)?.abort()
    topic.chat = []
    topic.mode = 'normal'
  }

  /** Whether a topic's latest answer is still arriving. */
  isAnswering(topicId: string): boolean {
    return this.topics.find((t) => t.id === topicId)?.chat.at(-1)?.status === 'streaming'
  }

  /**
   * Whether the topic's draft can be sent now: not while an answer is arriving, and not
   * blank, except to start a quiz, or a Socratic session about the attached spot, where
   * what to focus on is optional.
   */
  canSend(topicId: string): boolean {
    const topic = this.topics.find((t) => t.id === topicId)
    if (!topic || this.isAnswering(topicId)) return false
    return !!topic.draft.trim() || topic.mode === 'quiz' || (topic.mode === 'socratic' && !!topic.context)
  }

  /**
   * Send the topic's draft as a question, with the attached context or, when
   * nothing is attached, whatever `fallback` gives (the open page), and stream
   * the answer into the chat. In Socratic mode the model replies with questions;
   * in Quiz mode it writes a quiz instead, about what the draft asks it to focus on.
   * Ignored when the draft can't be sent (see canSend).
   */
  async ask(
    topicId: string,
    fallback?: () => Promise<PageContext | undefined>,
    stream: AnswerStream = fetchAnswer,
    quizApi: QuizApi = this.quizApi,
  ): Promise<void> {
    const topic = this.topics.find((t) => t.id === topicId)
    if (!topic || !this.canSend(topicId)) return
    const { context } = topic
    const mode = topic.mode !== 'normal' && { mode: topic.mode }
    const question = { text: topic.draft.trim(), context, ...mode }
    topic.draft = ''
    topic.context = undefined
    const fill = context ? undefined : fallback
    if (topic.mode === 'quiz') {
      await this.converse(topic, question, fill, async (answer, request, signal) => {
        const written = await quizApi.create(request, signal)
        answer.quiz = { ...written, picked: written.questions.map(() => null) }
      })
    } else {
      await this.converse(topic, question, fill, async (answer, request, signal) => {
        for await (const event of stream(request, signal)) {
          if (signal.aborted) break
          if (event.type === 'text') answer.text += event.text
          else answer.steps = [...(answer.steps ?? []), event.text]
        }
      })
    }
  }

  /**
   * Record the reader's pick for one of a quiz's questions (each is answered once). Once
   * all are answered and some were wrong, Haiku writes a note on what to review.
   */
  async answerQuiz(
    topicId: string,
    messageId: string,
    question: number,
    choice: number,
    api: QuizApi = this.quizApi,
  ): Promise<void> {
    const topic = this.topics.find((t) => t.id === topicId)
    const index = topic?.chat.findIndex((m) => m.id === messageId) ?? -1
    const quiz = topic?.chat[index]?.quiz
    if (!topic || !quiz || quiz.picked[question] !== null || !quiz.questions[question]?.choices[choice]) return
    quiz.picked[question] = choice
    const right = quiz.questions.filter((q, i) => quiz.picked[i] === q.answer).length
    if (quiz.picked.some((p) => p === null) || right === quiz.questions.length) return
    const asked = topic.chat[index - 1]
    quiz.reviewing = 'writing'
    try {
      const recommendation = await api.recommend({
        topic: topic.name,
        about: {
          role: 'user',
          text: asked?.text ?? '',
          ...(asked?.context && { context: contextForRequest(asked.context, false, this.indexing[asked.context.docId]?.serverId) }),
        },
        quiz: quizRecord(quiz),
      })
      if (recommendation) quiz.recommendation = recommendation
      quiz.reviewing = undefined
    } catch {
      quiz.reviewing = 'failed'
    }
  }

  /** Switch how the topic's chat answers, from the next question on. */
  setMode(topicId: string, mode: Mode) {
    const topic = this.topics.find((t) => t.id === topicId)
    if (topic) topic.mode = mode
  }

  /**
   * Add a question to the chat and an answer under it, which `respond` fills in from the
   * backend (streaming text, or a quiz). `fill` gives the question's context (the open
   * page, or the spot with its images) before it is sent.
   */
  private async converse(
    topic: Topic,
    asked: Pick<ChatMessage, 'text' | 'context' | 'mode'>,
    fill: (() => Promise<PageContext | undefined>) | undefined,
    respond: (answer: ChatMessage, request: AskRequest, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const mode = asked.mode && { mode: asked.mode }
    topic.chat.push({ id: newId(), role: 'user', ...asked })
    topic.chat.push({ id: newId(), role: 'assistant', text: '', status: 'streaming', ...mode })
    // Read back through the topic, so changes go through Svelte's state.
    const question = topic.chat[topic.chat.length - 2]
    const answer = topic.chat[topic.chat.length - 1]
    const topicId = topic.id
    const controller = new AbortController()
    this.answering.set(topicId, controller)
    try {
      const filled = await fill?.().catch(() => undefined)
      if (filled) question.context = filled
      const uploading = topic.docIds.filter((id) => id in this.uploads).map((id) => this.uploads[id])
      if (uploading.length) await Promise.all(uploading)
      const serverId = (id: string) => this.indexing[id]?.serverId
      await respond(answer, askRequest(topic, serverId, this.answerModel), controller.signal)
      answer.status = 'done'
    } catch (error) {
      answer.status = 'error'
      answer.text = error instanceof Error ? error.message : String(error)
    } finally {
      if (this.answering.get(topicId) === controller) this.answering.delete(topicId)
    }
  }

  selectDoc(id: string) {
    const topic = this.topicOf(id)
    if (!topic) return
    topic.activeDocId = id
    this.activeTopicId = topic.id
  }

  /** Close a tab. The tab to its right (or else its left) becomes active. */
  closeDoc(id: string) {
    const topic = this.topicOf(id)
    if (!topic) return
    const index = topic.docIds.indexOf(id)
    topic.docIds.splice(index, 1)
    if (topic.activeDocId === id) topic.activeDocId = topic.docIds[index] ?? topic.docIds[index - 1]
    if (topic.context?.docId === id) topic.context = undefined
    this.docs = omit(this.docs, [id])
    delete this.indexing[id]
    delete this.pages[id]
  }

  /**
   * What to save so the workspace is back next time: the topics, their tabs, chats and
   * modes. Tabs not yet on the backend are left out, and so are the draft and the
   * attached spot, which belong to the moment.
   */
  snapshot(): SavedWorkspace {
    return {
      version: 1,
      activeTopicId: this.activeTopicId,
      topics: this.topics.map((topic) => {
        const docs = topic.docIds.flatMap((id): SavedDoc[] => {
          const serverId = this.indexing[id]?.serverId
          const page = this.pages[id]
          return serverId ? [{ id, name: this.docs[id].name, serverId, ...(page > 1 && { page }) }] : []
        })
        return {
          id: topic.id,
          name: topic.name,
          docs,
          activeDocId: docs.some((d) => d.id === topic.activeDocId) ? topic.activeDocId : docs[0]?.id,
          mode: topic.mode,
          chat: topic.chat.map(savedMessage),
        }
      }),
    }
  }

  /**
   * Bring back a saved workspace. `loadPdf` fetches a tab's PDF from the backend; a tab
   * whose PDF is gone is dropped. Topics opened while it loaded are kept, after the saved
   * ones. Returns the tabs restored, to follow their indexing.
   */
  async restore(saved: unknown, loadPdf: (serverId: string) => Promise<Uint8Array>): Promise<string[]> {
    if (!isSavedWorkspace(saved)) return []
    const loaded = await Promise.all(
      saved.topics
        .flatMap((t) => t.docs)
        .map(async (d) => [d, await loadPdf(d.serverId).catch(() => undefined)] as const),
    )
    const docs: Record<string, Doc> = {}
    const indexing: Record<string, IndexState> = {}
    const pages: Record<string, number> = {}
    for (const [d, data] of loaded) {
      if (!data) continue
      docs[d.id] = { id: d.id, name: d.name, data }
      indexing[d.id] = { serverId: d.serverId, status: 'queued', pagesDone: 0, pageCount: 0 }
      if (d.page) pages[d.id] = d.page
    }
    this.docs = { ...docs, ...this.docs }
    this.indexing = { ...indexing, ...this.indexing }
    this.pages = { ...pages, ...this.pages }
    const restored = saved.topics.map((t): Topic => {
      const docIds = t.docs.map((d) => d.id).filter((id) => id in docs)
      return {
        id: t.id,
        name: t.name,
        docIds,
        activeDocId: t.activeDocId && docIds.includes(t.activeDocId) ? t.activeDocId : docIds[0],
        chat: t.chat.map(restoredMessage),
        draft: '',
        mode: t.mode === 'socratic' || t.mode === 'quiz' ? t.mode : 'normal',
      }
    })
    this.topics = [...restored, ...this.topics]
    if (!this.activeTopicId) {
      this.activeTopicId = restored.some((t) => t.id === saved.activeTopicId) ? saved.activeTopicId : restored[0]?.id
    }
    return Object.keys(docs)
  }
}

function isSavedWorkspace(value: unknown): value is SavedWorkspace {
  const saved = value as SavedWorkspace | null
  return !!saved && saved.version === 1 && Array.isArray(saved.topics)
}

/** A message as saved: its spot without the page image and text, which only a new question sends. */
function savedMessage(message: ChatMessage): ChatMessage {
  const { context, ...rest } = message
  if (!context) return { ...rest }
  const { pageImage: _image, imagePages: _pages, pageTexts: _texts, ...spot } = context
  return { ...rest, context: { ...spot, pageTexts: [] } }
}

/** An answer (or a note on what to review) that was still arriving when the app closed did not finish. */
function restoredMessage(message: ChatMessage): ChatMessage {
  if (message.quiz?.reviewing === 'writing') return { ...message, quiz: { ...message.quiz, reviewing: 'failed' } }
  if (message.status !== 'streaming') return message
  const stopped = message.mode === 'quiz' ? 'The quiz stopped when the app was closed.' : 'The answer stopped when the app was closed.'
  return { ...message, status: 'error', text: message.text || stopped }
}

/** A quiz as the backend reads it. */
function quizRecord({ title, questions, picked, recommendation }: Quiz): QuizRecord {
  return { title, questions, picked, ...(recommendation && { recommendation }) }
}

/**
 * What the backend needs to answer a topic's newest question: the conversation
 * so far, and the backend's ids of the topic's PDFs so it can look things up in
 * them. Only the newest question carries images, which keeps requests small.
 */
export function askRequest(
  topic: Topic,
  serverId: (docId: string) => string | undefined = () => undefined,
  model?: string,
): AskRequest {
  const turns = topic.chat.filter((m) => m.status !== 'streaming')
  return {
    topic: topic.name,
    ...(model && { model }),
    docs: topic.docIds.map(serverId).filter((id): id is string => !!id),
    messages: turns.map((m, i) => ({
      role: m.role,
      text: m.status === 'error' ? '' : m.text,
      context: m.context && contextForRequest(m.context, i === turns.length - 1, serverId(m.context.docId)),
      ...(m.role === 'user' && m.mode && { mode: m.mode }),
      ...(m.quiz && { quiz: quizRecord(m.quiz) }),
    })),
  }
}

function contextForRequest(context: PageContext, withImages: boolean, docId: string | undefined) {
  return {
    doc_id: docId,
    doc_name: context.docName,
    page: context.page,
    page_label: context.pageLabel,
    section: context.section,
    point: context.point,
    selection: context.selection,
    nearby_text: context.nearbyText,
    ...(withImages && {
      page_image: context.pageImage,
      image_pages: context.imagePages,
      page_texts: context.pageTexts,
    }),
  }
}

function omit<T>(record: Record<string, T>, keys: string[]): Record<string, T> {
  const copy = { ...record }
  for (const key of keys) delete copy[key]
  return copy
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
