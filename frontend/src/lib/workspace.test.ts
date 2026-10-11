import { describe, expect, it } from 'vitest'
import type { AskRequest, IndexStatus, RecommendationRequest, WrittenQuiz } from './api'
import type { PageContext } from './context'
import { type QuizApi, Workspace, askRequest, topicNameFor } from './workspace.svelte'

const bytes = (...values: number[]) => new Uint8Array(values)

const written: WrittenQuiz = {
  title: 'Derivatives',
  questions: [
    { question: 'What is the derivative of $x^2$?', choices: ['$x$', '$2x$', '$x^2$'], answer: 1, explanation: 'The power rule.' },
    { question: 'What does $dx$ stand for?', choices: ['A small change in x', 'A constant'], answer: 0, explanation: 'An infinitesimal.' },
  ],
}

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

  it('stops the answer of a topic that is deleted', async () => {
    const ws = new Workspace()
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    topic.draft = 'question'
    let signal: AbortSignal | undefined
    const pending = ws.ask(topic.id, undefined, async function* (_request, s) {
      signal = s
      yield { type: 'text', text: 'Part one' }
      await new Promise(() => {})
    })
    await new Promise((resolve) => setTimeout(resolve))
    ws.deleteTopic(topic.id)
    expect(signal?.aborted).toBe(true)
    void pending
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

  it('starts a Socratic session about a spot attached for it, with what to focus on optional', async () => {
    const ws = new Workspace()
    const doc = ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    const requests: AskRequest[] = []
    const stream = async function* (request: AskRequest) {
      requests.push(request)
      yield { type: 'text' as const, text: 'What does dx stand for?' }
    }
    // Nothing goes out until the reader sends; a blank box is fine once a spot is attached.
    expect(ws.canSend(topic.id)).toBe(false)
    ws.attachContext(topic.id, context(doc.id, 5), 'socratic')
    expect(topic.mode).toBe('socratic')
    expect(topic.chat).toEqual([])
    expect(ws.canSend(topic.id)).toBe(true)
    await ws.ask(topic.id, undefined, stream)

    expect(topic.chat.map((m) => [m.role, m.text, m.mode])).toEqual([
      ['user', '', 'socratic'],
      ['assistant', 'What does dx stand for?', 'socratic'],
    ])
    expect(requests[0].messages).toEqual([
      { role: 'user', text: '', mode: 'socratic', context: expect.objectContaining({ page: 5, page_image: 'PAGE' }) },
    ])
    expect(topic.context).toBeUndefined()

    // The reader's replies are Socratic turns until the mode is switched back; they can't be blank.
    expect(ws.canSend(topic.id)).toBe(false)
    topic.draft = 'A small change in x?'
    await ws.ask(topic.id, undefined, stream)
    expect(requests[1].messages.at(-1)).toMatchObject({ role: 'user', text: 'A small change in x?', mode: 'socratic' })
    expect(topic.chat.at(-1)?.mode).toBe('socratic')

    ws.setMode(topic.id, 'normal')
    topic.draft = 'Thanks. What is a derivative?'
    await ws.ask(topic.id, undefined, stream)
    expect(requests[2].messages.at(-1)).not.toHaveProperty('mode')
    // Earlier turns keep their mark, so the model can tell where the session was.
    expect(requests[2].messages.map((m) => m.mode)).toEqual(['socratic', undefined, 'socratic', undefined, undefined])

    // With what to focus on typed, the session starts with it.
    ws.attachContext(topic.id, context(doc.id, 7), 'socratic')
    topic.draft = 'the limit'
    await ws.ask(topic.id, undefined, stream)
    expect(requests[3].messages.at(-1)).toMatchObject({ text: 'the limit', mode: 'socratic', context: { page: 7 } })
  })

  it('asks typed questions Socratically once the mode is picked, until a spot is clicked', async () => {
    const ws = new Workspace()
    const doc = ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    expect(topic.mode).toBe('normal')
    const modes: (string | undefined)[] = []
    const stream = async function* (request: AskRequest) {
      modes.push(request.messages.at(-1)?.mode)
    }
    ws.setMode(topic.id, 'socratic')
    topic.draft = 'Why is the derivative a limit?'
    await ws.ask(topic.id, undefined, stream)
    expect(modes).toEqual(['socratic'])

    // A new chat starts over in Normal mode.
    ws.newChat(topic.id)
    expect(topic.mode).toBe('normal')
    ws.setMode(topic.id, 'socratic')

    // Clicking a spot is for asking about it, so it switches back to normal answers.
    ws.attachContext(topic.id, context(doc.id, 3))
    expect(topic.mode).toBe('normal')
    topic.draft = 'What is this?'
    await ws.ask(topic.id, undefined, stream)
    expect(modes).toEqual(['socratic', undefined])
  })

  it('sends nothing while an answer is arriving, not even to start a session or a quiz', async () => {
    const ws = new Workspace()
    const doc = ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    topic.draft = 'first'
    let finish!: () => void
    const pending = ws.ask(topic.id, undefined, async function* () {
      await new Promise<void>((resolve) => (finish = resolve))
    })
    await Promise.resolve()
    ws.attachContext(topic.id, context(doc.id, 5), 'quiz')
    expect(ws.canSend(topic.id)).toBe(false)
    await ws.ask(topic.id, undefined, undefined, fakeQuizApi().api)
    expect(topic.chat).toHaveLength(2)
    finish()
    await pending
  })


  function fakeQuizApi(recommendation: string | null = 'Read p. 12 again.') {
    const created: AskRequest[] = []
    const recommended: RecommendationRequest[] = []
    const api: QuizApi = {
      create: async (request) => {
        created.push(request)
        return structuredClone(written)
      },
      recommend: async (request) => {
        recommended.push(request)
        return recommendation
      },
    }
    return { api, created, recommended }
  }

  it('writes a quiz in Quiz mode, about the attached spot and what the reader asked it to cover', async () => {
    const ws = new Workspace()
    const doc = ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    const { api, created } = fakeQuizApi()
    ws.attachContext(topic.id, context(doc.id, 5), 'quiz')
    topic.draft = ' the chain rule '
    await ws.ask(topic.id, undefined, undefined, api)

    expect(created[0].messages).toEqual([
      { role: 'user', text: 'the chain rule', mode: 'quiz', context: expect.objectContaining({ page: 5, page_image: 'PAGE' }) },
    ])
    const [asked, quiz] = topic.chat
    expect(asked).toMatchObject({ role: 'user', text: 'the chain rule', mode: 'quiz' })
    expect(quiz).toMatchObject({ role: 'assistant', mode: 'quiz', status: 'done', text: '' })
    expect(quiz.quiz).toEqual({ ...written, picked: [null, null] })
    // Sending a quiz goes back to Normal, so the next question is an ordinary one.
    expect(topic.mode).toBe('normal')
    expect(ws.canSend(topic.id)).toBe(false)
  })

  it('cancels Socratic or Quiz mode when the spot it was waiting for is taken off', () => {
    const ws = new Workspace()
    const doc = ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    for (const mode of ['socratic', 'quiz'] as const) {
      ws.attachContext(topic.id, context(doc.id, 5), mode)
      ws.clearContext(topic.id)
      expect(topic.context).toBeUndefined()
      expect(topic.mode).toBe('normal')
    }
    // Picked from the menu with nothing attached, the mode stays.
    ws.setMode(topic.id, 'quiz')
    ws.clearContext(topic.id)
    expect(topic.mode).toBe('quiz')
  })

  it('takes each quiz answer once, and asks for a note on what to review only after a wrong one', async () => {
    const ws = new Workspace()
    const doc = ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    const { api, recommended } = fakeQuizApi()
    ws.attachContext(topic.id, context(doc.id, 5), 'quiz')
    topic.draft = 'the power rule'
    await ws.ask(topic.id, undefined, undefined, api)
    const message = topic.chat[1]

    await ws.answerQuiz(topic.id, message.id, 0, 0, api)
    await ws.answerQuiz(topic.id, message.id, 0, 1, api)
    expect(message.quiz!.picked).toEqual([0, null])
    expect(recommended).toEqual([])

    await ws.answerQuiz(topic.id, message.id, 1, 0, api)
    expect(message.quiz!.picked).toEqual([0, 0])
    expect(recommended).toEqual([
      {
        topic: 'notes',
        about: { role: 'user', text: 'the power rule', context: expect.objectContaining({ page: 5, doc_name: 'notes.pdf' }) },
        quiz: { ...written, picked: [0, 0] },
      },
    ])
    expect(recommended[0].about.context).not.toHaveProperty('page_image')
    expect(message.quiz).toMatchObject({ recommendation: 'Read p. 12 again.', reviewing: undefined })

    // All right: nothing to review, and no call.
    ws.attachContext(topic.id, context(doc.id, 5), 'quiz')
    await ws.ask(topic.id, undefined, undefined, api)
    const perfect = topic.chat[3]
    await ws.answerQuiz(topic.id, perfect.id, 0, 1, api)
    await ws.answerQuiz(topic.id, perfect.id, 1, 0, api)
    expect(recommended).toHaveLength(1)
    expect(perfect.quiz!.recommendation).toBeUndefined()
  })

  it('says so when the note on what to review could not be written', async () => {
    const ws = new Workspace()
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    const api: QuizApi = {
      create: async () => structuredClone(written),
      recommend: async () => {
        throw new Error('offline')
      },
    }
    ws.setMode(topic.id, 'quiz')
    await ws.ask(topic.id, undefined, undefined, api)
    const message = topic.chat[1]
    await ws.answerQuiz(topic.id, message.id, 0, 0, api)
    await ws.answerQuiz(topic.id, message.id, 1, 1, api)
    expect(message.quiz!.reviewing).toBe('failed')
  })

  it('shows a quiz that could not be written as an error', async () => {
    const ws = new Workspace()
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    ws.setMode(topic.id, 'quiz')
    await ws.ask(topic.id, undefined, undefined, {
      create: async () => {
        throw new Error('The model service returned an error (529). Try again.')
      },
      recommend: async () => null,
    })
    expect(topic.chat[1]).toMatchObject({ status: 'error', text: 'The model service returned an error (529). Try again.' })
  })

  it('sends a quiz and how it went with later questions, so the model can adapt', async () => {
    const ws = new Workspace()
    const doc = ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    const { api } = fakeQuizApi()
    ws.attachContext(topic.id, context(doc.id, 5), 'quiz')
    await ws.ask(topic.id, undefined, undefined, api)
    await ws.answerQuiz(topic.id, topic.chat[1].id, 0, 0, api)
    await ws.answerQuiz(topic.id, topic.chat[1].id, 1, 0, api)
    ws.setMode(topic.id, 'normal')
    topic.draft = 'Why 2x?'
    const requests: AskRequest[] = []
    await ws.ask(topic.id, undefined, async function* (request) {
      requests.push(request)
    })
    expect(requests[0].messages[1]).toEqual({
      role: 'assistant',
      text: '',
      quiz: { ...written, picked: [0, 0], recommendation: 'Read p. 12 again.' },
    })
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

describe('Workspace saving', () => {
  const ready = (id: string): IndexStatus => ({
    id,
    status: 'ready',
    pages_done: 1,
    page_count: 1,
  })

  /** A workspace with one topic, one uploaded tab and a Socratic chat about a spot. */
  async function saved() {
    const ws = new Workspace()
    const doc = ws.addDoc('book.pdf', bytes(1, 2))
    const topic = ws.activeTopic!
    await ws.index(doc.id, {
      upload: async () => ready('srv1'),
      status: async () => ready('srv1'),
    })
    ws.pages[doc.id] = 12
    topic.mode = 'socratic'
    topic.draft = 'half a question'
    topic.chat.push(
      {
        id: 'q',
        role: 'user',
        text: '',
        mode: 'socratic',
        context: {
          docId: doc.id,
          docName: 'book.pdf',
          page: 3,
          pageImage: 'BIG',
          thumbnail: 'data:small',
          pageTexts: [{ page: 3, text: 'PAGETEXT' }],
        },
      },
      {
        id: 'a',
        role: 'assistant',
        text: 'What do you see?',
        status: 'done',
        mode: 'socratic',
      },
      { id: 'b', role: 'assistant', text: 'Half an ans', status: 'streaming' },
    )
    return { ws, doc, topic }
  }

  it('saves topics, tabs, pages, mode and chat, without page images or the draft', async () => {
    const { ws, doc, topic } = await saved()
    const snapshot = ws.snapshot()
    expect(snapshot).toMatchObject({
      version: 1,
      activeTopicId: topic.id,
      topics: [
        {
          id: topic.id,
          name: 'book',
          mode: 'socratic',
          activeDocId: doc.id,
          docs: [{ id: doc.id, name: 'book.pdf', serverId: 'srv1', page: 12 }],
        },
      ],
    })
    const json = JSON.stringify(snapshot)
    expect(json).not.toContain('BIG')
    expect(json).not.toContain('PAGETEXT')
    expect(json).not.toContain('half a question')
    expect(json).toContain('data:small')
  })

  it('leaves out tabs the backend does not have yet', () => {
    const ws = new Workspace()
    ws.addDoc('new.pdf', bytes(1))
    expect(ws.snapshot().topics[0]).toMatchObject({
      docs: [],
      activeDocId: undefined,
    })
  })

  it('brings a saved workspace back, reloading PDFs from the backend', async () => {
    const { ws, doc, topic } = await saved()
    const json = JSON.parse(JSON.stringify(ws.snapshot()))
    const loaded: string[] = []
    const back = new Workspace()
    const docIds = await back.restore(json, async (id) => {
      loaded.push(id)
      return bytes(1, 2)
    })
    expect(loaded).toEqual(['srv1'])
    expect(docIds).toEqual([doc.id])
    expect(back.activeTopic).toMatchObject({
      name: 'book',
      mode: 'socratic',
      docIds: [doc.id],
      draft: '',
    })
    expect(back.activeDoc?.data).toEqual(bytes(1, 2))
    expect(back.pages[doc.id]).toBe(12)
    expect(back.activeTopic!.chat.map((m) => m.text)).toEqual(['', 'What do you see?', 'Half an ans'])
    // The answer that was arriving when the app closed did not finish.
    expect(back.activeTopic!.chat[2].status).toBe('error')
    expect(back.activeTopic!.chat[0].context).toMatchObject({
      docId: doc.id,
      page: 3,
      thumbnail: 'data:small',
    })
    expect(topic.id).toBe(back.activeTopicId)

    // Indexing is followed by asking the backend, without uploading again.
    const seen: string[] = []
    await back.index(doc.id, {
      upload: async () => {
        seen.push('upload')
        return ready('srv1')
      },
      status: async (id) => {
        seen.push(`status ${id}`)
        return ready(id)
      },
    })
    expect(seen).toEqual(['status srv1'])
    expect(back.indexing[doc.id]).toMatchObject({
      serverId: 'srv1',
      status: 'ready',
    })
  })

  it('drops tabs whose PDF is gone and keeps topics opened while loading', async () => {
    const { ws } = await saved()
    const json = JSON.parse(JSON.stringify(ws.snapshot()))
    const back = new Workspace()
    back.addDoc('meanwhile.pdf', bytes(9))
    await back.restore(json, async () => {
      throw new Error('404')
    })
    expect(back.topics.map((t) => [t.name, t.docIds.length])).toEqual([
      ['book', 0],
      ['meanwhile', 1],
    ])
    expect(back.activeTopic?.name).toBe('meanwhile')
  })

  it('saves quizzes with their answers, and a note still being written comes back as failed', async () => {
    const { ws, topic } = await saved()
    topic.chat.push({
      id: 'quiz',
      role: 'assistant',
      text: '',
      mode: 'quiz',
      status: 'done',
      quiz: { ...structuredClone(written), picked: [0, 1], reviewing: 'writing' },
    })
    const back = new Workspace()
    await back.restore(JSON.parse(JSON.stringify(ws.snapshot())), async () => bytes(1))
    expect(back.activeTopic!.chat.at(-1)!.quiz).toEqual({ ...written, picked: [0, 1], reviewing: 'failed' })
  })

  it('ignores something that is not a saved workspace', async () => {
    const back = new Workspace()
    expect(await back.restore({}, async () => bytes())).toEqual([])
    expect(back.topics).toEqual([])
  })
})
