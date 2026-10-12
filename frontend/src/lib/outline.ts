import type { IndexSection } from './api'
import type { Heading } from './context'

/** The index's sections as outline entries, the deepest level kept to three. */
export function fromIndex(sections: IndexSection[]): Heading[] {
  return sections
    .filter((s) => s.title.trim())
    .map((s) => ({
      title: s.title.trim(),
      page: s.start_page,
      level: Math.min(Math.max(s.level, 1), 3),
      ...(typeof s.top === 'number' && { top: Math.min(Math.max(s.top, 0), 1) }),
    }))
}

/** Where the reader is: a page, and how far down it (a fraction of its height). */
export type ReadingSpot = { page: number; y: number }

/**
 * The entry for the section being read: the last one that starts before the reading spot.
 * `spots` gives where each entry's heading is on its page, where known; one without a
 * known spot counts as starting at the top of its page.
 */
export function currentEntry(entries: Heading[], at: ReadingSpot, spots: (number | undefined)[] = []): number {
  let best = -1
  const starts = (i: number) => [entries[i].page, spots[i] ?? 0] as const
  entries.forEach((_, i) => {
    const [page, y] = starts(i)
    if (page > at.page || (page === at.page && y > at.y)) return
    if (best < 0) best = i
    else {
      const [bestPage, bestY] = starts(best)
      if (page > bestPage || (page === bestPage && y >= bestY)) best = i
    }
  })
  return best
}
