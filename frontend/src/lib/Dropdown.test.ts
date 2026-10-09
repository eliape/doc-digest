import { fireEvent, render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import Dropdown from './Dropdown.svelte'

function setup() {
  const onchange = vi.fn()
  render(Dropdown, {
    label: 'Mode',
    value: 'normal',
    onchange,
    options: [
      { value: 'normal', label: 'Normal' },
      { value: 'socratic', label: 'Socratic' },
    ],
  })
  return { onchange, trigger: screen.getByRole('button', { name: 'Mode: Normal' }) }
}

describe('Dropdown', () => {
  it('opens from the keyboard on the current choice and picks with the arrow keys', async () => {
    const { onchange, trigger } = setup()
    await fireEvent.keyDown(trigger, { key: 'ArrowUp' })
    const [normal, socratic] = await screen.findAllByRole('menuitemradio')
    expect(normal).toHaveFocus()
    await fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    expect(socratic).toHaveFocus()
    await fireEvent.click(socratic)
    expect(onchange).toHaveBeenCalledWith('socratic')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes on a press elsewhere, and does not report picking the current choice', async () => {
    const { onchange, trigger } = setup()
    await fireEvent.click(trigger)
    await fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    await fireEvent.click(trigger)
    await fireEvent.click(screen.getByRole('menuitemradio', { name: 'Normal' }))
    expect(onchange).not.toHaveBeenCalled()
  })
})
