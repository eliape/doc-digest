import { describe, expect, it } from 'vitest'
import { boxOnPage, isBlank, isClick, isOnSelection, pointOnPage } from './picking'

const page = { left: 100, top: 50, width: 400, height: 600 }

describe('picking', () => {
  it('counts a press and release a few pixels apart as a click, not a drag', () => {
    expect(isClick({ x: 10, y: 10 }, { x: 12, y: 13 })).toBe(true)
    expect(isClick({ x: 10, y: 10 }, { x: 30, y: 10 })).toBe(false)
  })

  it('turns a point in the window into a spot on the page', () => {
    expect(pointOnPage(page, 300, 200)).toEqual({ x: 0.5, y: 0.25 })
    expect(pointOnPage(page, 50, 200)).toBeUndefined()
  })

  it('covers all of a selection’s lines, clipped to the page', () => {
    const box = boxOnPage(page, [
      { left: 140, top: 110, width: 200, height: 20 },
      { left: 120, top: 130, width: 600, height: 20 },
      { left: 0, top: 0, width: 0, height: 0 },
    ])
    expect(box?.x).toBeCloseTo(0.05)
    expect(box?.y).toBeCloseTo(0.1)
    expect(box && box.x + box.width).toBeCloseTo(1)
    expect(box && box.y + box.height).toBeCloseTo(100 / 600)
    expect(boxOnPage(page, [])).toBeUndefined()
  })

  it('tells whether a right-click is on the selected text', () => {
    const rect = { left: 100, top: 50, right: 300, bottom: 70 }
    const selection = (isCollapsed: boolean) =>
      ({ isCollapsed, rangeCount: 1, getRangeAt: () => ({ getClientRects: () => [rect] }) }) as unknown as Selection
    expect(isOnSelection(selection(false), 150, 60)).toBe(true)
    expect(isOnSelection(selection(false), 150, 90)).toBe(false)
    expect(isOnSelection(selection(true), 150, 60)).toBe(false)
    expect(isOnSelection(null, 150, 60)).toBe(false)
  })

  it('treats near-white pixels as blank', () => {
    expect(isBlank(new Uint8ClampedArray([255, 255, 255, 255, 240, 245, 250, 255]))).toBe(true)
    expect(isBlank(new Uint8ClampedArray([255, 255, 255, 255, 20, 20, 20, 255]))).toBe(false)
    // Transparent pixels (nothing drawn yet) count as blank.
    expect(isBlank(new Uint8ClampedArray([0, 0, 0, 0]))).toBe(true)
  })
})
