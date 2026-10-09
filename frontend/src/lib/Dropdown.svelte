<script lang="ts" module>
  /** One choice in a dropdown: its label, a tooltip, and optionally an icon (an SVG path on a 24 by 24 grid). */
  export type Option<T extends string> = { value: T; label: string; title?: string; icon?: string }
</script>

<script lang="ts" generics="T extends string">
  import { tick } from 'svelte'

  type Props = {
    /** What is being chosen, e.g. "Model". Screen readers hear it with the current choice. */
    label: string
    value: T
    options: Option<T>[]
    onchange: (value: T) => void
    /** Which edge of the button the menu lines up with. It always opens upwards. */
    align?: 'left' | 'right'
  }

  let { label, value, options, onchange, align = 'left' }: Props = $props()

  let open = $state(false)
  let root = $state<HTMLElement>()
  let trigger = $state<HTMLButtonElement>()
  let current = $derived(options.find((o) => o.value === value))

  const items = () => Array.from(root?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])

  /** Open the menu with the current choice focused, so the arrow keys start from it. */
  async function show() {
    open = true
    await tick()
    const els = items()
    els[Math.max(0, options.findIndex((o) => o.value === value))]?.focus()
  }

  function hide(refocus = true) {
    open = false
    if (refocus) trigger?.focus()
  }

  function choose(option: Option<T>) {
    hide()
    if (option.value !== value) onchange(option.value)
  }

  // A press anywhere else closes the menu.
  $effect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!root?.contains(event.target as Node)) hide(false)
    }
    window.addEventListener('pointerdown', outside, true)
    return () => window.removeEventListener('pointerdown', outside, true)
  })

  function onTriggerKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    show()
  }

  function onMenuKeydown(event: KeyboardEvent) {
    const els = items()
    const i = els.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'ArrowDown') els[(i + 1) % els.length]?.focus()
    else if (event.key === 'ArrowUp') els[(i - 1 + els.length) % els.length]?.focus()
    else if (event.key === 'Home') els[0]?.focus()
    else if (event.key === 'End') els.at(-1)?.focus()
    else if (event.key === 'Escape') hide()
    else if (event.key === 'Tab') hide(false)
    else return
    // Escape only closes this menu, not the chat around it.
    if (event.key !== 'Tab') event.preventDefault()
    event.stopPropagation()
  }
</script>

<div class="dropdown" bind:this={root}>
  <button
    type="button"
    class="trigger"
    bind:this={trigger}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={`${label}: ${current?.label ?? value}`}
    title={current?.title}
    onclick={() => (open ? hide() : show())}
    onkeydown={onTriggerKeydown}
  >
    {#if current?.icon}<svg viewBox="0 0 24 24" aria-hidden="true"><path d={current.icon} /></svg>{/if}
    <span>{current?.label ?? value}</span>
    <svg class="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
  </button>
  {#if open}
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div class="popup-menu" class:right={align === 'right'} role="menu" aria-label={label} onkeydown={onMenuKeydown}>
      {#each options as option (option.value)}
        <button
          type="button"
          role="menuitemradio"
          aria-checked={option.value === value}
          title={option.title}
          onclick={() => choose(option)}
        >
          {#if option.icon}<svg viewBox="0 0 24 24" aria-hidden="true"><path d={option.icon} /></svg>{/if}
          {option.label}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .dropdown {
    position: relative;
  }

  /* No frame, a hover shade and a small chevron, like the PDF's zoom menu. */
  .trigger {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.15rem 0.35rem 0.15rem 0.4rem;
    border: none;
    border-radius: 0.375rem;
    background: none;
    color: var(--dropdown-color, var(--muted));
    font: inherit;
    font-size: 0.75rem;
    line-height: 1.2;
    cursor: pointer;
  }
  .trigger:hover,
  .trigger[aria-expanded='true'] {
    background: var(--hover);
    color: var(--dropdown-color, inherit);
  }
  .trigger:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .trigger svg {
    flex-shrink: 0;
    width: 0.85rem;
    height: 0.85rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .trigger .chevron {
    width: 0.75rem;
    height: 0.75rem;
    stroke-width: 1.6;
  }

  /* Opens upwards: the dropdowns sit at the bottom of the chat. */
  .popup-menu {
    position: absolute;
    bottom: calc(100% + 0.25rem);
    left: 0;
    z-index: 5;
  }
  .popup-menu.right {
    left: auto;
    right: 0;
  }
  .popup-menu [aria-checked='true'] {
    font-weight: 600;
  }
</style>
