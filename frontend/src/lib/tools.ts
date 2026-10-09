/**
 * What a left click on the PDF does. `select` works like any PDF reader (click, drag, select
 * and copy text); `ask` attaches what is clicked or selected to the chat straight away.
 * A right-click opens the same menu with either.
 */
export type Tool = 'select' | 'ask'

/** The tools as the PDF toolbar offers them. Icons are SVG paths on a 24 by 24 grid. */
export const TOOLS: { value: Tool; label: string; title: string; icon: string }[] = [
  {
    value: 'select',
    label: 'Select',
    title: 'Select: click and drag like in any PDF reader. Right-click to ask about something.',
    // An arrow pointer.
    icon: 'M5 4l14 6.2-6.2 1.9-2 6.4z',
  },
  {
    value: 'ask',
    label: 'Click to ask',
    title: 'Click to ask: click or select something to ask about it in the chat',
    // A hand pointing with its index finger.
    icon: 'M9 13V4.5a1.5 1.5 0 0 1 3 0V12M12 11V9.5a1.5 1.5 0 0 1 3 0V12M15 12v-1a1.5 1.5 0 0 1 3 0v1.5M18 12.5a1.5 1.5 0 0 1 3 0v2.5a7 7 0 0 1-7 7h-1.5c-2.2 0-3.6-.7-4.9-2l-3.2-3.3a1.5 1.5 0 0 1 2.1-2.1L9 18',
  },
]

const KEY = 'doc-digest.tool'

/** The tool picked last time in this browser, or Select. */
export function savedTool(): Tool {
  try {
    const value = localStorage.getItem(KEY)
    return TOOLS.find((t) => t.value === value)?.value ?? 'select'
  } catch {
    return 'select'
  }
}

export function saveTool(tool: Tool) {
  try {
    localStorage.setItem(KEY, tool)
  } catch {
    // Storage can be unavailable (private windows); the pick just isn't remembered.
  }
}
