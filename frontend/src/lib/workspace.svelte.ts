import { type AnswerStream, type AskRequest, fetchAnswer, fetchIndexStatus, type IndexStatus, uploadDoc } from './api'
import type { PageContext } from './context'

/** A PDF opened in a topic. Each one is a tab. */
export type Doc = { id: string; name: string; data: Uint8Array }

/**
 * One message in a topic's chat. A question carries the context it was asked
 * about; an answer is `streaming` while it arrives and `error` if it failed.
 */
export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  context?: PageContext
  status?: 'streaming' | 'done' | 'error'
  /** The lookups the model made while answering, e.g. "Read book.pdf, pp. 4–5". */
  steps?: string[]
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

/**
 * A named group of PDFs that are read and asked about together. Each topic has
 * one chat, shared by all its tabs, and `draft` is the unsent question in it.
 * `context` is the spot the reader last clicked, attached to the next question.
 */
export type Topic = {
  id: string
  name: string
  docIds: string[]
  activeDocId?: string
  chat: ChatMessage[]
  draft: string
  context?: PageContext
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
  /** Indexing progress per PDF (by tab id). */
  indexing = $state<Record<string, IndexState>>({})
  // Uploads still on their way, so a question can wait for its PDFs' ids.
  private uploads: Record<string, Promise<unknown>> = {}
  // Stops each topic's answer that is still arriving. Not state: nothing renders from it.
  private answering = new Map<string, AbortController>()

  activeTopic = $derived(this.topics.find((t) => t.id === this.activeTopicId))
  activeDoc = $derived(this.activeTopic?.activeDocId ? this.docs[this.activeTopic.activeDocId] : undefined)

  topicOf(docId: string): Topic | undefined {
    return this.topics.find((t) => t.docIds.includes(docId))
  }

  createTopic(name = 'New topic'): Topic {
    this.topics.push({ id: newId(), name, docIds: [], chat: [], draft: '' })
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
    this.docs = omit(this.docs, topic.docIds)
    for (const docId of topic.docIds) delete this.indexing[docId]
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
    this.indexing[docId] = { status: 'uploading', pagesDone: 0, pageCount: 0 }
    const update = (s: IndexStatus) => {
      if (!(docId in this.docs)) return false
      this.indexing[docId] = { serverId: s.id, status: s.status, pagesDone: s.pages_done, pageCount: s.page_count, error: s.error }
      return s.status !== 'ready' && s.status !== 'error'
    }
    try {
      const upload = api.upload(doc.name, doc.data)
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

  /** Attach what the reader pointed at to the topic's next question, replacing what was attached. */
  attachContext(topicId: string, context: PageContext) {
    const topic = this.topics.find((t) => t.id === topicId)
    if (topic) topic.context = context
  }

  clearContext(topicId: string) {
    const topic = this.topics.find((t) => t.id === topicId)
    if (topic) topic.context = undefined
  }

  /**
   * Start the topic's chat over: forget its questions and answers and stop an answer that is
   * still arriving. What belongs to the next question (the draft and the attached spot) stays,
   * and so do the tabs.
   */
  newChat(topicId: string) {
    const topic = this.topics.find((t) => t.id === topicId)
    if (!topic) return
    this.answering.get(topicId)?.abort()
    topic.chat = []
  }

  /** Whether a topic's latest answer is still arriving. */
  isAnswering(topicId: string): boolean {
    return this.topics.find((t) => t.id === topicId)?.chat.at(-1)?.status === 'streaming'
  }

  /**
   * Send the topic's draft as a question, with the attached context or, when
   * nothing is attached, whatever `fallback` gives (the open page), and stream
   * the answer into the chat. Blank questions are ignored, and so is a new
   * question while an answer is still arriving.
   */
  async ask(
    topicId: string,
    fallback?: () => Promise<PageContext | undefined>,
    stream: AnswerStream = fetchAnswer,
  ): Promise<void> {
    const topic = this.topics.find((t) => t.id === topicId)
    if (!topic || !topic.draft.trim() || this.isAnswering(topicId)) return
    topic.chat.push({ id: newId(), role: 'user', text: topic.draft.trim(), context: topic.context })
    topic.chat.push({ id: newId(), role: 'assistant', text: '', status: 'streaming' })
    // Read back through the topic, so changes go through Svelte's state.
    const question = topic.chat[topic.chat.length - 2]
    const answer = topic.chat[topic.chat.length - 1]
    topic.draft = ''
    topic.context = undefined
    const controller = new AbortController()
    this.answering.set(topicId, controller)
    try {
      question.context ??= await fallback?.().catch(() => undefined)
      const uploading = topic.docIds.filter((id) => id in this.uploads).map((id) => this.uploads[id])
      if (uploading.length) await Promise.all(uploading)
      const serverId = (id: string) => this.indexing[id]?.serverId
      for await (const event of stream(askRequest(topic, serverId), controller.signal)) {
        if (controller.signal.aborted) break
        if (event.type === 'text') answer.text += event.text
        else answer.steps = [...(answer.steps ?? []), event.text]
      }
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
  }
}

/**
 * What the backend needs to answer a topic's newest question: the conversation
 * so far, and the backend's ids of the topic's PDFs so it can look things up in
 * them. Only the newest question carries images, which keeps requests small.
 */
export function askRequest(topic: Topic, serverId: (docId: string) => string | undefined = () => undefined): AskRequest {
  const turns = topic.chat.filter((m) => m.status !== 'streaming')
  return {
    topic: topic.name,
    docs: topic.docIds.map(serverId).filter((id): id is string => !!id),
    messages: turns.map((m, i) => ({
      role: m.role,
      text: m.status === 'error' ? '' : m.text,
      context: m.context && contextForRequest(m.context, i === turns.length - 1, serverId(m.context.docId)),
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
      crop: context.crop,
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
