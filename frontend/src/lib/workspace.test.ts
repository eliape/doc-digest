import { describe, expect, it, vi } from 'vitest'
import type { AskRequest, DiscussionRequest, IndexStatus, RecommendationRequest, WrittenQuiz } from './api'
import type { PageContext } from './context'
import {
  type QuizApi,
  Workspace,
  askRequest,
  chatOf,
  chatTitle,
  discussionRequest,
  discussions,
  flashcardRequest,
  topicNameFor,
} from './workspace.svelte'

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
    // Closing only takes the tabs away: the PDFs stay as sources.
    expect(ws.activeTopic?.docIds).toEqual([a.id, b.id, c.id])
    expect(ws.activeTopic?.openDocIds).toEqual([])
  })

  it('reopens a closed source at the end of the tabs, and removing one takes it out', () => {
    const ws = new Workspace()
    const a = ws.addDoc('a.pdf', bytes(1))
    const b = ws.addDoc('b.pdf', bytes(2))
    ws.closeDoc(a.id)
    expect(ws.isTabOpen(a.id)).toBe(false)
    ws.openDoc(a.id)
    expect(ws.activeTopic?.openDocIds).toEqual([b.id, a.id])
    expect(ws.activeDoc?.id).toBe(a.id)
    // Adding the same file again reopens its closed tab.
    ws.closeDoc(a.id)
    expect(ws.addDoc('a.pdf', bytes(1)).id).toBe(a.id)
    expect(ws.activeTopic?.openDocIds).toEqual([b.id, a.id])
    ws.removeDoc(a.id)
    expect(ws.activeTopic?.docIds).toEqual([b.id])
    expect(ws.activeTopic?.openDocIds).toEqual([b.id])
    expect(ws.docs[a.id]).toBeUndefined()
  })

  it('treats the same PDF under a new name as the source it already is, and sends each name', () => {
    const ws = new Workspace()
    const a = ws.addDoc('a.pdf', bytes(1))
    ws.closeDoc(a.id)
    expect(ws.addDoc('renamed.pdf', bytes(1)).id).toBe(a.id)
    expect(ws.activeTopic?.docIds).toEqual([a.id])
    expect(ws.activeTopic?.openDocIds).toEqual([a.id])
    const request = askRequest(ws.activeTopic!, () => 'srv', undefined, undefined, (id) => ws.docs[id]?.name)
    expect(request.docs).toEqual(['srv'])
    expect(request.doc_names).toEqual({ srv: 'a.pdf' })
  })

  it('saves which sidebar lists are open for each topic', async () => {
    const ws = new Workspace()
    const first = ws.createTopic('First')
    first.sourcesOpen = true
    first.discussionsOpen = false
    ws.createTopic('Second')
    const json = JSON.parse(JSON.stringify(ws.snapshot()))
    expect(json.topics[1]).not.toHaveProperty('sourcesOpen')
    const back = new Workspace()
    back.restore(json)
    expect(back.topics.map((t) => [t.sourcesOpen, t.discussionsOpen])).toEqual([
      [true, false],
      [undefined, undefined],
    ])
  })

  it('moves a tab to a new place in the row', () => {
    const ws = new Workspace()
    const [a, b, c] = ['a', 'b', 'c'].map((n, i) => ws.addDoc(`${n}.pdf`, bytes(i + 1)))
    ws.moveTab(c.id, 0)
    expect(ws.activeTopic?.openDocIds).toEqual([c.id, a.id, b.id])
    ws.moveTab(c.id, 9)
    expect(ws.activeTopic?.openDocIds).toEqual([a.id, b.id, c.id])
    expect(ws.activeTopic?.docIds).toEqual([a.id, b.id, c.id])
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
    expect(chatOf(ws.activeTopic!).messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'What is a p-value?'],
      ['assistant', ''],
    ])
    expect(first.draft).toBe('')

    const second = ws.createTopic('Second')
    expect(chatOf(second).messages).toEqual([])
    second.draft = '   '
    ws.ask(second.id)
    expect(chatOf(ws.activeTopic!).messages).toEqual([])
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

  it("keeps the thinking summary with the answer, sends the effort, and never sends the thinking back", async () => {
    const ws = new Workspace()
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    ws.answerEffort = 'high'
    topic.draft = 'Why?'
    const requests: AskRequest[] = []
    const answer = async function* (request: AskRequest) {
      requests.push(request)
      yield { type: 'thinking' as const, text: 'Look it ' }
      yield { type: 'thinking' as const, text: 'up.' }
      yield { type: 'step' as const, text: 'Searched' }
      yield { type: 'thinking' as const, text: 'Found it.' }
      yield { type: 'text' as const, text: 'Because.' }
    }
    await ws.ask(topic.id, undefined, answer)
    const reply = chatOf(topic).messages[1]
    expect(reply.thinking).toBe('Look it up.\n\nFound it.')
    expect(reply.thinkingSeconds).toBeGreaterThanOrEqual(0)
    expect(reply.text).toBe('Because.')
    expect(requests[0].effort).toBe('high')

    topic.draft = 'And?'
    await ws.ask(topic.id, undefined, answer)
    expect(requests[1].messages[1]).toEqual({ role: 'assistant', text: 'Because.' })
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
    expect(chatOf(topic).messages.map((m) => [m.role, m.text, m.status])).toEqual([
      ['user', 'How is this derived?', undefined],
      ['assistant', 'By parts.', 'done'],
    ])
    expect(chatOf(topic).messages[1].steps).toEqual(['Searched for “parts”'])
    expect(chatOf(topic).messages[0].context?.page).toBe(3)
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
    expect(chatOf(topic).messages[0].context?.page).toBe(7)
  })

  it('shows why an answer failed and leaves it out of the next request', async () => {
    const ws = new Workspace()
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    topic.draft = 'first'
    await ws.ask(topic.id, undefined, async function* () {
      throw new Error('No API key')
    })
    expect(chatOf(topic).messages[1]).toMatchObject({ role: 'assistant', status: 'error', text: 'No API key' })
    topic.draft = 'second'
    let sent: AskRequest | undefined
    await ws.ask(topic.id, undefined, async function* (request) {
      sent = request
    })
    // The failed question stays in the chat, but the model only sees the new one.
    expect(chatOf(topic).messages.map((m) => m.text)).toEqual(['first', 'No API key', 'second', ''])
    expect(sent?.messages.map((m) => [m.role, m.text])).toEqual([['user', 'second']])
  })

  it('keeps what had arrived of an answer that failed', async () => {
    const ws = new Workspace()
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    topic.draft = 'q'
    await ws.ask(topic.id, undefined, async function* () {
      yield { type: 'text', text: 'Half an answer' }
      throw new Error('Connection lost')
    })
    expect(chatOf(topic).messages[1]).toMatchObject({ status: 'error', text: 'Half an answer\n\n*Connection lost*' })
  })

  it('takes a failed question back into the box to ask it again', async () => {
    const ws = new Workspace()
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    topic.draft = 'first'
    await ws.ask(topic.id, undefined, async function* () {
      throw new Error('No API key')
    })
    const failed = chatOf(topic).messages[1]
    topic.draft = 'typed since'
    expect(ws.retry(topic.id, 'not-the-answer')).toBe(false)
    expect(ws.retry(topic.id, failed.id)).toBe(true)
    expect(chatOf(topic).messages).toEqual([])
    expect(topic.draft).toBe('first\n\ntyped since')
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
    expect(chatOf(topic).messages).toHaveLength(2)
    expect(topic.draft).toBe('second')
    finish()
    await pending
    expect(ws.isAnswering(topic.id)).toBe(false)
  })

  // Like fetch, the stream fails once it is aborted.
  const aborted = (signal: AbortSignal) =>
    new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))

  it('takes a stopped question back into the box and leaves it and its half answer out of the chat', async () => {
    const ws = new Workspace()
    const notes: DiscussionRequest[] = []
    ws.registerApi = { ...ws.registerApi, note: async (_topicId, request) => void notes.push(request) }
    let titled!: (title: string) => void
    ws.titleApi = () => new Promise((resolve) => (titled = resolve))
    const doc = ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    ws.attachContext(topic.id, context(doc.id, 3))
    topic.draft = 'How is this derived?'
    let signal: AbortSignal | undefined
    const pending = ws.ask(topic.id, undefined, async function* (_request, s) {
      signal = s
      yield { type: 'text', text: 'By ' }
      await aborted(s!)
    })
    await new Promise((resolve) => setTimeout(resolve))
    expect(chatOf(topic).messages.at(-1)?.text).toBe('By ')
    topic.draft = 'and why?'

    ws.stop(topic.id)
    await pending
    expect(signal?.aborted).toBe(true)
    expect(chatOf(topic).messages).toEqual([])
    expect(ws.isAnswering(topic.id)).toBe(false)
    expect(topic.draft).toBe('How is this derived?\n\nand why?')
    expect(topic.context?.page).toBe(3)
    // The title asked for before the stop doesn't name the now empty discussion.
    titled('Deriving it')
    await new Promise((resolve) => setTimeout(resolve))
    expect(chatOf(topic).title).toBeUndefined()

    // The model never sees the stopped turn, and the register never notes it.
    topic.draft = 'Ask again'
    let sent: AskRequest | undefined
    await ws.ask(topic.id, undefined, async function* (request) {
      sent = request
      yield { type: 'text', text: 'Done.' }
    })
    expect(sent?.messages.map((m) => [m.role, m.text])).toEqual([['user', 'Ask again']])
    ws.newChat(topic.id)
    expect(notes).toHaveLength(1)
    expect(notes[0].messages.map((m) => m.text)).toEqual(['Ask again', 'Done.'])
  })

  it('goes back to Quiz mode when a quiz being written is stopped', async () => {
    const ws = new Workspace()
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    ws.setMode(topic.id, 'quiz')
    topic.draft = 'derivatives'
    const quizApi: QuizApi = { create: (_request, signal) => aborted(signal!), recommend: async () => null }
    const pending = ws.ask(topic.id, undefined, undefined, quizApi)
    await new Promise((resolve) => setTimeout(resolve))
    expect(chatOf(topic).mode).toBe('normal')
    ws.stop(topic.id)
    await pending
    expect(chatOf(topic).messages).toEqual([])
    expect(chatOf(topic).mode).toBe('quiz')
    expect(topic.draft).toBe('derivatives')
  })

  it('starts a new discussion, keeping the old one, its answer, the draft and the attached spot', async () => {
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
    expect(chatOf(topic).messages.at(-1)?.text).toBe('Part one')

    const first = chatOf(topic)
    ws.attachContext(topic.id, context(doc.id, 3))
    topic.draft = 'unsent'
    ws.newChat(topic.id)
    expect(chatOf(topic).messages).toEqual([])
    expect(chatOf(topic).id).not.toBe(first.id)
    expect(topic.context?.page).toBe(3)
    expect(topic.draft).toBe('unsent')
    expect(ws.isAnswering(topic.id)).toBe(false)

    // The answer goes on in its own discussion, not the new one.
    expect(signal?.aborted).toBe(false)
    more()
    await pending
    expect(chatOf(topic).messages).toEqual([])
    expect(topic.chats.find((c) => c.id === first.id)?.messages.at(-1)?.text).toBe('Part one and part two')
    expect(ws.docs[doc.id]).toBeDefined()

    // An empty discussion is reused rather than piling up another.
    ws.setMode(topic.id, 'socratic')
    ws.newChat(topic.id)
    expect(topic.chats).toHaveLength(2)
    expect(chatOf(topic).mode).toBe('normal')
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

  it("sends the reader's own instructions with every question, and saves them", async () => {
    const ws = new Workspace()
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    const sent: (string | undefined)[] = []
    const stream = async function* (request: AskRequest) {
      sent.push(request.instructions)
    }
    topic.draft = 'one'
    await ws.ask(topic.id, undefined, stream)
    expect(ws.snapshot().instructions).toBeUndefined()
    ws.instructions = ' Answer in Swedish. '
    topic.draft = 'two'
    await ws.ask(topic.id, undefined, stream)
    expect(sent).toEqual([undefined, 'Answer in Swedish.'])
    const back = new Workspace()
    back.restore(JSON.parse(JSON.stringify(ws.snapshot())))
    expect(back.instructions).toBe(' Answer in Swedish. ')
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
    expect(chatOf(topic).mode).toBe('socratic')
    expect(chatOf(topic).messages).toEqual([])
    expect(ws.canSend(topic.id)).toBe(true)
    await ws.ask(topic.id, undefined, stream)

    expect(chatOf(topic).messages.map((m) => [m.role, m.text, m.mode])).toEqual([
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
    expect(chatOf(topic).messages.at(-1)?.mode).toBe('socratic')

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
    expect(chatOf(topic).mode).toBe('normal')
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
    expect(chatOf(topic).mode).toBe('normal')
    ws.setMode(topic.id, 'socratic')

    // Clicking a spot is for asking about it, so it switches back to normal answers.
    ws.attachContext(topic.id, context(doc.id, 3))
    expect(chatOf(topic).mode).toBe('normal')
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
    ws.attachContext(topic.id, context(doc.id, 5))
    ws.setMode(topic.id, 'quiz')
    expect(ws.canSend(topic.id)).toBe(false)
    await ws.ask(topic.id, undefined, undefined, fakeQuizApi().api)
    expect(chatOf(topic).messages).toHaveLength(2)
    finish()
    await pending
  })

  it('opens a new discussion for Socratic or Quiz me on a spot, and keeps the open one for Ask', async () => {
    const ws = new Workspace()
    const doc = ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    topic.draft = 'first'
    await ws.ask(topic.id, undefined, async function* () {
      yield { type: 'text' as const, text: 'An answer.' }
    })
    const first = chatOf(topic)
    ws.attachContext(topic.id, context(doc.id, 5))
    expect(chatOf(topic)).toBe(first)

    ws.attachContext(topic.id, context(doc.id, 6), 'socratic')
    const session = chatOf(topic)
    expect(session).not.toBe(first)
    expect(session).toMatchObject({ messages: [], mode: 'socratic' })
    expect(first.mode).toBe('normal')
    expect(topic.context?.page).toBe(6)
    // While it is still empty, Quiz me reuses it rather than piling up empty discussions.
    ws.attachContext(topic.id, context(doc.id, 7), 'quiz')
    expect(chatOf(topic)).toBe(session)
    expect(session.mode).toBe('quiz')
    expect(topic.chats).toHaveLength(2)
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
    const [asked, quiz] = chatOf(topic).messages
    expect(asked).toMatchObject({ role: 'user', text: 'the chain rule', mode: 'quiz' })
    expect(quiz).toMatchObject({ role: 'assistant', mode: 'quiz', status: 'done', text: '' })
    expect(quiz.quiz).toEqual({ ...written, picked: [null, null] })
    // Sending a quiz goes back to Normal, so the next question is an ordinary one.
    expect(chatOf(topic).mode).toBe('normal')
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
      expect(chatOf(topic).mode).toBe('normal')
    }
    // Picked from the menu with nothing attached, the mode stays.
    ws.setMode(topic.id, 'quiz')
    ws.clearContext(topic.id)
    expect(chatOf(topic).mode).toBe('quiz')
  })

  it('takes each quiz answer once, and asks for a note on what to review only after a wrong one', async () => {
    const ws = new Workspace()
    const doc = ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    const { api, recommended } = fakeQuizApi()
    ws.attachContext(topic.id, context(doc.id, 5), 'quiz')
    topic.draft = 'the power rule'
    await ws.ask(topic.id, undefined, undefined, api)
    const message = chatOf(topic).messages[1]

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

    // All right: nothing to review, and no call. (Quiz me opens a new discussion for it.)
    ws.attachContext(topic.id, context(doc.id, 5), 'quiz')
    await ws.ask(topic.id, undefined, undefined, api)
    const perfect = chatOf(topic).messages[1]
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
    const message = chatOf(topic).messages[1]
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
    expect(chatOf(topic).messages[1]).toMatchObject({ status: 'error', text: 'The model service returned an error (529). Try again.' })
  })

  it('sends a quiz and how it went with later questions, so the model can adapt', async () => {
    const ws = new Workspace()
    const doc = ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    const { api } = fakeQuizApi()
    ws.attachContext(topic.id, context(doc.id, 5), 'quiz')
    await ws.ask(topic.id, undefined, undefined, api)
    await ws.answerQuiz(topic.id, chatOf(topic).messages[1].id, 0, 0, api)
    await ws.answerQuiz(topic.id, chatOf(topic).messages[1].id, 1, 0, api)
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
    chatOf(topic).messages.push(
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
    ws.removeDoc(other.id)
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
    chatOf(topic).mode = 'socratic'
    topic.draft = 'half a question'
    chatOf(topic).messages.push(
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
          chatId: chatOf(topic).id,
          chats: [{ id: chatOf(topic).id, mode: 'socratic' }],
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

  it('saves the scope and conventions of a topic and sends them with every question', async () => {
    const { ws, topic } = await saved()
    topic.scope = ' Exam in TMA4100 '
    topic.conventions = '   '
    expect(askRequest(topic)).toMatchObject({ scope: 'Exam in TMA4100' })
    expect(askRequest(topic)).not.toHaveProperty('conventions')
    topic.conventions = 'j is the imaginary unit'
    const back = new Workspace()
    back.restore(JSON.parse(JSON.stringify(ws.snapshot())))
    const restored = back.topics[0]
    expect([restored.scope, restored.conventions]).toEqual([' Exam in TMA4100 ', 'j is the imaginary unit'])
    expect(askRequest(restored)).toMatchObject({ scope: 'Exam in TMA4100', conventions: 'j is the imaginary unit' })
  })

  it('brings back the purpose of a topic saved before it had a scope as its scope', async () => {
    const { ws } = await saved()
    const old = JSON.parse(JSON.stringify(ws.snapshot()))
    old.topics[0].purpose = 'Exam in December'
    const back = new Workspace()
    back.restore(old)
    expect(back.topics[0].scope).toBe('Exam in December')
    expect(back.snapshot().topics[0]).toMatchObject({ scope: 'Exam in December' })
    expect(back.snapshot().topics[0]).not.toHaveProperty('purpose')
  })

  it('keeps the tab order and the closed sources across a reload, and opens all in old saves', async () => {
    const saved = (open?: string[]) => ({
      version: 1,
      activeTopicId: 't',
      topics: [
        {
          id: 't',
          name: 'T',
          docs: ['a', 'b', 'c'].map((id) => ({ id, name: `${id}.pdf`, serverId: `s${id}` })),
          ...(open && { open }),
          activeDocId: 'c',
        },
      ],
    })
    const back = new Workspace()
    back.restore(saved(['c', 'a']))
    expect(back.activeTopic?.docIds).toEqual(['a', 'b', 'c'])
    expect(back.activeTopic?.openDocIds).toEqual(['c', 'a'])
    expect(back.activeDoc?.id).toBe('c')
    expect(JSON.parse(JSON.stringify(back.snapshot())).topics[0]).toMatchObject({ open: ['c', 'a'] })

    const old = new Workspace()
    old.restore(saved())
    expect(old.activeTopic?.openDocIds).toEqual(['a', 'b', 'c'])
  })

  it('leaves out tabs the backend does not have yet', () => {
    const ws = new Workspace()
    ws.addDoc('new.pdf', bytes(1))
    expect(ws.snapshot().topics[0]).toMatchObject({
      docs: [],
      activeDocId: undefined,
    })
  })

  it('brings a saved workspace back, fetching a PDF from the backend once it is shown', async () => {
    const { ws, doc, topic } = await saved()
    const json = JSON.parse(JSON.stringify(ws.snapshot()))
    const loaded: string[] = []
    const back = new Workspace()
    back.pdfApi = async (id) => {
      loaded.push(id)
      return bytes(1, 2)
    }
    const docIds = back.restore(json)
    expect(docIds).toEqual([doc.id])
    expect(loaded).toEqual([])
    expect(back.activeDoc?.data).toBeUndefined()
    await back.loadPdf(doc.id)
    await back.loadPdf(doc.id)
    expect(loaded).toEqual(['srv1'])
    expect(back.activeTopic).toMatchObject({
      name: 'book',
      docIds: [doc.id],
      draft: '',
    })
    expect(chatOf(back.activeTopic!).mode).toBe('socratic')
    expect(back.activeDoc?.data).toEqual(bytes(1, 2))
    expect(back.pages[doc.id]).toBe(12)
    // An answer still arriving is saved without what had arrived, so it isn't saved for every piece.
    expect(json.topics[0].chats[0].messages[2]).toEqual({ id: 'b', role: 'assistant', text: '', status: 'streaming' })
    expect(chatOf(back.activeTopic!).messages.map((m) => m.text)).toEqual(['', 'What do you see?', 'The answer stopped when the app was closed.'])
    // The answer that was arriving when the app closed did not finish.
    expect(chatOf(back.activeTopic!).messages[2].status).toBe('error')
    expect(chatOf(back.activeTopic!).messages[0].context).toMatchObject({
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

  it('keeps a tab whose PDF cannot be fetched, says why, and tries again when asked', async () => {
    const { ws, doc } = await saved()
    const json = JSON.parse(JSON.stringify(ws.snapshot()))
    const back = new Workspace()
    back.addDoc('meanwhile.pdf', bytes(9))
    back.pdfApi = async () => {
      throw new Error('The backend returned an error (503). Is it running?')
    }
    back.restore(json)
    await back.loadPdf(doc.id)
    expect(back.topics.map((t) => [t.name, t.docIds.length])).toEqual([
      ['book', 1],
      ['meanwhile', 1],
    ])
    expect(back.activeTopic?.name).toBe('meanwhile')
    expect(back.pdfErrors[doc.id]).toContain('Could not load book.pdf')
    // Saving now keeps the tab.
    expect(back.snapshot().topics[0].docs).toEqual(json.topics[0].docs)
    back.pdfApi = async () => bytes(1, 2)
    back.retryPdf(doc.id)
    await vi.waitFor(() => expect(back.docs[doc.id].data).toEqual(bytes(1, 2)))
    expect(back.pdfErrors[doc.id]).toBeUndefined()
  })

  it('keeps a PDF that could not be shown in its topic', async () => {
    const { ws, doc, topic } = await saved()
    ws.pdfFailed(doc.id, 'Could not show book.pdf.')
    expect(topic.docIds).toEqual([doc.id])
    expect(ws.pdfErrors[doc.id]).toBe('Could not show book.pdf.')
  })

  it('adding a saved PDF again before it was shown goes back to its tab', async () => {
    const { ws, doc } = await saved()
    const back = new Workspace()
    back.restore(JSON.parse(JSON.stringify(ws.snapshot())))
    const again = back.addDoc('book copy.pdf', bytes(1, 2))
    await back.index(again.id, { upload: async () => ready('srv1'), status: async () => ready('srv1') })
    expect(back.activeTopic?.docIds).toEqual([doc.id])
    expect(back.activeTopic?.activeDocId).toBe(doc.id)
    expect(back.docs[again.id]).toBeUndefined()
  })

  it('tries indexing again when asked after it failed', async () => {
    const { ws, doc } = await saved()
    ws.indexing[doc.id] = { ...ws.indexing[doc.id], status: 'error', error: 'Rate limited' }
    const calls: string[] = []
    await ws.retryIndex(doc.id, {
      upload: async () => ready('srv1'),
      status: async (id) => {
        calls.push(`status ${id}`)
        return ready(id)
      },
      retry: async (id) => {
        calls.push(`retry ${id}`)
        return { ...ready(id), status: 'queued' }
      },
    })
    expect(calls).toEqual(['retry srv1', 'status srv1'])
    expect(ws.indexing[doc.id]).toMatchObject({ status: 'ready', error: undefined })
  })

  it('saves quizzes with their answers, and a note still being written comes back as failed', async () => {
    const { ws, topic } = await saved()
    chatOf(topic).messages.push({
      id: 'quiz',
      role: 'assistant',
      text: '',
      mode: 'quiz',
      status: 'done',
      quiz: { ...structuredClone(written), picked: [0, 1], reviewing: 'writing' },
    })
    const back = new Workspace()
    back.restore(JSON.parse(JSON.stringify(ws.snapshot())))
    expect(chatOf(back.activeTopic!).messages.at(-1)!.quiz).toEqual({ ...written, picked: [0, 1], reviewing: 'failed' })
  })

  it('brings back a topic saved with one chat as its one discussion, and has it titled', async () => {
    const back = new Workspace()
    const titled: string[] = []
    back.titleApi = async (request) => {
      titled.push(request.about.text)
      return 'Limits'
    }
    back.restore(
      {
        version: 1,
        topics: [
          {
            id: 't',
            name: 'Old',
            docs: [],
            mode: 'quiz',
            chat: [
              { id: 'q', role: 'user', text: 'What is a limit?' },
              { id: 'a', role: 'assistant', text: 'It is…', status: 'done' },
            ],
          },
        ],
      },
    )
    const topic = back.activeTopic!
    expect(topic.chats).toHaveLength(1)
    expect(chatOf(topic)).toMatchObject({ mode: 'quiz', messages: [{ id: 'q' }, { id: 'a' }] })
    await new Promise((resolve) => setTimeout(resolve))
    expect(titled).toEqual(['What is a limit?'])
    expect(chatOf(topic).title).toBe('Limits')
  })

  it('saves every discussion with something in it, and which one is open', async () => {
    const { ws, topic } = await saved()
    const first = chatOf(topic).id
    ws.newChat(topic.id)
    expect(ws.snapshot().topics[0].chats?.map((c) => c.id)).toEqual([first, chatOf(topic).id])
    ws.selectChat(topic.id, first)
    // The empty one was left, so it is gone.
    expect(ws.snapshot().topics[0]).toMatchObject({ chatId: first, chats: [{ id: first }] })
  })

  it('ignores something that is not a saved workspace', async () => {
    const back = new Workspace()
    expect(back.restore({})).toEqual([])
    expect(back.topics).toEqual([])
  })
})

describe('Workspace deleting sources', () => {
  const ready = (id: string): IndexStatus => ({ id, status: 'ready', pages_done: 1, page_count: 1 })
  const at = (id: string) => ({ upload: async () => ready(id), status: async () => ready(id) })

  /** A PDF the backend knows as `serverId`, added to a new topic. */
  async function added(ws: Workspace, topic: string, serverId: string) {
    ws.createTopic(topic)
    const doc = ws.addDoc(`${serverId}.pdf`, bytes(serverId.length, 7))
    await ws.index(doc.id, at(serverId))
    return doc
  }

  it('releases a removed PDF for the next save to delete, once', async () => {
    const ws = new Workspace()
    const released = vi.fn()
    ws.onReleased = released
    const doc = await added(ws, 'Calculus', 'srv1')
    ws.removeDoc(doc.id)
    expect(released).toHaveBeenCalledOnce()
    expect(ws.takeReleased()).toEqual(['srv1'])
    expect(ws.takeReleased()).toEqual([])
  })

  it('keeps a PDF that another topic still has, and says which', async () => {
    const ws = new Workspace()
    const first = await added(ws, 'Calculus', 'srv1')
    const second = await added(ws, 'Exam', 'srv1')
    expect(ws.otherTopicsWith(second.id).map((t) => t.name)).toEqual(['Calculus'])
    ws.removeDoc(second.id)
    expect(ws.takeReleased()).toEqual([])
    expect(ws.topicOf(first.id)?.name).toBe('Calculus')
    ws.removeDoc(first.id)
    expect(ws.takeReleased()).toEqual(['srv1'])
  })

  it('releases the PDFs of a deleted topic that no other topic has', async () => {
    const ws = new Workspace()
    await added(ws, 'Calculus', 'shared')
    const exam = ws.topics.length
    await added(ws, 'Exam', 'shared')
    const doc = ws.addDoc('own.pdf', bytes(9, 9))
    await ws.index(doc.id, at('own'))
    ws.deleteTopic(ws.topics[exam].id)
    expect(ws.takeReleased()).toEqual(['own'])
  })

  it('does not release a PDF that was added again before the save', async () => {
    const ws = new Workspace()
    const doc = await added(ws, 'Calculus', 'srv1')
    ws.removeDoc(doc.id)
    await added(ws, 'Exam', 'srv1')
    expect(ws.takeReleased()).toEqual([])
  })

  it('releases a PDF removed while it was still uploading', async () => {
    const ws = new Workspace()
    ws.createTopic('Calculus')
    const doc = ws.addDoc('slow.pdf', bytes(1))
    let finish!: (s: IndexStatus) => void
    const indexing = ws.index(doc.id, { upload: () => new Promise((resolve) => (finish = resolve)), status: async () => ready('slow') })
    ws.removeDoc(doc.id)
    expect(ws.takeReleased()).toEqual([])
    finish(ready('slow'))
    await indexing
    expect(ws.takeReleased()).toEqual(['slow'])
  })

  it('releases again what a save could not delete, unless it is back in a topic', async () => {
    const ws = new Workspace()
    await added(ws, 'Calculus', 'kept')
    ws.rerelease(['gone', 'kept'])
    expect(ws.hasReleased()).toBe(true)
    expect(ws.takeReleased()).toEqual(['gone'])
    expect(ws.hasReleased()).toBe(false)
  })
})

describe('Workspace discussions', () => {
  const context = (docId: string, page: number): PageContext => ({ docId, docName: 'notes.pdf', page, pageTexts: [] })

  async function asked(ws: Workspace, topicId: string, text: string) {
    ws.topics.find((t) => t.id === topicId)!.draft = text
    await ws.ask(topicId, undefined, async function* () {
      yield { type: 'text', text: `About ${text}` }
    })
  }

  it('titles a discussion with Haiku after its first question only', async () => {
    const ws = new Workspace()
    const requests: unknown[] = []
    ws.titleApi = async (request) => {
      requests.push(request)
      return 'Power rule'
    }
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    await asked(ws, topic.id, 'Why is the derivative of x² 2x?')
    await asked(ws, topic.id, 'And x³?')
    expect(requests).toEqual([{ topic: 'notes', about: { role: 'user', text: 'Why is the derivative of x² 2x?' } }])
    expect(chatTitle(chatOf(topic))).toBe('Power rule')
  })

  it('goes by the start of the first question until it has a title', () => {
    expect(chatTitle({ id: 'c', messages: [], mode: 'normal', updatedAt: 0 })).toBe('New chat')
    const long = 'word '.repeat(20)
    const chat = { id: 'c', messages: [{ id: 'q', role: 'user' as const, text: long }], mode: 'normal' as const, updatedAt: 0 }
    expect(chatTitle(chat)).toHaveLength(48)
    expect(chatTitle(chat).endsWith('…')).toBe(true)
    expect(chatTitle({ ...chat, messages: [{ id: 'q', role: 'user', text: '', mode: 'quiz' }] })).toBe('Quiz')
  })

  it('lists discussions by last use, and switching keeps the draft and spot', async () => {
    const ws = new Workspace()
    ws.titleApi = async () => null
    const doc = ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    await asked(ws, topic.id, 'one')
    const one = chatOf(topic).id
    await new Promise((resolve) => setTimeout(resolve, 2))
    ws.newChat(topic.id)
    await asked(ws, topic.id, 'two')
    const two = chatOf(topic).id
    expect(discussions(topic).map((c) => c.id)).toEqual([two, one])

    ws.attachContext(topic.id, context(doc.id, 4))
    topic.draft = 'draft'
    ws.selectChat(topic.id, one)
    expect(chatOf(topic).id).toBe(one)
    expect(topic.draft).toBe('draft')
    expect(topic.context?.page).toBe(4)
    await new Promise((resolve) => setTimeout(resolve, 2))
    await asked(ws, topic.id, 'three')
    expect(discussions(topic).map((c) => c.id)).toEqual([one, two])
  })

  it('deletes a discussion; deleting the open one opens a new, empty chat', async () => {
    const ws = new Workspace()
    ws.titleApi = async () => null
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    await asked(ws, topic.id, 'one')
    const one = chatOf(topic).id
    await new Promise((resolve) => setTimeout(resolve, 2))
    ws.newChat(topic.id)
    await asked(ws, topic.id, 'two')
    const two = chatOf(topic).id
    ws.selectChat(topic.id, one)

    // Deleting another one leaves the open one open.
    ws.deleteChat(topic.id, two)
    expect(topic.chats.map((c) => c.id)).toEqual([one])
    expect(chatOf(topic).id).toBe(one)

    ws.newChat(topic.id)
    await asked(ws, topic.id, 'three')
    const three = chatOf(topic).id
    ws.deleteChat(topic.id, three)
    expect(topic.chats.map((c) => c.id)).toContain(one)
    expect(chatOf(topic).messages).toEqual([])
    expect(discussions(topic).map((c) => c.id)).toEqual([one])
  })

  it('stops an answer still arriving in a deleted discussion or topic', async () => {
    const ws = new Workspace()
    ws.titleApi = async () => null
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    const signals: AbortSignal[] = []
    const ask = () => {
      topic.draft = 'q'
      void ws.ask(topic.id, undefined, async function* (_request, signal) {
        signals.push(signal!)
        await new Promise(() => {})
        yield { type: 'text', text: '' }
      })
    }
    ask()
    await new Promise((resolve) => setTimeout(resolve))
    ws.deleteChat(topic.id, topic.chats[0].id)
    expect(signals[0].aborted).toBe(true)
    ask()
    await new Promise((resolve) => setTimeout(resolve))
    ws.deleteTopic(topic.id)
    expect(signals[1].aborted).toBe(true)
  })

  it('sends a reply with the quoted part of the answer, and drops the quote on switching discussions', async () => {
    const ws = new Workspace()
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    await asked(ws, topic.id, 'What is a ring?')
    ws.quoteReply(topic.id, '  a set with two operations\nsatisfying axioms ')
    topic.draft = 'Which axioms?'
    const requests: AskRequest[] = []
    await ws.ask(topic.id, undefined, async function* (request) {
      requests.push(request)
      yield { type: 'text', text: 'These.' }
    })
    expect(topic.quote).toBeUndefined()
    expect(chatOf(topic).messages[2]).toMatchObject({ text: 'Which axioms?', quote: 'a set with two operations\nsatisfying axioms' })
    expect(requests[0].messages[2].text).toBe(
      'Replying to this part of your answer:\n> a set with two operations\n> satisfying axioms\n\nWhich axioms?',
    )

    ws.quoteReply(topic.id, 'These')
    ws.newChat(topic.id)
    expect(topic.quote).toBeUndefined()
  })

  it('continues a discussion from one of its answers in a new one, leaving the original as it was', async () => {
    const ws = new Workspace()
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    await asked(ws, topic.id, 'first')
    await asked(ws, topic.id, 'second')
    const original = chatOf(topic)
    original.title = 'Rings'
    // Used a moment ago, so the branch (used now) sorts first even within the same millisecond.
    original.updatedAt -= 1000
    ws.setMode(topic.id, 'socratic')
    // So the branch is used later than the original, not in the same millisecond.
    await new Promise((resolve) => setTimeout(resolve, 2))

    ws.splitChat(topic.id, original.messages[1].id)
    const split = chatOf(topic)
    expect(split.id).not.toBe(original.id)
    expect(split.title).toBe('Branch · Rings')
    expect(split.branch).toEqual({ from: original.id, at: 2 })
    expect(split.mode).toBe('socratic')
    expect(split.messages.map((m) => m.text)).toEqual(['first', 'About first'])
    expect(split.messages[0].id).not.toBe(original.messages[0].id)
    expect(original.messages).toHaveLength(4)

    split.messages[1].text = 'changed'
    expect(original.messages[1].text).toBe('About first')
    expect(discussions(topic).map((c) => c.id)).toEqual([split.id, original.id])
  })
})

describe('Workspace register', () => {
  function workspace() {
    const ws = new Workspace()
    ws.titleApi = async () => null
    const noted: [string, DiscussionRequest][] = []
    const forgotten: string[] = []
    ws.registerApi = {
      note: async (topicId, request) => void noted.push([topicId, request]),
      forget: async (topicId) => void forgotten.push(topicId),
    }
    return { ws, noted, forgotten }
  }

  async function asked(ws: Workspace, topicId: string, text: string) {
    ws.topics.find((t) => t.id === topicId)!.draft = text
    await ws.ask(topicId, undefined, async function* () {
      yield { type: 'text', text: `About ${text}` }
    })
  }

  it('names the topic and discussion in each question, for their notes', async () => {
    const { ws } = workspace()
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    const request = askRequest(topic)
    expect(request.topic_id).toBe(topic.id)
    expect(request.chat_id).toBe(chatOf(topic).id)
  })

  it('notes a discussion when the reader leaves it for another one, a new one or another topic', async () => {
    const { ws, noted } = workspace()
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    await asked(ws, topic.id, 'one')
    const one = chatOf(topic).id
    expect(noted).toEqual([])

    ws.newChat(topic.id)
    expect(noted.map(([t, r]) => [t, r.chat_id])).toEqual([[topic.id, one]])
    expect(noted[0][1].messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'one'],
      ['assistant', 'About one'],
    ])

    // Leaving an empty chat notes nothing.
    ws.selectChat(topic.id, one)
    expect(noted).toHaveLength(1)

    await asked(ws, topic.id, 'two')
    ws.createTopic('Other')
    const otherDoc = ws.addDoc('other.pdf', bytes(2))
    expect(noted.map(([, r]) => r.chat_id)).toEqual([one, one])
    // Its turns since the last time are for the backend to pick out: all of them are sent.
    expect(noted[1][1].messages).toHaveLength(4)
    ws.selectTopic(topic.id)
    expect(noted).toHaveLength(2) // the other topic's chat is empty

    // Switching tabs within the topic leaves nothing; a tab in another topic leaves it.
    ws.addDoc('b.pdf', bytes(3))
    ws.selectDoc(topic.docIds[0])
    expect(noted).toHaveLength(2)
    ws.selectDoc(otherDoc.id)
    expect(noted.map(([, r]) => r.chat_id)).toEqual([one, one, one])
  })

  it('notes an answer that finished after its discussion was left', async () => {
    const { ws, noted } = workspace()
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    let finish = () => {}
    topic.draft = 'slow'
    const answering = ws.ask(topic.id, undefined, async function* () {
      await new Promise<void>((resolve) => (finish = resolve))
      yield { type: 'text', text: 'Done.' }
    })
    await new Promise((resolve) => setTimeout(resolve))
    const slow = chatOf(topic).id
    ws.newChat(topic.id)
    expect(noted).toEqual([]) // nothing answered yet when it was left
    finish()
    await answering
    expect(noted.map(([, r]) => r.chat_id)).toEqual([slow])
  })

  it('notes the discussion a branch leaves, and a branch only for what is new in it', async () => {
    const { ws, noted } = workspace()
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    await asked(ws, topic.id, 'first')
    const original = chatOf(topic)
    ws.splitChat(topic.id, original.messages[1].id)
    expect(noted.map(([, r]) => r.chat_id)).toEqual([original.id])
    expect(discussionRequest(topic, chatOf(topic)).messages).toEqual([])
    await asked(ws, topic.id, 'second')
    expect(discussionRequest(topic, chatOf(topic)).messages.map((m) => m.text)).toEqual(['second', 'About second'])
  })

  it('reads a quiz again once it has been answered, and forgets a deleted topic', async () => {
    const { ws, forgotten } = workspace()
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    ws.quizApi = { create: async () => written, recommend: async () => 'Review the power rule.' }
    ws.setMode(topic.id, 'quiz')
    await ws.ask(topic.id)
    const quiz = chatOf(topic).messages[1]
    const key = () => discussionRequest(topic, chatOf(topic)).messages[1].key
    expect(key()).toBe(`${quiz.id}/0`)
    await ws.answerQuiz(topic.id, quiz.id, 0, 0)
    await ws.answerQuiz(topic.id, quiz.id, 1, 0)
    expect(key()).toBe(`${quiz.id}/2+`)
    expect(discussionRequest(topic, chatOf(topic)).messages[0]).not.toHaveProperty('context.page_image')

    ws.deleteTopic(topic.id)
    expect(forgotten).toEqual([topic.id])
  })
})

describe('Workspace flashcards', () => {
  async function talked(ws: Workspace, topicId: string, text: string) {
    ws.topics.find((t) => t.id === topicId)!.draft = text
    await ws.ask(topicId, undefined, async function* () {
      yield { type: 'text', text: `About ${text}` }
    })
  }

  function workspace() {
    const ws = new Workspace()
    ws.titleApi = async () => null
    ws.registerApi = { note: async () => {}, forget: async () => {} }
    const forgotten: string[] = []
    ws.forgetDeck = async (id) => void forgotten.push(id)
    return { ws, forgotten }
  }

  it('makes cards from a picked spot with its images, and the topic around it', async () => {
    const { ws } = workspace()
    const doc = ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    topic.scope = ' Exam in December '
    ws.instructions = 'Use SI units.'
    const context: PageContext = { docId: doc.id, docName: 'notes.pdf', page: 4, selection: 'A theorem', pageTexts: [] }
    const rendered = Promise.resolve({ ...context, pageImage: 'AAAA', pageTexts: [{ page: 4, text: 'A theorem.' }] })
    const request = await ws.flashcardRequest(topic.id, { kind: 'pick', context, ready: rendered })
    expect(request).toMatchObject({
      topic: topic.name,
      topic_id: topic.id,
      scope: 'Exam in December',
      instructions: 'Use SI units.',
      context: { page: 4, selection: 'A theorem', page_image: 'AAAA' },
    })
    expect(request).not.toHaveProperty('messages')
  })

  it('makes cards from a discussion up to the answer picked, without images', async () => {
    const { ws } = workspace()
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    await talked(ws, topic.id, 'one')
    await talked(ws, topic.id, 'two')
    const chat = chatOf(topic)
    const request = flashcardRequest(topic, { kind: 'chat', chatId: chat.id, messageId: chat.messages[1].id })
    expect(request?.chat_id).toBe(chat.id)
    expect((request?.messages as { text: string }[]).map((m) => m.text)).toEqual(['one', 'About one'])
    expect(flashcardRequest(topic, { kind: 'chat', chatId: chat.id, messageId: 'gone' })).toBeUndefined()
  })

  it('deletes a deleted topic’s deck', () => {
    const { ws, forgotten } = workspace()
    ws.addDoc('notes.pdf', bytes(1))
    const topic = ws.activeTopic!
    ws.deleteTopic(topic.id)
    expect(forgotten).toEqual([topic.id])
  })
})
