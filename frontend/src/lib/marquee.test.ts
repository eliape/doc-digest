import { afterEach, describe, expect, it, vi } from 'vitest'
import { MARQUEE_DELAY_MS, marquee } from './marquee'

function row(scrollWidth: number, clientWidth: number) {
  const button = document.createElement('button')
  const name = document.createElement('span')
  name.append(document.createElement('span'))
  button.append(name)
  Object.defineProperty(name, 'scrollWidth', { value: scrollWidth })
  Object.defineProperty(name, 'clientWidth', { value: clientWidth })
  return { button, name }
}

describe('marquee', () => {
  afterEach(() => vi.useRealTimers())

  it('scrolls a cut-off name only after the pointer rests on its row, and stops on leaving', () => {
    vi.useFakeTimers()
    const { button, name } = row(300, 200)
    const action = marquee(name)
    button.dispatchEvent(new Event('pointerenter'))
    vi.advanceTimersByTime(MARQUEE_DELAY_MS - 1)
    expect(name).not.toHaveClass('scrolling')
    vi.advanceTimersByTime(1)
    expect(name).toHaveClass('scrolling')
    button.dispatchEvent(new Event('pointerleave'))
    expect(name).not.toHaveClass('scrolling')
    action.destroy()
  })

  it('leaves a name that fits alone', () => {
    vi.useFakeTimers()
    const { button, name } = row(200, 200)
    marquee(name)
    button.dispatchEvent(new Event('pointerenter'))
    vi.advanceTimersByTime(MARQUEE_DELAY_MS)
    expect(name).not.toHaveClass('scrolling')
  })
})
