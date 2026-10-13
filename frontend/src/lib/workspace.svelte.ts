import {
  type AnswerStream,
  type AskRequest,
  createQuiz,
  fetchAnswer,
  fetchChatTitle,
  fetchIndexStatus,
  fetchRecommendation,
  type IndexStatus,
  type QuizRecord,
  type RecommendationRequest,
  type TitleRequest,
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
 * One discussion in a topic: its messages and how it answers (`mode`, picked in the chat or
 * by a right-click). `title` is a few words Haiku writes after the first question;
 * `updatedAt` is when a question was last sent, which orders the topic's discussions.
 */
export type Chat = {
  id: string
  title?: string
  messages: ChatMessage[]
  mode: Mode
  updatedAt: number
}

/**
 * A named group of PDFs that are read and asked about together. Each topic has
 * its discussions, shared by all its tabs, one of them open (`chatId`). `draft` is
 * the unsent question and `context` the spot the reader last clicked, attached to the
 * next question; both stay with the topic when another discussion is opened.
 */
export type Topic = {
  id: string
  name: string
  docIds: string[]
  activeDocId?: string
  chats: Chat[]
  chatId: string
  draft: string
  context?: PageContext
}

/** One saved tab: the backend keeps its PDF, so only its id and where the reader was are saved. */
export type SavedDoc = {
  id: string
  name: string
  serverId: string
  page?: number
}

/**
 * One saved topic. Its chats are saved without the page images, which only the newest question
 * needs. Workspaces saved before a topic had several discussions have one `chat` and `mode`.
 */
export type SavedTopic = Omit<Topic, 'docIds' | 'draft' | 'context' | 'chats' | 'chatId'> & {
  docs: SavedDoc[]
  chats?: Chat[]
  chatId?: string
  chat?: ChatMessage[]
  mode?: Mode
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

/** A discussion with nothing in it yet. */
function emptyChat(): Chat {
  return { id: newId(), messages: [], mode: 'normal', updatedAt: Date.now() }
}

/** The discussion open in a topic. There always is one. */
export function chatOf(topic: Topic): Chat {
  return topic.chats.find((c) => c.id === topic.chatId) ?? topic.chats[0]
}

/** A topic's discussions that have something in them, the most recently used first. */
export function discussions(topic: Topic): Chat[] {
  return topic.chats.filter((c) => c.messages.length).sort((a, b) => b.updatedAt - a.updatedAt)
}

/** What a discussion is called: Haiku's title, or until it comes, the start of its first question. */
export function chatTitle(chat: Chat): string {
  if (chat.title) return chat.title
  const first = chat.messages.find((m) => m.role === 'user')
  if (!first) return 'New chat'
  const text = first.text.trim().replace(/\s+/g, ' ')
  if (text) return text.length > 48 ? `${text.slice(0, 47).trimEnd()}…` : text
  if (first.mode === 'quiz') return 'Quiz'
  if (first.mode === 'socratic') return 'Socratic session'
  return 'New chat'
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
  /** Where discussions' titles come from. Tests swap in a fake. */
  titleApi: (request: TitleRequest) => Promise<string | null> = (r) => fetchChatTitle(r)

  activeTopic = $derived(this.topics.find((t) => t.id === this.activeTopicId))
  activeDoc = $derived(this.activeTopic?.activeDocId ? this.docs[this.activeTopic.activeDocId] : undefined)

  topicOf(docId: string): Topic | undefined {
    return this.topics.find((t) => t.docIds.includes(docId))
  }

  createTopic(name = 'New topic'): Topic {
    const chat = emptyChat()
    this.topics.push({ id: newId(), name, docIds: [], chats: [chat], chatId: chat.id, draft: '' })
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
    for (const chat of topic.chats) this.answering.get(chat.id)?.abort()
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
    chatOf(topic).mode = mode
  }

  /** Replace the attached spot with the same spot and its images, once they are rendered. */
  fillContext(topicId: string, context: PageContext) {
    const topic = this.topics.find((t) => t.id === topicId)
    if (topic) topic.context = context
  }

  /**
   * Take the attached spot off the topic's next question. A spot attached for a Socratic
   * session or a quiz is what that mode was waiting for, so taking it off cancels the mode too.
   */
  clearContext(topicId: string) {
    const topic = this.topics.find((t) => t.id === topicId)
    if (!topic?.context) return
    topic.context = undefined
    chatOf(topic).mode = 'normal'
  }

  /**
   * Open a new, empty discussion in the topic, in Normal mode. The one that was open stays in
   * the list, and an answer still arriving in it goes on. When the open discussion is still
   * empty it is reused, so empty ones never pile up. What belongs to the next question (the
   * draft and the attached spot) stays, and so do the tabs.
   */
  newChat(topicId: string) {
    const topic = this.topics.find((t) => t.id === topicId)
    if (!topic) return
    const open = chatOf(topic)
    if (!open.messages.length) {
      open.mode = 'normal'
      return
    }
    const chat = emptyChat()
    topic.chats.push(chat)
    topic.chatId = chat.id
  }

  /** Open another of the topic's discussions. The one left goes away if nothing was asked in it. */
  selectChat(topicId: string, chatId: string) {
    const topic = this.topics.find((t) => t.id === topicId)
    if (!topic || topic.chatId === chatId || !topic.chats.some((c) => c.id === chatId)) return
    const left = chatOf(topic)
    if (!left.messages.length) topic.chats = topic.chats.filter((c) => c.id !== left.id)
    topic.chatId = chatId
  }

  /**
   * Delete one of the topic's discussions, stopping an answer still arriving in it. If it was
   * the open one, a new, empty chat opens in its place.
   */
  deleteChat(topicId: string, chatId: string) {
    const topic = this.topics.find((t) => t.id === topicId)
    if (!topic?.chats.some((c) => c.id === chatId)) return
    this.answering.get(chatId)?.abort()
    topic.chats = topic.chats.filter((c) => c.id !== chatId)
    if (topic.chatId !== chatId) return
    const chat = emptyChat()
    topic.chats.push(chat)
    topic.chatId = chat.id
  }

  /** Whether a discussion's latest answer is still arriving. */
  isChatAnswering(chat: Chat): boolean {
    return chat.messages.at(-1)?.status === 'streaming'
  }

  /** Whether the latest answer in a topic's open discussion is still arriving. */
  isAnswering(topicId: string): boolean {
    const topic = this.topics.find((t) => t.id === topicId)
    return !!topic && this.isChatAnswering(chatOf(topic))
  }

  /**
   * Whether the topic's draft can be sent now: not while an answer is arriving, and not
   * blank, except to start a quiz, or a Socratic session about the attached spot, where
   * what to focus on is optional.
   */
  canSend(topicId: string): boolean {
    const topic = this.topics.find((t) => t.id === topicId)
    if (!topic || this.isAnswering(topicId)) return false
    const { mode } = chatOf(topic)
    return !!topic.draft.trim() || mode === 'quiz' || (mode === 'socratic' && !!topic.context)
  }

  /**
   * Send the topic's draft as a question, with the attached context or, when
   * nothing is attached, whatever `fallback` gives (the open page), and stream
   * the answer into the chat. In Socratic mode the model replies with questions;
   * in Quiz mode it writes a quiz instead, about what the draft asks it to focus on, and the
   * chat goes back to Normal. Ignored when the draft can't be sent (see canSend).
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
    const chat = chatOf(topic)
    const mode = chat.mode !== 'normal' && { mode: chat.mode }
    const question = { text: topic.draft.trim(), context, ...mode }
    topic.draft = ''
    topic.context = undefined
    const fill = context ? undefined : fallback
    if (chat.mode === 'quiz') {
      chat.mode = 'normal'
      await this.converse(topic, chat, question, fill, async (answer, request, signal) => {
        const written = await quizApi.create(request, signal)
        answer.quiz = { ...written, picked: written.questions.map(() => null) }
      })
    } else {
      await this.converse(topic, chat, question, fill, async (answer, request, signal) => {
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
    const chat = topic?.chats.find((c) => c.messages.some((m) => m.id === messageId))
    const index = chat?.messages.findIndex((m) => m.id === messageId) ?? -1
    const quiz = chat?.messages[index]?.quiz
    if (!topic || !chat || !quiz || quiz.picked[question] !== null || !quiz.questions[question]?.choices[choice]) return
    quiz.picked[question] = choice
    const right = quiz.questions.filter((q, i) => quiz.picked[i] === q.answer).length
    if (quiz.picked.some((p) => p === null) || right === quiz.questions.length) return
    const asked = chat.messages[index - 1]
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

  /** Switch how the topic's open discussion answers, from the next question on. */
  setMode(topicId: string, mode: Mode) {
    const topic = this.topics.find((t) => t.id === topicId)
    if (topic) chatOf(topic).mode = mode
  }

  /**
   * Add a question to a discussion and an answer under it, which `respond` fills in from the
   * backend (streaming text, or a quiz). `fill` gives the question's context (the open
   * page, or the spot with its images) before it is sent. The first question also has
   * Haiku name the discussion.
   */
  private async converse(
    topic: Topic,
    chat: Chat,
    asked: Pick<ChatMessage, 'text' | 'context' | 'mode'>,
    fill: (() => Promise<PageContext | undefined>) | undefined,
    respond: (answer: ChatMessage, request: AskRequest, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const mode = asked.mode && { mode: asked.mode }
    const first = !chat.messages.length
    chat.messages.push({ id: newId(), role: 'user', ...asked })
    chat.messages.push({ id: newId(), role: 'assistant', text: '', status: 'streaming', ...mode })
    chat.updatedAt = Date.now()
    // Read back through the chat, so changes go through Svelte's state.
    const question = chat.messages[chat.messages.length - 2]
    const answer = chat.messages[chat.messages.length - 1]
    const chatId = chat.id
    const controller = new AbortController()
    this.answering.set(chatId, controller)
    try {
      const filled = await fill?.().catch(() => undefined)
      if (filled) question.context = filled
      if (first) void this.nameChat(topic, chat)
      const uploading = topic.docIds.filter((id) => id in this.uploads).map((id) => this.uploads[id])
      if (uploading.length) await Promise.all(uploading)
      const serverId = (id: string) => this.indexing[id]?.serverId
      await respond(answer, askRequest(topic, serverId, this.answerModel, chat), controller.signal)
      answer.status = 'done'
    } catch (error) {
      answer.status = 'error'
      answer.text = error instanceof Error ? error.message : String(error)
    } finally {
      if (this.answering.get(chatId) === controller) this.answering.delete(chatId)
    }
  }

  /**
   * Have Haiku title a discussion from its first question. Until it answers (or if it
   * can't), the discussion goes by the start of the question.
   */
  private async nameChat(topic: Topic, chat: Chat): Promise<void> {
    const asked = chat.messages.find((m) => m.role === 'user')
    if (!asked) return
    const context = asked.context && contextForRequest(asked.context, false, this.indexing[asked.context.docId]?.serverId)
    try {
      const title = await this.titleApi({
        topic: topic.name,
        about: { role: 'user', text: asked.text, ...(asked.mode && { mode: asked.mode }), ...(context && { context }) },
      })
      // A discussion deleted meanwhile is no longer in its topic; the title just goes nowhere.
      if (title) chat.title = title
    } catch {
      // Without a title, the start of the question stands in.
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
          chatId: topic.chatId,
          chats: topic.chats
            .filter((c) => c.messages.length || c.id === topic.chatId)
            .map((c) => ({ ...c, messages: c.messages.map(savedMessage) })),
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
        ...restoredChats(t),
        draft: '',
      }
    })
    this.topics = [...restored, ...this.topics]
    // Discussions saved before they had titles get one now, once.
    for (const topic of this.topics.slice(0, restored.length)) {
      for (const chat of topic.chats) if (!chat.title && chat.messages.length) void this.nameChat(topic, chat)
    }
    if (!this.activeTopicId) {
      this.activeTopicId = restored.some((t) => t.id === saved.activeTopicId) ? saved.activeTopicId : restored[0]?.id
    }
    return Object.keys(docs)
  }
}

/**
 * A saved topic's discussions, with one open. A topic saved when it had only one chat
 * brings it back as its one discussion.
 */
function restoredChats(saved: SavedTopic): Pick<Topic, 'chats' | 'chatId'> {
  const chats: Chat[] = Array.isArray(saved.chats)
    ? saved.chats.map((c) => ({
        id: c.id,
        ...(c.title && { title: c.title }),
        messages: c.messages.map(restoredMessage),
        mode: validMode(c.mode),
        updatedAt: c.updatedAt || 0,
      }))
    : [{ id: newId(), messages: (saved.chat ?? []).map(restoredMessage), mode: validMode(saved.mode), updatedAt: 0 }]
  if (!chats.length) chats.push(emptyChat())
  const chatId = chats.some((c) => c.id === saved.chatId) ? saved.chatId! : chats[0].id
  return { chats, chatId }
}

function validMode(mode: unknown): Mode {
  return mode === 'socratic' || mode === 'quiz' ? mode : 'normal'
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
 * What the backend needs to answer the newest question in a topic's discussion: the conversation
 * so far, and the backend's ids of the topic's PDFs so it can look things up in
 * them. Only the newest question carries images, which keeps requests small.
 */
export function askRequest(
  topic: Topic,
  serverId: (docId: string) => string | undefined = () => undefined,
  model?: string,
  chat: Chat = chatOf(topic),
): AskRequest {
  const turns = chat.messages.filter((m) => m.status !== 'streaming')
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
