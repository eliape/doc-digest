import { describe, expect, it } from 'vitest'
import type { AskRequest, IndexStatus } from './api'
import type { PageContext } from './context'
import { Workspace, askRequest, topicNameFor } from './workspace.svelte'

const bytes = (...values: number[]) => new Uint8Array(values)

describe('topicNameFor', () => {
  it('drops the .pdf extension', () => {
    expect(topicNameFor('Lecture 4.pdf')).toBe('Lecture 4')
    expect(topicNameFor('notes.PDF')).toBe('notes')
    expect(topicNameFor('.pdf')).toBe('.pdf')
  })
})

describe('Workspace', () => {
  it('starts a topic named after the file when none is selected', () => {
    const ws = new Workspace()
    const doc = ws.addDoc('Lecture 4.pdf', bytes(1))
    expect(ws.topics).toHaveLength(1)
    expect(ws.activeTopic?.name).toBe('Lecture 4')
    expect(ws.activeDoc).toEqual(doc)
  })

  it('adds further PDFs as tabs in the active topic', () => {
    const ws = new Workspace()
    const slides = ws.addDoc('slides.pdf', bytes(1))
    const book = ws.addDoc('book.pdf', bytes(2))
    expect(ws.topics).toHaveLength(1)
    expect(ws.activeTopic?.docIds).toEqual([slides.id, book.id])
    expect(ws.activeDoc?.id).toBe(book.id)
    ws.selectDoc(slides.id)
    expect(ws.activeDoc?.id).toBe(slides.id)
  })

  it('switches to the existing tab when the same file is added again', () => {
    const ws = new Workspace()
    const first = ws.addDoc('a.pdf', bytes(1, 2))
    ws.addDoc('b.pdf', bytes(3))
    const again = ws.addDoc('a.pdf', bytes(1, 2))
    expect(again.id).toBe(first.id)
    expect(ws.activeTopic?.docIds).toHaveLength(2)
    expect(ws.activeDoc?.id).toBe(first.id)
    // Same name, different contents: a separate tab.
    ws.addDoc('a.pdf', bytes(9, 9))
    expect(ws.activeTopic?.docIds).toHaveLength(3)
  })

  it('keeps each topic on its own active tab', () => {
    const ws = new Workspace()
    const a = ws.addDoc('a.pdf', bytes(1))
    const t1 = ws.activeTopicId!
    ws.createTopic('Second')
    const b = ws.addDoc('b.pdf', bytes(2))
    expect(ws.activeTopic?.name).toBe('Second')
    expect(ws.activeDoc?.id).toBe(b.id)
    ws.selectTopic(t1)
    expect(ws.activeDoc?.id).toBe(a.id)
  })

  it('activates the neighbouring tab when one is closed', () => {
    const ws = new Workspace()
    const a = ws.addDoc('a.pdf', bytes(1))
    const b = ws.addDoc('b.pdf', bytes(2))
    const c = ws.addDoc('c.pdf', bytes(3))
    ws.selectDoc(b.id)
    ws.closeDoc(b.id)
    expect(ws.activeDoc?.id).toBe(c.id)
    ws.closeDoc(c.id)
    expect(ws.activeDoc?.id).toBe(a.id)
    ws.closeDoc(a.id)
    expect(ws.activeDoc).toBeUndefined()
    expect(ws.topics).toHaveLength(1)
    expect(ws.docs).toEqual({})
  })

  it('closing an inactive tab leaves the active one alone', () => {
    const ws = new Workspace()
    const a = ws.addDoc('a.pdf', bytes(1))
    const b = ws.addDoc('b.pdf', bytes(2))
    ws.closeDoc(a.id)
    expect(ws.activeDoc?.id).toBe(b.id)
  })

  it('renames topics, ignoring blank names', () => {
    const ws = new Workspace()
    const topic = ws.createTopic()
    ws.renameTopic(topic.id, '  Linear algebra ')
    expect(ws.activeTopic?.name).toBe('Linear algebra')
    ws.renameTopic(topic.id, '   ')
    expect(ws.activeTopic?.name).toBe('Linear algebra')
  })

  it('deletes a topic with its PDFs and selects a neighbour', () => {
    const ws = new Workspace()
    const first = ws.createTopic('First')
    const second = ws.createTopic('Second')
    ws.addDoc('b.pdf', bytes(2))
    ws.deleteTopic(second.id)
    expect(ws.topics.map((t) => t.name)).toEqual(['First'])
    expect(ws.activeTopicId).toBe(first.id)
    expect(ws.docs).toEqual({})
    ws.deleteTopic(first.id)
    expect(ws.activeTopic).toBeUndefined()
  })

  it('keeps one chat per topic, shared by its tabs', () => {
    const ws = new Workspace()
    ws.addDoc('slides.pdf', bytes(1))
    const first = ws.activeTopic!
    first.draft = 'What is a p-value?'
    ws.ask(first.id, undefined, async function* () {})
    ws.addDoc('book.pdf', bytes(2))
    expect(ws.activeTopic?.chat.map((m) => [m.role, m.text])).toEqual([
      ['user', 'What is a p-value?'],
      ['assistant', ''],
    ])
    expect(first.draft).toBe('')

    const second = ws.createTopic('Second')
    expect(second.chat).toEqual([])
    second.draft = '   '
    ws.ask(second.id)
    expect(ws.activeTopic?.chat).toEqual([])
  })
})

