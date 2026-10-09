import type { Option } from './Dropdown.svelte'
import type { Mode } from './workspace.svelte'

/** A speech bubble with a question mark: the model asking the questions. */
export const SOCRATIC_ICON =
  'M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5zM10 9.5a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2v.3M12 15.5h.01'

/** A plain speech bubble, like the chat icon: asking and getting answers. */
export const ASK_ICON =
  'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z'

/** The chat's modes, as its mode menu offers them. */
export const MODES: Option<Mode>[] = [
  {
    value: 'normal',
    label: 'Normal',
    title: 'Answers your questions',
    icon: ASK_ICON,
  },
  {
    value: 'socratic',
    label: 'Socratic',
    title: 'Asks you questions that lead you to the answer, instead of explaining',
    icon: SOCRATIC_ICON,
  },
]
