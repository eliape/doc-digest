<script lang="ts" module>
  /** One thing the menu offers, with a short line under it. A disabled item shows but does nothing. */
  export type MenuItem = { label: string; hint?: string; disabled?: boolean; onselect?: () => void }
</script>

<script lang="ts">
  type Props = {
    /** Where the menu opens, in window coordinates: where the reader right-clicked. */
    x: number
    y: number
    label: string
    items: MenuItem[]
    /** Called when the menu should go away: an item was picked, Escape, a click elsewhere, a scroll. */
    onclose: () => void
  }

  let { x, y, label, items, onclose }: Props = $props()

  let menu = $state<HTMLElement>()
  let left = $state<number>()
  let top = $state<number>()

  const MARGIN = 4

  const itemEls = () => Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])

  // Open at the pointer, moved in where it would stick out of the window, with the first item it can do focused.
  $effect(() => {
    if (!menu) return
    const { width, height } = menu.getBoundingClientRect()
    left = Math.max(MARGIN, Math.min(x, window.innerWidth - width - MARGIN))
    top = Math.max(MARGIN, Math.min(y, window.innerHeight - height - MARGIN))
    const els = itemEls()
    ;(els.find((el) => el.getAttribute('aria-disabled') !== 'true') ?? els[0])?.focus({ preventScroll: true })
  })

  $effect(() => {
    const outside = (event: PointerEvent) => {
      if (menu?.contains(event.target as Node)) return
      // A click that only closes the menu does nothing else, such as attaching a spot.
      if (event.button === 0) event.stopPropagation()
      onclose()
    }
    const close = () => onclose()
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  })

  function onkeydown(event: KeyboardEvent) {
    const els = itemEls()
    const i = els.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'ArrowDown') els[(i + 1) % els.length]?.focus()
    else if (event.key === 'ArrowUp') els[(i - 1 + els.length) % els.length]?.focus()
    else if (event.key === 'Home') els[0]?.focus()
    else if (event.key === 'End') els.at(-1)?.focus()
    else if (event.key === 'Escape' || event.key === 'Tab') onclose()
    else return
    event.preventDefault()
  }

  function select(item: MenuItem) {
    if (item.disabled) return
    onclose()
    item.onselect?.()
  }
</script>

<div
  class="menu"
  role="menu"
  tabindex="-1"
  aria-label={label}
  style:left={`${left ?? x}px`}
  style:top={`${top ?? y}px`}
  bind:this={menu}
  {onkeydown}
>
  {#each items as item (item.label)}
    <!-- Disabled items stay focusable, so the arrow keys and screen readers still reach them. -->
    <button type="button" role="menuitem" aria-disabled={item.disabled || undefined} onclick={() => select(item)}>
      <span class="label">{item.label}</span>
      {#if item.hint}<span class="hint">{item.hint}</span>{/if}
    </button>
  {/each}
</div>

<style>
  /* Over everything, the sidebar and the chat included, like the browser's own menu. */
  .menu {
    position: fixed;
    z-index: 50;
    display: flex;
    flex-direction: column;
    min-width: 12rem;
    padding: 0.25rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--surface);
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.18);
    outline: none;
  }

  button {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 0.375rem 0.625rem;
    border: none;
    border-radius: var(--radius);
    background: none;
    color: inherit;
    font: inherit;
    font-size: 0.9rem;
    line-height: 1.3;
    text-align: left;
    cursor: pointer;
    outline: none;
  }
  button:hover:not([aria-disabled='true']),
  button:focus-visible,
  button:focus {
    background: var(--hover);
  }
  button[aria-disabled='true'] {
    color: var(--muted);
    cursor: default;
  }

  .hint {
    color: var(--muted);
    font-size: 0.75rem;
  }
</style>