describe('Workspace.ask', () => {
  const context = (docId: string, page: number): PageContext => ({
    docId,
    docName: 'notes.pdf',
    page,
    point: { x: 0.5, y: 0.25 },
    pageImage: 'PAGE',
    pageTexts: [{ page, text: 'some text' }],
  })

  it('streams the answer into the chat and sends the attached context with the question', async () => {
    const ws = new Workspace()
    const doc = ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    ws.attachContext(topic.id, context(doc.id, 3))
    topic.draft = '  How is this derived? '
    const requests: AskRequest[] = []
    await ws.ask(topic.id, undefined, async function* (request) {
      requests.push(request)
      yield { type: 'step', text: 'Searched for “parts”' }
      yield { type: 'text', text: 'By ' }
      yield { type: 'text', text: 'parts.' }
    })
    expect(topic.chat.map((m) => [m.role, m.text, m.status])).toEqual([
      ['user', 'How is this derived?', undefined],
      ['assistant', 'By parts.', 'done'],
    ])
    expect(topic.chat[1].steps).toEqual(['Searched for “parts”'])
    expect(topic.chat[0].context?.page).toBe(3)
    expect(topic.context).toBeUndefined()
    expect(topic.draft).toBe('')
    expect(requests[0].topic).toBe('notes')
    expect(requests[0].messages).toEqual([
      {
        role: 'user',
        text: 'How is this derived?',
        context: expect.objectContaining({ doc_name: 'notes.pdf', page: 3, page_image: 'PAGE' }),
      },
    ])
  })

  it('uses the open page when nothing is attached', async () => {
    const ws = new Workspace()
    const doc = ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    topic.draft = 'What is this page about?'
    await ws.ask(
      topic.id,
      async () => ({ ...context(doc.id, 7), point: undefined }),
      async function* () {},
    )
    expect(topic.chat[0].context?.page).toBe(7)
  })

  it('shows why an answer failed and leaves it out of the next request', async () => {
    const ws = new Workspace()
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    topic.draft = 'first'
    await ws.ask(topic.id, undefined, async function* () {
      throw new Error('No API key')
    })
    expect(topic.chat[1]).toMatchObject({ role: 'assistant', status: 'error', text: 'No API key' })
    topic.draft = 'second'
    let sent: AskRequest | undefined
    await ws.ask(topic.id, undefined, async function* (request) {
      sent = request
    })
    expect(sent?.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'first'],
      ['assistant', ''],
      ['user', 'second'],
    ])
  })

  it('ignores a new question while an answer is arriving', async () => {
    const ws = new Workspace()
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    topic.draft = 'first'
    let finish!: () => void
    const pending = ws.ask(topic.id, undefined, async function* () {
      await new Promise<void>((resolve) => (finish = resolve))
    })
    await Promise.resolve()
    expect(ws.isAnswering(topic.id)).toBe(true)
    topic.draft = 'second'
    await ws.ask(topic.id, undefined, async function* () {})
    expect(topic.chat).toHaveLength(2)
    expect(topic.draft).toBe('second')
    finish()
    await pending
    expect(ws.isAnswering(topic.id)).toBe(false)
  })

  it('starts a new chat: clears the messages and stops the answer, keeping the draft and attached spot', async () => {
    const ws = new Workspace()
    const doc = ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    topic.draft = 'first'
    let signal: AbortSignal | undefined
    let more!: () => void
    const pending = ws.ask(topic.id, undefined, async function* (_request, s) {
      signal = s
      yield { type: 'text', text: 'Part one' }
      await new Promise<void>((resolve) => (more = resolve))
      yield { type: 'text', text: ' and part two' }
    })
    await new Promise((resolve) => setTimeout(resolve))
    expect(topic.chat.at(-1)?.text).toBe('Part one')

    ws.attachContext(topic.id, context(doc.id, 3))
    topic.draft = 'unsent'
    ws.newChat(topic.id)
    expect(signal?.aborted).toBe(true)
    expect(topic.chat).toEqual([])
    expect(topic.context?.page).toBe(3)
    expect(topic.draft).toBe('unsent')
    expect(ws.isAnswering(topic.id)).toBe(false)

    // The stopped answer does not come back into the new chat.
    more()
    await pending
    expect(topic.chat).toEqual([])
    expect(ws.docs[doc.id]).toBeDefined()
  })

  it('asks the picked model, or leaves the choice to the backend', async () => {
    const ws = new Workspace()
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    const models: (string | undefined)[] = []
    const stream = async function* (request: { model?: string }) {
      models.push(request.model)
    }
    topic.draft = 'one'
    await ws.ask(topic.id, undefined, stream)
    ws.answerModel = 'claude-sonnet-5-5'
    topic.draft = 'two'
    await ws.ask(topic.id, undefined, stream)
    expect(models).toEqual([undefined, 'claude-sonnet-5-5'])
  })

  it('only sends images with the newest question', () => {
    const ws = new Workspace()
    const doc = ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    topic.chat.push(
      { id: 'a', role: 'user', text: 'one', context: context(doc.id, 1) },
      { id: 'b', role: 'assistant', text: 'answer', status: 'done' },
      { id: 'c', role: 'user', text: 'two', context: context(doc.id, 2) },
    )
    const [first, , last] = askRequest(topic).messages
    expect(first.context).not.toHaveProperty('page_image')
    expect(last.context).toMatchObject({ page: 2, page_image: 'PAGE' })
  })

  it('names the PDFs by their backend ids once uploaded', async () => {
    const ws = new Workspace()
    const doc = ws.addDoc('notes.pdf', bytes(1))
    ws.addDoc('book.pdf', bytes(2))
    const topic = ws.activeTopic!
    ws.indexing[doc.id] = { serverId: 'abc', status: 'ready', pagesDone: 3, pageCount: 3 }
    ws.attachContext(topic.id, context(doc.id, 1))
    topic.draft = 'q'
    let sent: AskRequest | undefined
    await ws.ask(topic.id, undefined, async function* (request) {
      sent = request
    })
    // book.pdf has no id yet (its upload never started), so it is left out.
    expect(sent?.docs).toEqual(['abc'])
    expect(sent?.messages[0].context).toMatchObject({ doc_id: 'abc' })
  })

  it('uploads a PDF and follows its indexing until it is ready', async () => {
    const ws = new Workspace()
    const doc = ws.addDoc('notes.pdf', bytes(1))
    const statuses: IndexStatus[] = [
      { id: 'abc', status: 'indexing', pages_done: 20, page_count: 40 },
      { id: 'abc', status: 'ready', pages_done: 40, page_count: 40 },
    ]
    const seen: string[] = []
    await ws.index(
      doc.id,
      {
        upload: async (name) => {
          seen.push(`upload ${name}`)
          return { id: 'abc', status: 'queued', pages_done: 0, page_count: 40 }
        },
        status: async (id) => {
          seen.push(`status ${id}`)
          return statuses.shift()!
        },
      },
      0,
    )
    expect(seen).toEqual(['upload notes.pdf', 'status abc', 'status abc'])
    expect(ws.indexing[doc.id]).toMatchObject({ serverId: 'abc', status: 'ready', pagesDone: 40 })
  })

  it('shows why indexing failed, and stops following a closed tab', async () => {
    const ws = new Workspace()
    const doc = ws.addDoc('notes.pdf', bytes(1))
    await ws.index(doc.id, {
      upload: async () => {
        throw new Error('Backend down')
      },
      status: async () => ({ id: 'x', status: 'ready', pages_done: 0, page_count: 0 }),
    })
    expect(ws.indexing[doc.id]).toMatchObject({ status: 'error', error: 'Backend down' })

    const other = ws.addDoc('other.pdf', bytes(2))
    let polls = 0
    const following = ws.index(
      other.id,
      {
        upload: async () => ({ id: 'y', status: 'indexing', pages_done: 0, page_count: 9 }),
        status: async () => {
          polls++
          return { id: 'y', status: 'indexing', pages_done: 1, page_count: 9 }
        },
      },
      5,
    )
    await new Promise((resolve) => setTimeout(resolve, 1))
    ws.closeDoc(other.id)
    await following
    expect(polls).toBe(0)
    expect(ws.indexing[other.id]).toBeUndefined()
  })

  it('drops the attached context when its tab closes', () => {
    const ws = new Workspace()
    const doc = ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    ws.attachContext(topic.id, context(doc.id, 1))
    ws.closeDoc(doc.id)
    expect(topic.context).toBeUndefined()
  })
})
