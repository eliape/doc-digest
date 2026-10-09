/** Where a zoom is centred, in client (viewport) coordinates. */
export type Origin = [x: number, y: number]

/** Called with how much to scale by (1.1 = 10% bigger) around an origin. */
export type ZoomHandler = (factor: number, origin: Origin) => void

const PIXELS_PER_LINE = 16
// A mouse wheel notch reports about 100 pixels, a trackpad pinch only a few.
// Capping each event makes a notch zoom by roughly 10%, like Mozilla's viewer,
// without changing how pinches feel.
const MAX_WHEEL_DELTA = 10
const WHEEL_SENSITIVITY = 0.01

/** How much one ctrl+wheel event (which is how browsers report a trackpad pinch) should zoom. */
export function wheelZoomFactor(event: { deltaY: number; deltaMode: number }): number {
  const pixels = event.deltaMode === 1 ? event.deltaY * PIXELS_PER_LINE : event.deltaY
  const capped = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, pixels))
  return Math.exp(-capped * WHEEL_SENSITIVITY)
}

function distance(a: Touch, b: Touch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

/**
 * Zoom gestures like Mozilla's PDF viewer:
 * - ctrl/cmd + wheel, and a trackpad pinch in Chrome and Firefox (both arrive as ctrl+wheel);
 * - a trackpad or touch pinch in Safari (gesture events);
 * - a two-finger pinch on touch screens elsewhere.
 *
 * Returns a function that removes the listeners.
 */
export function attachZoomGestures(el: HTMLElement, zoom: ZoomHandler): () => void {
  const cleanups: Array<() => void> = []
  const on = <K extends string>(type: K, handler: (event: any) => void) => {
    // Not passive: the browser must not also zoom the whole page.
    el.addEventListener(type, handler, { passive: false })
    cleanups.push(() => el.removeEventListener(type, handler))
  }

  on('wheel', (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    zoom(wheelZoomFactor(event), [event.clientX, event.clientY])
  })

  if ('GestureEvent' in window) {
    // Safari reports pinches as gesture events (with a cumulative scale) and,
    // on iOS, as touches too, so only one of the two is used.
    let last = 1
    on('gesturestart', (event: Event) => {
      event.preventDefault()
      last = 1
    })
    on('gesturechange', (event: Event & { scale: number; clientX: number; clientY: number }) => {
      event.preventDefault()
      zoom(event.scale / last, [event.clientX, event.clientY])
      last = event.scale
    })
    on('gestureend', (event: Event) => event.preventDefault())
  } else {
    let last = 0
    on('touchstart', (event: TouchEvent) => {
      last = event.touches.length === 2 ? distance(event.touches[0], event.touches[1]) : 0
    })
    on('touchmove', (event: TouchEvent) => {
      if (event.touches.length !== 2) return
      event.preventDefault()
      const [a, b] = [event.touches[0], event.touches[1]]
      const now = distance(a, b)
      if (last > 0 && now > 0) zoom(now / last, [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2])
      last = now
    })
    on('touchend', (event: TouchEvent) => {
      last = event.touches.length === 2 ? distance(event.touches[0], event.touches[1]) : 0
    })
  }

  return () => cleanups.forEach((fn) => fn())
}
