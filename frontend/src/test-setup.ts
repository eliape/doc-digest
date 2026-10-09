import '@testing-library/jest-dom/vitest'

// jsdom has no ResizeObserver, which Svelte's bind:clientWidth uses. Sizes stay 0 in tests.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
