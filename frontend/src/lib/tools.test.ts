import { afterEach, describe, expect, it, vi } from 'vitest'
import { savedTool, saveTool } from './tools'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('savedTool', () => {
  it('starts on Select and remembers the last pick', () => {
    expect(savedTool()).toBe('select')
    saveTool('ask')
    expect(savedTool()).toBe('ask')
    saveTool('select')
    expect(savedTool()).toBe('select')
  })

  it('falls back to Select for an unknown value or when storage is unavailable', () => {
    localStorage.setItem('doc-digest.tool', 'lasso')
    expect(savedTool()).toBe('select')
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(savedTool()).toBe('select')
    expect(() => saveTool('ask')).not.toThrow()
  })
})
