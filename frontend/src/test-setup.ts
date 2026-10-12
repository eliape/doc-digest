import '@testing-library/jest-dom/vitest'

// jsdom has no Web Animations; Svelte's transitions use them, so finish each one at once.
if (!Element.prototype.animate) {
  Element.prototype.animate = function () {
    const animation = { onfinish: null as (() => void) | null, cancel() {}, finished: Promise.resolve(), currentTime: 0 }
    queueMicrotask(() => animation.onfinish?.())
    return animation as unknown as Animation
  }
}
