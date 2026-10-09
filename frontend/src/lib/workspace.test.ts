import { describe, expect, it } from 'vitest'
import { Workspace, topicNameFor } from './workspace.svelte'

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
})
