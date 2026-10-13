/** How long the pointer rests on a name before a cut-off name starts to scroll. */
export const MARQUEE_DELAY_MS = 600
/** Scrolling speed, in pixels per second: slow enough to read along. */
const SPEED = 40
/** The pause at the end of the name. */
const PAUSE_MS = 500
/** The pause back at its start before it scrolls again: twice as long. */
const START_PAUSE_MS = 2 * PAUSE_MS

/**
 * A name cut off with an ellipsis scrolls left to show the rest while its row is hovered: after a
 * short wait it moves to the end, rests there, goes back to the start and loops. Put it on the
 * element that clips the name, around one inline element holding the text; its row is the
 * element whose hover starts it.
 */
export function marquee(node: HTMLElement, row: () => HTMLElement | null = () => node.parentElement) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let animation: Animation | undefined

  function start() {
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    const distance = node.scrollWidth - node.clientWidth
    if (reduced || distance <= 0 || typeof node.animate !== 'function') return
    const inner = node.firstElementChild as HTMLElement | null
    if (!inner) return
    // While it scrolls the text moves as a block, without the ellipsis.
    node.classList.add('scrolling')
    const move = (distance / SPEED) * 1000
    // It goes back as slowly as it came.
    const total = move + PAUSE_MS + move + START_PAUSE_MS
    animation = inner.animate(
      [
        { transform: 'translateX(0)', offset: 0 },
        { transform: `translateX(${-distance}px)`, offset: move / total },
        { transform: `translateX(${-distance}px)`, offset: (move + PAUSE_MS) / total },
        { transform: 'translateX(0)', offset: (move + PAUSE_MS + move) / total },
        { transform: 'translateX(0)', offset: 1 },
      ],
      { duration: total, iterations: Infinity, easing: 'linear' },
    )
  }

  function stop() {
    clearTimeout(timer)
    timer = undefined
    animation?.cancel()
    animation = undefined
    node.classList.remove('scrolling')
  }

  const enter = () => {
    stop()
    timer = setTimeout(start, MARQUEE_DELAY_MS)
  }

  const target = row() ?? node
  target.addEventListener('pointerenter', enter)
  target.addEventListener('pointerleave', stop)
  return {
    destroy() {
      stop()
      target.removeEventListener('pointerenter', enter)
      target.removeEventListener('pointerleave', stop)
    },
  }
}
