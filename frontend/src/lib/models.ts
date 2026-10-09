/** The models the chat offers. The backend accepts exactly these (ask.py's AnswerModel). */
export const MODELS = [
  { id: 'claude-opus-5-5', name: 'Opus 5.5', hint: 'Best answers' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', hint: 'Faster, about half the cost' },
] as const

export type ModelId = (typeof MODELS)[number]['id']

const KEY = 'doc-digest.model'

/** The model picked last time in this browser, or the first one. */
export function savedModel(): ModelId {
  try {
    const id = localStorage.getItem(KEY)
    return MODELS.find((m) => m.id === id)?.id ?? MODELS[0].id
  } catch {
    return MODELS[0].id
  }
}

export function saveModel(id: ModelId) {
  try {
    localStorage.setItem(KEY, id)
  } catch {
    // Storage can be unavailable (private windows); the pick just isn't remembered.
  }
}
