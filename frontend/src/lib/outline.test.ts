import { describe, expect, it } from 'vitest'
import { currentEntry, fromIndex } from './outline'

describe('fromIndex', () => {
  it('keeps titled sections and clamps their levels', () => {
    expect(
      fromIndex([
        { title: ' 1 Limits ', level: 1, start_page: 1 },
        { title: '', level: 2, start_page: 3 },
        { title: '1.1.1.1 Deep', level: 5, start_page: 4 },
      ]),
    ).toEqual([
      { title: '1 Limits', page: 1, level: 1 },
      { title: '1.1.1.1 Deep', page: 4, level: 3 },
    ])
  })
})

describe('currentEntry', () => {
  const entries = [
    { title: '1', page: 1, level: 1 },
    { title: '2', page: 10, level: 1 },
    { title: '2.1', page: 10, level: 2 },
    { title: '2.2', page: 14, level: 2 },
    { title: '2.3', page: 14, level: 2 },
  ]

  it('is the deepest entry starting on or before the page', () => {
    expect(currentEntry(entries, { page: 12, y: 0.5 })).toBe(2)
    expect(currentEntry(entries, { page: 1, y: 0 })).toBe(0)
  })

  it("switches at a heading's spot on the page", () => {
    const spots = [undefined, undefined, undefined, 0.2, 0.6]
    expect(currentEntry(entries, { page: 14, y: 0.1 }, spots)).toBe(2)
    expect(currentEntry(entries, { page: 14, y: 0.3 }, spots)).toBe(3)
    expect(currentEntry(entries, { page: 14, y: 0.7 }, spots)).toBe(4)
  })

  it('is -1 before the first entry', () => {
    expect(currentEntry([{ title: 'x', page: 5, level: 1 }], { page: 2, y: 0.9 })).toBe(-1)
  })
})

describe('fromIndex positions', () => {
  it('keeps a heading position the index found', () => {
    expect(fromIndex([{ title: 'A', level: 1, start_page: 2, top: 0.4 }])).toEqual([
      { title: 'A', page: 2, level: 1, top: 0.4 },
    ])
  })
})
