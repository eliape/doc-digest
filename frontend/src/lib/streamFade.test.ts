import { describe, expect, it } from 'vitest'
import { streamFade } from './streamFade'

describe('streamFade', () => {
  it('fades in only the text that streams onto the end', () => {
    const node = document.createElement('div')
    const action = streamFade(node, { html: '<p>Hello</p>', live: true })
    expect(node.querySelector('.fresh')?.textContent).toBe('Hello')
    action.update({ html: '<p>Hello <strong>world</strong></p>', live: true })
    expect(node.textContent).toBe('Hello world')
    // Both pieces are still fading, each in its own span.
    expect([...node.querySelectorAll('.fresh')].map((s) => s.textContent)).toEqual(['Hello', ' ', 'world'])
    action.update({ html: '<p>Hello <strong>world</strong></p>', live: false })
    expect(node.innerHTML).toContain('<strong>')
  })

  it('does not fade an answer that was already there', () => {
    const node = document.createElement('div')
    streamFade(node, { html: '<p>Done</p>', live: false })
    expect(node.querySelector('.fresh')).toBeNull()
    expect(node.innerHTML).toBe('<p>Done</p>')
  })
})
