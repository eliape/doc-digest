import {
  type AnswerStream,
  type AskRequest,
  type AskTurn,
  createQuiz,
  type DiscussionRequest,
  fetchAnswer,
  fetchChatTitle,
  fetchIndexStatus,
  fetchPdf,
  fetchRecommendation,
  forgetRegister,
  type IndexStatus,
  noteDiscussion,
  type QuizRecord,
  type RecommendationRequest,
  retryIndex,
  type TitleRequest,
  uploadDoc,
  type WrittenQuiz,
} from './api'
import type { PageContext } from './context'
import { type FlashcardRequest, forgetDeck } from './flashcards'

/**
 * A PDF opened in a topic. Each one is a tab. `data` is the PDF itself. A tab brought back from the saved workspace gets it from the backend
 * once it is shown (see loadPdf), so until then it has none.
 */
export type Doc = { id: string; name: string; data?: Uint8Array }

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
  /** On the reader's side: the part of an earlier answer they replied to. */
  quote?: string
  mode?: 'socratic' | 'quiz'
  status?: 'streaming' | 'done' | 'error'
  /** The lookups the model made while answering, e.g. "Read book.pdf, pp. 4–5". */
  steps?: string[]
  /**
   * On the model's side: the API's summary of what the model thought about while answering
   * (it never returns the thinking itself), and how long it thought. Shown, not sent back.
   */
  thinking?: string
  thinkingSeconds?: number
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
  retry?: (serverId: string) => Promise<IndexStatus>
}

const realIndexApi: IndexApi = {
  upload: (name, data) => uploadDoc(name, data),
  status: (id) => fetchIndexStatus(id),
  retry: (id) => retryIndex(id),
}

/** The backend calls quizzes use. Tests pass fakes. */
export type QuizApi = {
  create: (request: AskRequest, signal?: AbortSignal) => Promise<WrittenQuiz>
  recommend: (request: RecommendationRequest) => Promise<string | null>
}

const realQuizApi: QuizApi = { create: (r, signal) => createQuiz(r, signal), recommend: (r) => fetchRecommendation(r) }

/**
 * The backend calls the topics' registers use: `note` has Haiku note what is new in a discussion
 * the reader left, and `forget` deletes a deleted topic's notes. Tests pass fakes.
 */
export type RegisterApi = {
  note: (topicId: string, request: DiscussionRequest) => Promise<void>
  forget: (topicId: string) => Promise<void>
}

const realRegisterApi: RegisterApi = { note: (id, r) => noteDiscussion(id, r), forget: (id) => forgetRegister(id) }

/**
 * What flashcards are made from: a spot or selection in a PDF (its images may still be rendering),
 * or a discussion up to one of its answers.
 */
export type FlashcardSource =
  | { kind: 'pick'; context: PageContext; ready?: Promise<PageContext | undefined> }
  | { kind: 'chat'; chatId: string; messageId: string }

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
  /** A discussion branched off another: which one, and how many of its messages it starts with. */
  branch?: Branch
}

/** Where a branched discussion came from: the original's id and the number of messages copied from it. */
export type Branch = { from: string; at: number }

/**
 * A named group of PDFs that are read and asked about together. Each topic has
 * its discussions, shared by all its tabs, one of them open (`chatId`). `draft` is
 * the unsent question and `context` the spot the reader last clicked, attached to the
 * next question; both stay with the topic when another discussion is opened. `quote` is a part
 * of an answer the reader is replying to, which belongs to the open discussion.
 */
