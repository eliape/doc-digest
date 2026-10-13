import { beforeEach, describe, expect, it } from 'vitest'
import { applyTheme, savedTheme } from './theme'

describe('theme', () => {
  beforeEach(() => localStorage.clear())

  it('follows the system until another is picked, and remembers the pick', () => {
    const root = document.createElement('html')
    expect(savedTheme()).toBe('system')
    applyTheme('dark', root)
    expect(root.dataset.theme).toBe('dark')
    expect(savedTheme()).toBe('dark')
    applyTheme('system', root)
    expect(root.dataset.theme).toBeUndefined()
    expect(savedTheme()).toBe('system')
  })
})
