/** The app's colours: always light, always dark, or following the system. */
export type Theme = 'light' | 'dark' | 'system'

export const THEMES: { id: Theme; name: string }[] = [
  { id: 'light', name: 'Light' },
  { id: 'dark', name: 'Dark' },
  { id: 'system', name: 'System' },
]

// index.html reads this too, to set the theme before the app loads and avoid a flash.
const KEY = 'leqtern.theme'

/** The theme picked last time in this browser, or System. */
export function savedTheme(): Theme {
  try {
    const theme = localStorage.getItem(KEY)
    return THEMES.find((t) => t.id === theme)?.id ?? 'system'
  } catch {
    return 'system'
  }
}

/** Show the app in a theme and remember it. app.css picks the colours from `data-theme`. */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement) {
  if (theme === 'system') delete root.dataset.theme
  else root.dataset.theme = theme
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // Storage can be unavailable (private windows); the pick just isn't remembered.
  }
}
