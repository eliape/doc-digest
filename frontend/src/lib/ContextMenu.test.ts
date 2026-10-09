import { fireEvent, render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import ContextMenu from './ContextMenu.svelte'

function setup() {
  const onclose = vi.fn()
  const socratic = vi.fn()
  const quiz = vi.fn()
  render(ContextMenu, {
    x: 40,
    y: 60,
    label: 'Study this',
    onclose,
    items: [
      { label: 'Quiz me', hint: 'Coming soon', disabled: true, onselect: quiz },
      { label: 'Socratic', hint: 'Work it out by answering questions', onselect: socratic },
    ],
  })
  const menu = screen.getByRole('menu', { name: 'Study this' })
  const item = (name: RegExp) => screen.getByRole('menuitem', { name })
  return { onclose, socratic, quiz, menu, item }
}

describe('ContextMenu', () => {
  it('opens where the reader right-clicked, with the first item it can do focused', async () => {
    const { menu, item } = setup()
    expect(menu.style.left).toBe('40px')
    expect(menu.style.top).toBe('60px')
    await Promise.resolve()
    expect(item(/^Socratic/)).toHaveFocus()
    expect(item(/^Quiz me/)).toHaveAttribute('aria-disabled', 'true')
    expect(item(/^Quiz me/)).toHaveTextContent('Coming soon')
  })

  it('does an item and closes, but a disabled item does nothing', async () => {
    const { onclose, socratic, quiz, item } = setup()
    await fireEvent.click(item(/^Quiz me/))
    expect(quiz).not.toHaveBeenCalled()
    expect(onclose).not.toHaveBeenCalled()
    await fireEvent.click(item(/^Socratic/))
    expect(socratic).toHaveBeenCalledOnce()
    expect(onclose).toHaveBeenCalledOnce()
  })

  it('moves between items with the arrow keys and closes with Escape', async () => {
    const { onclose, menu, item } = setup()
    await Promise.resolve()
    await fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(item(/^Quiz me/)).toHaveFocus()
    await fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(item(/^Socratic/)).toHaveFocus()
    await fireEvent.keyDown(menu, { key: 'Escape' })
    expect(onclose).toHaveBeenCalledOnce()
  })

  it('closes on a click elsewhere, which then does nothing else', async () => {
    const { onclose } = setup()
    const elsewhere = document.createElement('div')
    const pressed = vi.fn()
    elsewhere.addEventListener('pointerdown', pressed)
    document.body.appendChild(elsewhere)
    await fireEvent.pointerDown(elsewhere, { button: 0 })
    expect(onclose).toHaveBeenCalledOnce()
    expect(pressed).not.toHaveBeenCalled()
    elsewhere.remove()
  })
})
