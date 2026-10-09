import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachZoomGestures, wheelZoomFactor } from './gestures'

describe('wheelZoomFactor', () => {
  it('zooms in for a negative delta and out for a positive one', () => {
    expect(wheelZoomFactor({ deltaY: -3, deltaMode: 0 })).toBeGreaterThan(1)
    expect(wheelZoomFactor({ deltaY: 3, deltaMode: 0 })).toBeLessThan(1)
  })

  it('zooms about 10% for one mouse wheel notch, whatever its size', () => {
    for (const deltaY of [100, 120, 400]) {
      expect(wheelZoomFactor({ deltaY, deltaMode: 0 })).toBeCloseTo(1 / 1.105, 2)
    }
    expect(wheelZoomFactor({ deltaY: 3, deltaMode: 1 })).toBeCloseTo(1 / 1.105, 2)
  })

  it('keeps small pinch deltas small', () => {
    expect(wheelZoomFactor({ deltaY: -2, deltaMode: 0 })).toBeCloseTo(1.02, 2)
  })
})

describe('attachZoomGestures', () => {
  let detach: (() => void) | undefined
  afterEach(() => detach?.())

  function setup() {
    const el = document.createElement('div')
    const zoom = vi.fn()
    detach = attachZoomGestures(el, zoom)
    return { el, zoom }
  }

  it('zooms on ctrl+wheel around the pointer and stops the browser zooming the page', () => {
    const { el, zoom } = setup()
    const event = new WheelEvent('wheel', { deltaY: -4, ctrlKey: true, clientX: 30, clientY: 40, cancelable: true })
    el.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(zoom).toHaveBeenCalledOnce()
    expect(zoom.mock.calls[0][0]).toBeGreaterThan(1)
    expect(zoom.mock.calls[0][1]).toEqual([30, 40])
  })

  it('leaves plain scrolling alone', () => {
    const { el, zoom } = setup()
    const event = new WheelEvent('wheel', { deltaY: 50, cancelable: true })
    el.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(zoom).not.toHaveBeenCalled()
  })

  it('zooms by how far two fingers move apart or together', () => {
    const { el, zoom } = setup()
    const touches = (x1: number, x2: number) => ({ touches: [{ clientX: x1, clientY: 10 }, { clientX: x2, clientY: 10 }] })
    const fire = (type: string, init: object) => {
      const event = Object.assign(new Event(type, { cancelable: true }), init)
      el.dispatchEvent(event)
      return event
    }
    fire('touchstart', touches(100, 200))
    const move = fire('touchmove', touches(80, 220))
    expect(move.defaultPrevented).toBe(true)
    expect(zoom).toHaveBeenCalledWith(1.4, [150, 10])
    fire('touchmove', touches(100, 200))
    expect(zoom.mock.calls[1][0]).toBeCloseTo(100 / 140)
  })

  it('ignores one-finger touches so scrolling works', () => {
    const { el, zoom } = setup()
    const event = Object.assign(new Event('touchmove', { cancelable: true }), { touches: [{ clientX: 1, clientY: 1 }] })
    el.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(zoom).not.toHaveBeenCalled()
  })

  it('stops listening once detached', () => {
    const { el, zoom } = setup()
    detach?.()
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -4, ctrlKey: true }))
    expect(zoom).not.toHaveBeenCalled()
  })
})
