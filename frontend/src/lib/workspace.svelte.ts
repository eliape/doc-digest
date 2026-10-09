/** A PDF opened in a topic. Each one is a tab. */
export type Doc = { id: string; name: string; data: Uint8Array }

/** One message in a topic's chat. */
export type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string }

/**
 * A named group of PDFs that are read and asked about together. Each topic has
 * one chat, shared by all its tabs, and `draft` is the unsent question in it.
 */
export type Topic = {
  id: string
  name: string
  docIds: string[]
  activeDocId?: string
  chat: ChatMessage[]
  draft: string
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

  /** Add the user's question to a topic's chat and clear its draft. Blank questions are ignored. */
  sendMessage(topicId: string, text: string): ChatMessage | undefined {
    const topic = this.topics.find((t) => t.id === topicId)
    if (!topic || !text.trim()) return
    topic.chat.push({ id: newId(), role: 'user', text: text.trim() })
    topic.draft = ''
    return topic.chat[topic.chat.length - 1]
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
    this.docs = omit(this.docs, [id])
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
