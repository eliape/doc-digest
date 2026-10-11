import type { IndexSection } from './api'
import type { Heading } from './context'

/** The index's sections as outline entries, the deepest level kept to three. */
export function fromIndex(sections: IndexSection[]): Heading[] {
  return sections
    .filter((s) => s.title.trim())
    .map((s) => ({ title: s.title.trim(), page: s.start_page, level: Math.min(Math.max(s.level, 1), 3) }))
}

/** The entry for the section a page is in: the last one that starts on or before it. */
export function currentEntry(entries: Heading[], page: number): number {
  let best = -1
  entries.forEach((entry, i) => {
    if (entry.page <= page && (best < 0 || entry.page >= entries[best].page)) best = i
  })
  return best
}
