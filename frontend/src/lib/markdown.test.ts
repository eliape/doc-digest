import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

const html = (source: string) => {
  const div = document.createElement('div')
  div.innerHTML = renderMarkdown(source)
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
})
