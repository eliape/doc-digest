import { describe, expect, it } from 'vitest'
import { contextLabel, cropRegion, joinText, sectionFor, textInRegion, truncate, windowSlices } from './context'

describe('cropRegion', () => {
  it('centres a wide close-up on a clicked spot', () => {
    const region = cropRegion({ page: 1, point: { x: 0.5, y: 0.5 } })
    expect(region.width).toBeCloseTo(0.7)
    expect(region.x).toBeCloseTo(0.15)
    expect(region.y).toBeCloseTo(0.35)
  })

  it('stays on the page near its edges', () => {
    const region = cropRegion({ page: 1, point: { x: 0.98, y: 0.02 } })
    expect(region.x + region.width).toBeCloseTo(1)
    expect(region.y).toBe(0)
  })

  it('frames a selection with a margin', () => {
    const box = { x: 0.1, y: 0.4, width: 0.8, height: 0.1 }
    const region = cropRegion({ page: 1, box })
    expect(region.x).toBeLessThanOrEqual(box.x)
    expect(region.x + region.width).toBeGreaterThanOrEqual(box.x + box.width)
    expect(region.y).toBeLessThan(box.y)
    expect(region.y + region.height).toBeGreaterThan(box.y + box.height)
  })
})

describe('page text', () => {
  const items = [
    { text: 'Title', x: 0.1, y: 0.05, eol: true },
    { text: 'f(x) = ', x: 0.2, y: 0.5, eol: false },
    { text: 'x²', x: 0.3, y: 0.5, eol: true },
    { text: 'Footer', x: 0.1, y: 0.95, eol: false },
  ]

  it('keeps the PDF line breaks', () => {
    expect(joinText(items)).toBe('Title\nf(x) = x²\nFooter')
  })

  it('takes the text inside the close-up', () => {
    expect(textInRegion(items, { x: 0, y: 0.4, width: 1, height: 0.2 })).toBe('f(x) = x²')
  })

  it('marks where long text was cut', () => {
    expect(truncate('abcdef', 3)).toBe('abc …')
    expect(truncate('abc', 3)).toBe('abc')
  })
})

describe('sectionFor', () => {
  const headings = [
    { title: '1 Limits', page: 1 },
    { title: '2 Derivatives', page: 10 },
    { title: '2.1 The chain rule', page: 14 },
  ]

  it('is the last heading that starts on or before the page', () => {
    expect(sectionFor(headings, 12)).toBe('2 Derivatives')
    expect(sectionFor(headings, 14)).toBe('2.1 The chain rule')
    expect(sectionFor([], 3)).toBeUndefined()
  })
})

describe('contextLabel', () => {
  it('uses the printed page number when the PDF has one', () => {
    expect(contextLabel({ page: 15, pageLabel: 'xii' })).toBe('p. xii')
    expect(contextLabel({ page: 15 })).toBe('p. 15')
  })
})

describe('windowSlices', () => {
  const close = (slices: ReturnType<typeof windowSlices>) =>
    slices.map((s) => ({ page: s.page, from: +s.from.toFixed(2), to: +s.to.toFixed(2) }))

  it('centres a band 80% of a page tall on the spot', () => {
    expect(close(windowSlices(5, 0.5, 10))).toEqual([{ page: 5, from: 0.1, to: 0.9 }])
  })

  it('runs into the previous page near the top', () => {
    expect(close(windowSlices(5, 0.1, 10))).toEqual([
      { page: 4, from: 0.7, to: 1 },
      { page: 5, from: 0, to: 0.5 },
    ])
  })

  it('runs into the next page near the bottom', () => {
    expect(close(windowSlices(5, 0.95, 10))).toEqual([
      { page: 5, from: 0.55, to: 1 },
      { page: 6, from: 0, to: 0.35 },
    ])
  })

  it('stays inside the document on its first and last page', () => {
    expect(close(windowSlices(1, 0.1, 10))).toEqual([{ page: 1, from: 0, to: 0.8 }])
    expect(close(windowSlices(10, 0.95, 10))).toEqual([{ page: 10, from: 0.2, to: 1 }])
  })
})
