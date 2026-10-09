<script lang="ts" module>
  /**
   * One thing the menu offers, with a short line under it and an icon (an SVG path on a
   * 24 by 24 grid). A disabled item shows but does nothing. `divider` draws a line above it,
   * to set it apart from the items before.
   */
  export type MenuItem = {
    label: string
    hint?: string
    icon?: string
    disabled?: boolean
    divider?: boolean
    onselect?: () => void
  }
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
  class="popup-menu menu"
  role="menu"
  tabindex="-1"
  aria-label={label}
  style:left={`${left ?? x}px`}
  style:top={`${top ?? y}px`}
  bind:this={menu}
  {onkeydown}
>
  {#each items as item (item.label)}
    {#if item.divider}<div class="divider" role="separator"></div>{/if}
    <!-- Disabled items stay focusable, so the arrow keys and screen readers still reach them. -->
    <button type="button" role="menuitem" aria-disabled={item.disabled || undefined} onclick={() => select(item)}>
      {#if item.icon}<svg viewBox="0 0 24 24" aria-hidden="true"><path d={item.icon} /></svg>{/if}
      <span class="text">
        <span>{item.label}</span>
        {#if item.hint}<span class="hint">{item.hint}</span>{/if}
      </span>
    </button>
  {/each}
</div>

<style>
  /* The shared popup menu (app.css), but over everything (the sidebar and the chat too), as the browser's would be. */
  .menu {
    position: fixed;
    z-index: 50;
    min-width: 12rem;
  }

  /* Rows have a hint under the label, with the icon level with the label. */
  .menu > button {
    align-items: flex-start;
    line-height: 1.3;
    white-space: normal;
  }
  .menu > button[aria-disabled='true'] {
    color: var(--muted);
    cursor: default;
  }
  .menu svg {
    margin-top: 0.1rem;
  }

  .divider {
    height: 1px;
    margin: 0.25rem 0.375rem;
    background: var(--border);
  }

  .text {
    display: flex;
    flex-direction: column;
  }
  .hint {
    color: var(--muted);
    font-size: 0.75rem;
  }
</style>