export type Topic = {
  id: string
  name: string
  /** Every PDF in the topic: its sources, all of them in the model's context. */
  docIds: string[]
  /** The sources shown as tabs, in tab order. Closing a tab only takes it off this list. */
  openDocIds: string[]
  activeDocId?: string
  /** Whether the sidebar shows the topic's sources (closed unless set) and discussions (open unless false). */
  sourcesOpen?: boolean
  discussionsOpen?: boolean
  chats: Chat[]
  chatId: string
  draft: string
  context?: PageContext
  quote?: string
  /** What the reader studies the topic for, in their words (Conventions and purpose, in the topic's ⋮ menu). */
  purpose?: string
  /** Conventions the topic's answers follow, like notation and sign conventions, in the reader's words. */
  conventions?: string
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
export type SavedTopic = Omit<Topic, 'docIds' | 'openDocIds' | 'draft' | 'context' | 'quote' | 'chats' | 'chatId'> & {
  docs: SavedDoc[]
  /** The ids of the open tabs, in order. Saved before sources could be closed: all are open. */
  open?: string[]
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
  /** The reader's own instructions for every answer, set in Settings. */
  instructions?: string
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

/** Why an answer was aborted when the reader pressed Stop (rather than deleting its discussion). */
const STOPPED = 'stopped'

/** The topics in the sidebar, their tabs, and which ones are selected. */
export class Workspace {
  topics = $state<Topic[]>([])
  // Raw: the PDF bytes should not be wrapped in reactive proxies.
  docs = $state.raw<Record<string, Doc>>({})
  activeTopicId = $state<string>()
  /** The model that answers new questions, picked in the chat. */
  answerModel = $state<string>()
  /** How hard the model works on new answers and quizzes, picked in the chat. */
  answerEffort = $state<string>()
  /** The reader's own instructions, sent with every question (set in Settings). */
  instructions = $state('')
  /** Indexing progress per PDF (by tab id). */
  indexing = $state<Record<string, IndexState>>({})
  /** The page each tab was last on, so it opens there next time. */
  pages = $state<Record<string, number>>({})
  /** Why a tab's PDF can't be shown (it could not be fetched or opened), by tab id. */
  pdfErrors = $state<Record<string, string>>({})
  /** Where saved tabs' PDFs come from. Tests swap in a fake. */
  pdfApi: (serverId: string) => Promise<Uint8Array> = (id) => fetchPdf(id)
  // Tabs whose PDF is being fetched.
  private fetching = new Set<string>()
  // Tabs whose indexing is being followed.
  private following = new Set<string>()
  // Uploads still on their way, so a question can wait for its PDFs' ids.
  private uploads: Record<string, Promise<unknown>> = {}
  // Backend ids of PDFs taken out of every topic, for the next save to delete (see takeReleased).
  private released = new Set<string>()
  // Stops each topic's answer that is still arriving. Not state: nothing renders from it.
  private answering = new Map<string, AbortController>()
  /** Where quizzes and notes on what to review come from. Tests swap in a fake. */
  quizApi: QuizApi = realQuizApi
  /** Where discussions' titles come from. Tests swap in a fake. */
  titleApi: (request: TitleRequest) => Promise<string | null> = (r) => fetchChatTitle(r)
  /** Where the topics' registers are kept. Tests swap in a fake. */
  registerApi: RegisterApi = realRegisterApi
  /** Deletes a deleted topic's flashcards. Tests swap in a fake. */
  forgetDeck: (topicId: string) => Promise<void> = (id) => forgetDeck(id)

  activeTopic = $derived(this.topics.find((t) => t.id === this.activeTopicId))
  activeDoc = $derived(this.activeTopic?.activeDocId ? this.docs[this.activeTopic.activeDocId] : undefined)

  topicOf(docId: string): Topic | undefined {
    return this.topics.find((t) => t.docIds.includes(docId))
  }

  createTopic(name = 'New topic'): Topic {
    const left = this.openDiscussion()
    const chat = emptyChat()
    this.topics.push({ id: newId(), name, docIds: [], openDocIds: [], chats: [chat], chatId: chat.id, draft: '' })
    const topic = this.topics[this.topics.length - 1]
    this.activeTopicId = topic.id
    this.noteIfLeft(left)
    return topic
  }

  selectTopic(id: string) {
    if (!this.topics.some((t) => t.id === id)) return
    const left = this.openDiscussion()
    this.activeTopicId = id
    this.noteIfLeft(left)
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
    void this.registerApi.forget(topic.id).catch(() => {})
    void this.forgetDeck(topic.id).catch(() => {})
    const serverIds = topic.docIds.map((docId) => this.indexing[docId]?.serverId)
    this.docs = omit(this.docs, topic.docIds)
    for (const docId of topic.docIds) {
      delete this.indexing[docId]
      delete this.pages[docId]
      delete this.pdfErrors[docId]
    }
    for (const serverId of serverIds) this.release(serverId)
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
    // A tab not shown since a reload has no data yet; if it is this file, the upload finds it (see index).
    const existing = topic.docIds.map((id) => this.docs[id]).find((d) => d.data && sameBytes(d.data, data))
    if (existing) {
      if (!topic.openDocIds.includes(existing.id)) topic.openDocIds.push(existing.id)
      topic.activeDocId = existing.id
      return existing
    }
    const doc = { id: newId(), name, data }
    this.docs = { ...this.docs, [doc.id]: doc }
    topic.docIds.push(doc.id)
    topic.openDocIds.push(doc.id)
    topic.activeDocId = doc.id
    return doc
  }

  /**
   * Send a PDF to the backend, which indexes it in the background, and follow
   * its progress until it is ready or fails. Stops following once the PDF is removed.
   */
  async index(docId: string, api: IndexApi = realIndexApi, pollMs = 1500): Promise<void> {
    const doc = this.docs[docId]
    if (!doc || this.following.has(docId)) return
    // A PDF reopened from the saved workspace is already on the backend: just follow it.
    const known = this.indexing[docId]?.serverId
    if (!known && !doc.data) return
    this.following.add(docId)
    // A known PDF keeps the status it has until the backend gives a new one.
    if (!known) this.indexing[docId] = { status: 'uploading', pagesDone: 0, pageCount: 0 }
    const update = (s: IndexStatus) => {
      if (!(docId in this.docs)) return false
      this.indexing[docId] = { serverId: s.id, status: s.status, pagesDone: s.pages_done, pageCount: s.page_count, error: s.error }
      return s.status !== 'ready' && s.status !== 'error'
    }
    try {
      const upload = known ? api.status(known) : api.upload(doc.name, doc.data!)
      this.uploads[docId] = upload.catch(() => {})
      let status = await upload
      // Removed while it uploaded: the backend now has a PDF no topic may have.
      if (!known && !(docId in this.docs)) return this.release(status.id)
      if (!known && this.sameAsSaved(docId, status.id)) return
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
      this.following.delete(docId)
    }
  }

  /**
   * An upload that turned out to be a PDF already in its topic (one not shown since a reload, so
   * its bytes couldn't be compared): drop the new tab and show the one it already had.
   */
  private sameAsSaved(docId: string, serverId: string): boolean {
    const topic = this.topicOf(docId)
    const saved = topic?.docIds.find((id) => id !== docId && this.indexing[id]?.serverId === serverId)
    if (!topic || !saved) return false
    const wasActive = topic.activeDocId === docId
    this.removeDoc(docId)
    if (!topic.openDocIds.includes(saved)) topic.openDocIds.push(saved)
    if (wasActive || !topic.activeDocId) topic.activeDocId = saved
    return true
  }

  /** Index a PDF again after indexing failed, and follow it. */
  async retryIndex(docId: string, api: IndexApi = realIndexApi): Promise<void> {
    const serverId = this.indexing[docId]?.serverId
    if (!serverId || this.indexing[docId]?.status !== 'error' || !api.retry) return
    this.indexing[docId] = { ...this.indexing[docId], status: 'queued', error: undefined }
    try {
      await api.retry(serverId)
    } catch (error) {
      if (docId in this.docs) {
        const message = error instanceof Error ? error.message : String(error)
        this.indexing[docId] = { ...this.indexing[docId], status: 'error', error: message }
      }
      return
    }
    await this.index(docId, api)
  }

  /**
   * Fetch a saved tab's PDF from the backend, once it is to be shown. If it can't be fetched,
   * the tab stays in its topic with the reason in `pdfErrors`, and calling this again retries.
   */
  async loadPdf(docId: string): Promise<void> {
    const doc = this.docs[docId]
    const serverId = this.indexing[docId]?.serverId
    if (!doc || doc.data || !serverId || this.fetching.has(docId)) return
    this.fetching.add(docId)
    delete this.pdfErrors[docId]
    try {
      const data = await this.pdfApi(serverId)
      if (docId in this.docs) this.docs = { ...this.docs, [docId]: { ...this.docs[docId], data } }
    } catch (error) {
      if (docId in this.docs) {
        const reason = error instanceof Error ? error.message : String(error)
        this.pdfErrors[docId] = `Could not load ${doc.name} from the backend (${reason}).`
      }
    } finally {
      this.fetching.delete(docId)
    }
  }

  /** A PDF that could not be opened: show why in its tab, keeping it in its topic. */
  pdfFailed(docId: string, reason: string) {
    if (docId in this.docs) this.pdfErrors[docId] = reason
  }

  /** Try showing a tab's PDF again after it failed. */
  retryPdf(docId: string) {
    delete this.pdfErrors[docId]
    void this.loadPdf(docId)
  }

  /**
   * Attach what the reader pointed at to the topic's next question, replacing what was attached,
   * and switch to the mode it is for: a plain click or Ask is for asking (Normal) in the open
   * discussion; Socratic and Quiz me in the right-click menu open a new discussion and wait
   * there for what to focus on, then start.
   */
  attachContext(topicId: string, context: PageContext, mode: Mode = 'normal') {
    const topic = this.topics.find((t) => t.id === topicId)
    if (!topic) return
    if (mode !== 'normal') this.newChat(topicId)
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
    topic.quote = undefined
    this.noteDiscussion(topic, open)
  }

  /** Open another of the topic's discussions. The one left goes away if nothing was asked in it. */
  selectChat(topicId: string, chatId: string) {
    const topic = this.topics.find((t) => t.id === topicId)
    if (!topic || topic.chatId === chatId || !topic.chats.some((c) => c.id === chatId)) return
    const left = chatOf(topic)
    if (!left.messages.length) topic.chats = topic.chats.filter((c) => c.id !== left.id)
    topic.chatId = chatId
    topic.quote = undefined
    this.noteDiscussion(topic, left)
  }

  /**
   * Continue a discussion from one of its answers in a new discussion, which gets a copy of the
   * messages up to and including that answer, the same mode, and opens. The original stays as it was.
   */
  splitChat(topicId: string, messageId: string) {
    const topic = this.topics.find((t) => t.id === topicId)
    const from = topic?.chats.find((c) => c.messages.some((m) => m.id === messageId))
    if (!topic || !from) return
    const end = from.messages.findIndex((m) => m.id === messageId) + 1
    const messages = $state.snapshot(from.messages.slice(0, end)).map((m) => ({ ...m, id: newId() }) as ChatMessage)
    const chat: Chat = {
      id: newId(),
      title: `Branch · ${chatTitle(from).replace(/^(Branch · )+/, '')}`,
      messages,
      mode: from.mode,
      updatedAt: Date.now(),
      branch: { from: from.id, at: end },
    }
    const left = chatOf(topic)
    if (!left.messages.length) topic.chats = topic.chats.filter((c) => c.id !== left.id)
    topic.chats.push(chat)
    topic.chatId = chat.id
    topic.quote = undefined
    this.noteDiscussion(topic, left)
  }

  /** Reply to part of an answer: the next question quotes it. */
  quoteReply(topicId: string, text: string) {
    const topic = this.topics.find((t) => t.id === topicId)
    const quote = text.trim()
    if (topic && quote) topic.quote = quote
  }

  /** Take the quoted part of an answer off the next question. */
  clearQuote(topicId: string) {
    const topic = this.topics.find((t) => t.id === topicId)
    if (topic) topic.quote = undefined
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
    topic.quote = undefined
  }

  /**
   * Stop the answer arriving in the topic's open discussion, as if the question had not been
   * asked: the question and what came of the answer leave the discussion (so the model never
   * sees them), and the question goes back in the box to be edited and sent again.
   */
  stop(topicId: string) {
    const topic = this.topics.find((t) => t.id === topicId)
    if (topic) this.answering.get(topic.chatId)?.abort(STOPPED)
  }

  /**
   * Take a question whose answer failed back out of the open discussion, with the failed answer,
   * and put it back in the box (with its spot and quote) to send again. Only the latest one.
   */
  retry(topicId: string, answerId: string): boolean {
    const topic = this.topics.find((t) => t.id === topicId)
    const chat = topic && chatOf(topic)
    const answer = chat?.messages.at(-1)
    const question = chat?.messages.at(-2)
    if (!topic || !chat || answer?.id !== answerId || answer.status !== 'error' || question?.role !== 'user') return false
    // The open page went with a question that had nothing attached; the retry takes the page it is on then.
    const pointed = question.context?.point || question.context?.selection
    const asked = { text: question.text, context: pointed ? question.context : undefined, quote: question.quote, mode: question.mode }
    this.takeBack(topic, chat, asked, question, answer)
    return true
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
    const { context, quote } = topic
    const chat = chatOf(topic)
    const mode = chat.mode !== 'normal' && { mode: chat.mode }
    const question = { text: topic.draft.trim(), context, ...(quote && { quote }), ...mode }
    topic.draft = ''
    topic.context = undefined
    topic.quote = undefined
    const fill = context ? undefined : fallback
    if (chat.mode === 'quiz') {
      chat.mode = 'normal'
      await this.converse(topic, chat, question, fill, async (answer, request, signal) => {
        const written = await quizApi.create(request, signal)
        answer.quiz = { ...written, picked: written.questions.map(() => null) }
      })
    } else {
      await this.converse(topic, chat, question, fill, async (answer, request, signal) => {
        // When the current stretch of thinking began; the model can think again after a lookup.
        let thinkingSince: number | undefined
        const stopThinking = () => {
          if (thinkingSince === undefined) return
          const seconds = (answer.thinkingSeconds ?? 0) + (Date.now() - thinkingSince) / 1000
          answer.thinkingSeconds = Math.round(seconds * 10) / 10
          thinkingSince = undefined
        }
        try {
          for await (const event of stream(request, signal)) {
            if (signal.aborted) break
            if (event.type === 'thinking') {
              if (thinkingSince === undefined) {
                thinkingSince = Date.now()
                if (answer.thinking) answer.thinking += '\n\n'
              }
              answer.thinking = (answer.thinking ?? '') + event.text
              continue
            }
            stopThinking()
            if (event.type === 'text') answer.text += event.text
            else answer.steps = [...(answer.steps ?? []), event.text]
          }
        } finally {
          stopThinking()
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

  /**
   * What the backend needs to make flashcards from `source` in a topic, once its PDFs are
   * uploaded and a picked spot's images are rendered; undefined if the source is gone.
   */
  async flashcardRequest(topicId: string, source: FlashcardSource): Promise<FlashcardRequest | undefined> {
    const topic = this.topics.find((t) => t.id === topicId)
    if (!topic) return undefined
    const uploading = topic.docIds.filter((id) => id in this.uploads).map((id) => this.uploads[id])
    if (uploading.length) await Promise.all(uploading)
    const context = source.kind === 'pick' ? ((await source.ready?.catch(() => undefined)) ?? source.context) : undefined
    const request = flashcardRequest(
      topic,
      source.kind === 'pick' ? { kind: 'pick', context: context! } : source,
      (id) => this.indexing[id]?.serverId,
      (id) => this.docs[id]?.name,
    )
    const instructions = this.instructions.trim()
    return request && { ...request, ...(instructions && { instructions }) }
  }

  /** The topic's PDF the backend knows as `serverId`, if it is still in the topic. */
  docOfServerId(topicId: string, serverId: string): string | undefined {
    const topic = this.topics.find((t) => t.id === topicId)
    return topic?.docIds.find((id) => this.indexing[id]?.serverId === serverId)
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
    asked: Pick<ChatMessage, 'text' | 'context' | 'quote' | 'mode'>,
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
      // PDFs whose indexing failed: asking the backend again lets it retry once a while has passed.
      for (const id of topic.docIds) {
        if (this.indexing[id]?.status === 'error' && this.indexing[id]?.serverId) void this.index(id)
      }
      const serverId = (id: string) => this.indexing[id]?.serverId
      const instructions = this.instructions.trim()
      const request = {
        ...askRequest(topic, serverId, this.answerModel, chat, (id) => this.docs[id]?.name),
        ...(this.answerEffort && { effort: this.answerEffort }),
        ...(instructions && { instructions }),
      }
      await respond(answer, request, controller.signal)
      if (controller.signal.reason === STOPPED) return this.takeBack(topic, chat, asked, question, answer)
      answer.status = 'done'
      // An answer that finished after the reader left its discussion was not there to be noted.
      if (!this.isOpen(topic.id, chatId)) this.noteDiscussion(topic, chat)
    } catch (error) {
      if (controller.signal.reason === STOPPED) return this.takeBack(topic, chat, asked, question, answer)
      answer.status = 'error'
      // What had arrived stays, with why the rest didn't.
      const message = error instanceof Error ? error.message : String(error)
      const arrived = answer.text.trim()
      answer.text = arrived ? `${arrived}\n\n*${message}*` : message
    } finally {
      if (this.answering.get(chatId) === controller) this.answering.delete(chatId)
    }
  }

  /**
   * Undo a question whose answer the reader stopped: take it and the answer out of the
   * discussion, and put it back in the box with its spot and quote, ahead of anything typed since.
   */
  private takeBack(
    topic: Topic,
    chat: Chat,
    asked: Pick<ChatMessage, 'text' | 'context' | 'quote' | 'mode'>,
    question: ChatMessage,
    answer: ChatMessage,
  ) {
    chat.messages = chat.messages.filter((m) => m.id !== question.id && m.id !== answer.id)
    if (!chat.messages.length) chat.title = undefined
    if (asked.mode === 'quiz') chat.mode = 'quiz'
    const typed = topic.draft.trim()
    topic.draft = [asked.text, typed].filter(Boolean).join('\n\n')
    topic.context ??= asked.context
    topic.quote ??= asked.quote
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
      // A question taken back (its answer stopped) no longer names the discussion.
      if (title && chat.messages.some((m) => m.id === asked.id)) chat.title = title
    } catch {
      // Without a title, the start of the question stands in.
    }
  }

  /**
   * Have Haiku note what is new in a discussion in its topic's register, so the topic's later
   * discussions can build on it. Called when the reader leaves a discussion: only what was
   * answered since the last time is read, and a discussion with no answer is skipped.
   */
  private noteDiscussion(topic: Topic, chat: Chat) {
    if (!chat.messages.some((m) => m.role === 'assistant' && m.status === 'done')) return
    const request = discussionRequest(topic, chat, (id) => this.indexing[id]?.serverId, (id) => this.docs[id]?.name)
    void this.registerApi.note(topic.id, request).catch(() => {})
  }

  /** The discussion open now, with its topic. */
  private openDiscussion(): { topic: Topic; chat: Chat } | undefined {
    const topic = this.activeTopic
    return topic && { topic, chat: chatOf(topic) }
  }

  private isOpen(topicId: string, chatId: string): boolean {
    const topic = this.activeTopic
    return topic?.id === topicId && topic.chatId === chatId
  }

  /** Note the discussion that was open before a switch, if the switch left it (and it still exists). */
  private noteIfLeft(left: { topic: Topic; chat: Chat } | undefined) {
    if (!left || this.isOpen(left.topic.id, left.chat.id)) return
    const topic = this.topics.find((t) => t.id === left.topic.id)
    const chat = topic?.chats.find((c) => c.id === left.chat.id)
    if (topic && chat) this.noteDiscussion(topic, chat)
  }

  selectDoc(id: string) {
    const topic = this.topicOf(id)
    if (!topic) return
    const left = this.openDiscussion()
    topic.activeDocId = id
    this.activeTopicId = topic.id
    this.noteIfLeft(left)
  }

  /** Whether a source is open as a tab. */
  isTabOpen(id: string): boolean {
    return !!this.topicOf(id)?.openDocIds.includes(id)
  }

  /**
   * Close a tab. The PDF stays a source of its topic (and in the model's context), and can be
   * opened again. The tab to its right (or else its left) becomes active.
   */
  closeDoc(id: string) {
    const topic = this.topicOf(id)
    const index = topic?.openDocIds.indexOf(id) ?? -1
    if (!topic || index === -1) return
    topic.openDocIds.splice(index, 1)
    if (topic.activeDocId === id) topic.activeDocId = topic.openDocIds[index] ?? topic.openDocIds[index - 1]
    if (topic.context?.docId === id) topic.context = undefined
  }

  /** Open a source as a tab, at the end, and switch to it. An open one is just switched to. */
  openDoc(id: string) {
    const topic = this.topicOf(id)
    if (!topic) return
    if (!topic.openDocIds.includes(id)) topic.openDocIds.push(id)
    this.selectDoc(id)
  }

  /** Move an open tab to a place in the tab row (0 is first). */
  moveTab(id: string, to: number) {
    const topic = this.topicOf(id)
    const from = topic?.openDocIds.indexOf(id) ?? -1
    if (!topic || from === -1) return
    topic.openDocIds.splice(from, 1)
    topic.openDocIds.splice(Math.max(0, Math.min(to, topic.openDocIds.length)), 0, id)
  }

  /** Take a PDF out of its topic for good, tab and source both. */
  removeDoc(id: string) {
    const topic = this.topicOf(id)
    if (!topic) return
    this.closeDoc(id)
    topic.docIds.splice(topic.docIds.indexOf(id), 1)
    if (topic.context?.docId === id) topic.context = undefined
    const serverId = this.indexing[id]?.serverId
    this.docs = omit(this.docs, [id])
    delete this.indexing[id]
    delete this.pages[id]
    delete this.pdfErrors[id]
    this.release(serverId)
  }

  /** The other topics that have the same PDF as the tab `docId`. */
  otherTopicsWith(docId: string): Topic[] {
    const serverId = this.indexing[docId]?.serverId
    const topic = this.topicOf(docId)
    if (!serverId) return []
    return this.topics.filter((t) => t !== topic && t.docIds.some((id) => this.indexing[id]?.serverId === serverId))
  }

  /** Whether a tab in any topic has the PDF the backend knows as `serverId`. */
  private inUse(serverId: string): boolean {
    return Object.keys(this.docs).some((id) => this.indexing[id]?.serverId === serverId)
  }

  // A PDF no topic has any more is deleted on the backend with the next save. The backend keeps
  // one copy of each PDF for every topic it is in, so one still in another topic stays.
  private release(serverId: string | undefined) {
    if (!serverId || this.inUse(serverId)) return
    this.released.add(serverId)
    this.onReleased()
  }

  /** Called when a PDF is released, so a save can delete it. App saves soon after. */
  onReleased: () => void = () => {}

  /**
   * The backend ids of PDFs taken out of every topic since this was last called, to send with
   * the save that leaves them out. Give back with `rerelease` any the save did not delete.
   */
  takeReleased(): string[] {
    const ids = [...this.released].filter((id) => !this.inUse(id))
    this.released.clear()
    return ids
  }

  /** Release again PDFs a save could not delete yet. */
  rerelease(ids: string[]) {
    for (const id of ids) this.release(id)
  }

  /** Whether a save has PDFs to delete. */
  hasReleased(): boolean {
    return this.released.size > 0
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
      ...(this.instructions.trim() && { instructions: this.instructions }),
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
          open: topic.openDocIds.filter((id) => docs.some((d) => d.id === id)),
          activeDocId: topic.openDocIds.includes(topic.activeDocId ?? '') && docs.some((d) => d.id === topic.activeDocId) ? topic.activeDocId : topic.openDocIds.find((id) => docs.some((d) => d.id === id)),
          ...(topic.sourcesOpen && { sourcesOpen: true }),
          ...(topic.discussionsOpen === false && { discussionsOpen: false }),
          ...(topic.purpose?.trim() && { purpose: topic.purpose }),
          ...(topic.conventions?.trim() && { conventions: topic.conventions }),
          chatId: topic.chatId,
          chats: topic.chats
            .filter((c) => c.messages.length || c.id === topic.chatId)
            .map((c) => ({ ...c, messages: c.messages.map(savedMessage) })),
        }
      }),
    }
  }

  /**
   * Bring back a saved workspace. Tabs come back without their PDFs, which are fetched from
   * the backend when they are shown (see loadPdf), so a PDF that can't be fetched never takes
   * its tab out of the topic. Topics opened while it loaded are kept, after the saved ones.
   * Returns the tabs restored, to follow their indexing.
   */
  restore(saved: unknown): string[] {
    if (!isSavedWorkspace(saved)) return []
    const docs: Record<string, Doc> = {}
    const indexing: Record<string, IndexState> = {}
    const pages: Record<string, number> = {}
    for (const d of saved.topics.flatMap((t) => t.docs)) {
      docs[d.id] = { id: d.id, name: d.name }
      indexing[d.id] = { serverId: d.serverId, status: 'queued', pagesDone: 0, pageCount: 0 }
      if (d.page) pages[d.id] = d.page
    }
    this.docs = { ...docs, ...this.docs }
    this.indexing = { ...indexing, ...this.indexing }
    this.pages = { ...pages, ...this.pages }
    const restored = saved.topics.map((t): Topic => {
      const docIds = t.docs.map((d) => d.id).filter((id) => id in docs)
      const openDocIds = t.open ? t.open.filter((id) => docIds.includes(id)) : docIds
      return {
        id: t.id,
        name: t.name,
        docIds,
        openDocIds,
        activeDocId: t.activeDocId && openDocIds.includes(t.activeDocId) ? t.activeDocId : openDocIds[0],
        ...(t.sourcesOpen && { sourcesOpen: true }),
        ...(t.discussionsOpen === false && { discussionsOpen: false }),
        ...restoredChats(t),
        ...(typeof t.purpose === 'string' && t.purpose && { purpose: t.purpose }),
        ...(typeof t.conventions === 'string' && t.conventions && { conventions: t.conventions }),
        draft: '',
      }
    })
    this.topics = [...restored, ...this.topics]
    // Unless they were already changed while it loaded.
    if (!this.instructions && typeof saved.instructions === 'string') this.instructions = saved.instructions
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
        ...(c.branch && { branch: c.branch }),
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

/**
 * A message as saved: its spot without the page image and text, which only a new question sends.
 * An answer still arriving is saved without what has arrived (it comes back as stopped), so the
 * workspace is not saved again for every piece of it.
 */
function savedMessage(message: ChatMessage): ChatMessage {
  if (message.status === 'streaming') {
    const { id, role, status, mode } = message
    return { id, role, text: '', status, ...(mode && { mode }) }
  }
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
  nameOf: (docId: string) => string | undefined = () => undefined,
): AskRequest {
  const turns = sendable(chat.messages)
  return {
    topic: topic.name,
    topic_id: topic.id,
    chat_id: chat.id,
    ...(model && { model }),
    docs: topic.docIds.map(serverId).filter((id): id is string => !!id),
    ...docNames(topic, serverId, nameOf),
    ...(topic.purpose?.trim() && { purpose: topic.purpose.trim() }),
    ...(topic.conventions?.trim() && { conventions: topic.conventions.trim() }),
    messages: turns.map((m, i) => requestTurn(m, i === turns.length - 1, serverId)),
  }
}

/**
 * The topic and the material for making flashcards: a spot with its images, or a discussion's
 * turns up to the answer picked, without images (the model can read pages itself).
 */
export function flashcardRequest(
  topic: Topic,
  source: FlashcardSource,
  serverId: (docId: string) => string | undefined = () => undefined,
  nameOf: (docId: string) => string | undefined = () => undefined,
): FlashcardRequest | undefined {
  const base: FlashcardRequest = {
    topic: topic.name,
    topic_id: topic.id,
    docs: topic.docIds.map(serverId).filter((id): id is string => !!id),
    ...docNames(topic, serverId, nameOf),
    ...(topic.purpose?.trim() && { purpose: topic.purpose.trim() }),
    ...(topic.conventions?.trim() && { conventions: topic.conventions.trim() }),
  }
  if (source.kind === 'pick') {
    return { ...base, context: contextForRequest(source.context, true, serverId(source.context.docId)) }
  }
  const chat = topic.chats.find((c) => c.id === source.chatId)
  const index = chat?.messages.findIndex((m) => m.id === source.messageId) ?? -1
  if (!chat || index === -1) return undefined
  const turns = chat.messages.slice(0, index + 1).filter((m) => m.status !== 'streaming' && m.status !== 'error')
  return { ...base, chat_id: chat.id, messages: turns.map((m) => requestTurn(m, false, serverId)) }
}

/**
 * A discussion for Haiku to note in its topic's register: its turns without images, each with
 * a key that changes when the turn does, so a quiz answered since it was last read is read again.
 * A branch leaves out the messages it copied, which were noted in the discussion it left.
 */
export function discussionRequest(
  topic: Topic,
  chat: Chat,
  serverId: (docId: string) => string | undefined = () => undefined,
  nameOf: (docId: string) => string | undefined = () => undefined,
): DiscussionRequest {
  return {
    topic: topic.name,
    chat_id: chat.id,
    ...(chat.title && { title: chat.title }),
    docs: topic.docIds.map(serverId).filter((id): id is string => !!id),
    ...docNames(topic, serverId, nameOf),
    messages: sendable(chat.messages.slice(chat.branch?.at ?? 0)).map((m) => ({ key: turnKey(m), ...requestTurn(m, false, serverId) })),
  }
}

/**
 * The messages the model sees: not an answer still arriving, and not a question whose answer
 * failed, with that answer, so it never sees a question twice when the reader asks it again.
 */
function sendable(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m, i) => m.status !== 'streaming' && m.status !== 'error' && !(m.role === 'user' && messages[i + 1]?.status === 'error'))
}

/** The names the topic's PDFs have here, by backend id, for the request. Left out when none are known. */
function docNames(
  topic: Topic,
  serverId: (docId: string) => string | undefined,
  nameOf: (docId: string) => string | undefined,
): { doc_names?: Record<string, string> } {
  const names: Record<string, string> = {}
  for (const id of topic.docIds) {
    const server = serverId(id)
    const name = nameOf(id)
    if (server && name) names[server] = name
  }
  return Object.keys(names).length ? { doc_names: names } : {}
}

function turnKey(message: ChatMessage): string {
  const { quiz } = message
  if (!quiz) return message.id
  const answered = quiz.picked.filter((p) => p !== null).length
  return `${message.id}/${answered}${quiz.recommendation ? '+' : ''}`
}

/** One message as the backend reads it. */
function requestTurn(m: ChatMessage, withImages: boolean, serverId: (docId: string) => string | undefined): AskTurn {
  return {
    role: m.role,
    text: m.status === 'error' ? '' : m.quote ? withQuote(m.quote, m.text) : m.text,
    context: m.context && contextForRequest(m.context, withImages, serverId(m.context.docId)),
    ...(m.role === 'user' && m.mode && { mode: m.mode }),
    ...(m.quiz && { quiz: quizRecord(m.quiz) }),
  }
}

/** A reply to part of an answer, as the model reads it: the quoted part, then the reader's words. */
export function withQuote(quote: string, text: string): string {
  const quoted = quote.split('\n').map((line) => `> ${line}`).join('\n')
  return `Replying to this part of your answer:\n${quoted}\n\n${text}`
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
