import { describe, expect, it } from 'vitest'
import { type CitableDocs, renderMarkdown } from './markdown'

const html = (source: string, docs?: CitableDocs) => {
  const div = document.createElement('div')
  div.innerHTML = renderMarkdown(source, docs)
  return div
}

describe('renderMarkdown', () => {
  it('renders Markdown', () => {
    const div = html('**Bold** and *italic*\n\n- one\n- two\n\n`code`')
    expect(div.querySelector('strong')).toHaveTextContent('Bold')
    expect(div.querySelector('em')).toHaveTextContent('italic')
    expect(div.querySelectorAll('li')).toHaveLength(2)
    expect(div.querySelector('code')).toHaveTextContent('code')
  })

  it('typesets inline and display maths', () => {
    const div = html('The mean is $\\mu = \\frac{1}{n}\\sum x_i$ and\n\n$$\\sigma^2 = E[(X-\\mu)^2]$$\n\nalso \\(a^2\\) and \\[b^2\\]')
    expect(div.querySelectorAll('.katex')).toHaveLength(4)
    expect(div.querySelectorAll('.math-display .katex-display')).toHaveLength(2)
    // The MathML copy is kept, so screen readers and copy-paste get the maths.
    expect(div.querySelector('math annotation')).toHaveTextContent('\\mu = \\frac{1}{n}\\sum x_i')
    expect(div.textContent).not.toContain('$')
  })

  it('leaves prices and maths inside code alone', () => {
    expect(html('It costs $5 and $10.').textContent?.trim()).toBe('It costs $5 and $10.')
    expect(html('Use `$x$` to write maths.').querySelector('code')).toHaveTextContent('$x$')
    expect(html('Use `$x$` to write maths.').querySelector('.katex')).toBeNull()
  })

  it('shows broken or half-streamed LaTeX as text instead of failing', () => {
    expect(() => html('$\\frac{1}{$')).not.toThrow()
    expect(html('Half an answer: $\\frac{a}').textContent).toContain('$\\frac{a}')
  })

  it('strips scripts and event handlers, and opens links in a new tab', () => {
    const div = html('<img src=x onerror="alert(1)"><script>alert(2)</script>[link](https://example.com) [bad](javascript:alert(3))')
    expect(div.querySelector('script')).toBeNull()
    expect(div.querySelector('img')?.getAttribute('onerror')).toBeNull()
    const links = div.querySelectorAll('a')
    expect(links[0]).toHaveAttribute('target', '_blank')
    expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer')
    expect(links[1]?.getAttribute('href') ?? '').not.toContain('javascript')
  })

  const citations = (div: HTMLElement) =>
    [...div.querySelectorAll<HTMLAnchorElement>('a.citation')].map((c) => [
      c.textContent?.replace(/\u00a0/g, ' '),
      c.dataset.doc,
      c.dataset.page,
    ])

  it("turns citations of the topic's PDFs into links with the PDF and page", () => {
    const div = html(
      'See (book.pdf, p. 41) and **notes, pp. 3–5**; not other.pdf, p. 2, `book.pdf, p. 9` or lecture-notes, p. 7.',
      { names: ['book.pdf', 'notes.pdf'] },
    )
    expect(citations(div)).toEqual([
      ['book.pdf, p. 41', 'book.pdf', '41'],
      ['notes, pp. 3–5', 'notes.pdf', '3'],
    ])
    expect(div.textContent?.replace(/\u00a0/g, ' ')).toContain('See (book.pdf, p. 41) and notes, pp. 3–5; not other.pdf')
  })

  it('reads the other ways the model writes citations', () => {
    const docs = { names: ['book.pdf', 'notes.pdf'], aliases: { D1: 'book.pdf', D2: 'notes.pdf' }, current: 'notes.pdf' }
    const div = html(
      'As shown (p. 12) and (pp. 14–15), defined in (D1, p. 41), see (book.pdf p. 7), (book.pdf, page 8) and (notes.pdf, s. 9).',
      docs,
    )
    expect(citations(div)).toEqual([
      ['p. 12', 'notes.pdf', '12'],
      ['pp. 14–15', 'notes.pdf', '14'],
      // The alias means nothing to the reader, so the link shows the PDF's name.
      ['book.pdf, p. 41', 'book.pdf', '41'],
      ['book.pdf p. 7', 'book.pdf', '7'],
      ['book.pdf, page 8', 'book.pdf', '8'],
      ['notes.pdf, s. 9', 'notes.pdf', '9'],
    ])
    // A page outside parentheses, or with no PDF to point at, stays text.
    expect(citations(html('Turn to p. 12.', docs))).toEqual([])
    expect(citations(html('As shown (p. 12).', { names: ['book.pdf', 'notes.pdf'] }))).toEqual([])
  })

  it('leaves citations as text when no PDFs are given', () => {
    expect(html('See (book.pdf, p. 41).').querySelector('a')).toBeNull()
  })
})
