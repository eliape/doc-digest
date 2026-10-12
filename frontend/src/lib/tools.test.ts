import { afterEach, describe, expect, it, vi } from 'vitest'
import { savedTool, saveTool } from './tools'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('savedTool', () => {
  it('starts on Select and remembers each topic its own tool', () => {
    expect(savedTool('a')).toBe('select')
    saveTool('a', 'ask', ['a', 'b'])
    expect(savedTool('a')).toBe('ask')
    saveTool('b', 'select', ['a', 'b'])
    expect(savedTool('b')).toBe('select')
    expect(savedTool('a')).toBe('ask')
  })

  it('starts a topic without its own on the tool picked last', () => {
    saveTool('a', 'ask')
    expect(savedTool('new')).toBe('ask')
  })

  it('forgets the tools of deleted topics', () => {
    saveTool('a', 'ask', ['a', 'b'])
    saveTool('b', 'select', ['b'])
    expect(JSON.parse(localStorage.getItem('doc-digest.topic-tools')!)).toEqual({ b: 'select' })
  })

  it('falls back to Select for an unknown value or when storage is unavailable', () => {
    localStorage.setItem('doc-digest.tool', 'lasso')
    localStorage.setItem('doc-digest.topic-tools', '{"a": "lasso"}')
    expect(savedTool('a')).toBe('select')
    localStorage.setItem('doc-digest.topic-tools', 'not json')
    expect(savedTool('a')).toBe('select')
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(savedTool('a')).toBe('select')
    expect(() => saveTool('a', 'ask')).not.toThrow()
  })
})
