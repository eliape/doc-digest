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
  ]

  it('is the deepest entry starting on or before the page', () => {
    expect(currentEntry(entries, 12)).toBe(2)
    expect(currentEntry(entries, 20)).toBe(3)
    expect(currentEntry(entries, 1)).toBe(0)
  })

  it('is -1 before the first entry', () => {
    expect(currentEntry([{ title: 'x', page: 5, level: 1 }], 2)).toBe(-1)
  })
})
