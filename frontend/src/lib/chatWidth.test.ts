import { afterEach, describe, expect, it } from 'vitest'
import { chatReserve, DEFAULT_WIDTH, WIDTH_KEY } from './chatWidth'

const setWindow = (width: number) => Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })

describe('chatReserve', () => {
  afterEach(() => {
    localStorage.clear()
    setWindow(1024)
  })

  it('is the default chat width in a wide window', () => {
    setWindow(1400)
    expect(chatReserve()).toBe(DEFAULT_WIDTH)
  })

  it('follows a width the reader dragged the chat to', () => {
    setWindow(1400)
    localStorage.setItem(WIDTH_KEY, '500')
    expect(chatReserve()).toBe(500)
  })

  it('is zero when the chat floats over the PDF in a narrow window', () => {
    setWindow(600)
    expect(chatReserve()).toBe(0)
  })
})
