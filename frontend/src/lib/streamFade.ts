/** How long a newly streamed piece of an answer takes to fade in. */
export const FADE_MS = 400

type Piece = { start: number; at: number }

/**
 * Shows an answer's HTML and fades in the text that streams onto its end, so new words appear
 * softly instead of popping in. The HTML is rebuilt on every chunk, so each render wraps every
 * piece still fading in a span whose animation is set back by the time it has already run;
 * pieces that are done render as plain text. Maths (KaTeX) just appears.
 */
export function streamFade(node: HTMLElement, params: { html: string; live: boolean }) {
  let seen = -1
  let pieces: Piece[] = []
  let shown: string | undefined

  function render({ html, live }: { html: string; live: boolean }) {
    // Rebuilding the same HTML would only cut short its fades and drop a selection in it.
    if (html === shown) return
    shown = html
    node.innerHTML = html
    const texts = textNodes(node)
    const total = texts.reduce((sum, t) => sum + t.length, 0)
    const now = performance.now()
    // An answer that was already there when it was first shown doesn't fade.
    if (seen < 0 && !live) seen = total
    if (seen < 0) seen = 0
    if (total > seen && live) pieces.push({ start: seen, at: now })
    seen = total
    pieces = pieces.filter((piece) => now - piece.at < FADE_MS)
    if (pieces.length) wrap(texts, pieces, now)
  }

  render(params)
  return { update: render }
}

function textNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  return nodes
}

function wrap(texts: Text[], pieces: Piece[], now: number) {
  let offset = 0
  for (const text of texts) {
    const from = offset
    const to = (offset += text.length)
    if (text.parentElement?.closest('.katex')) continue
    // Split from the end so the earlier offsets in this text node stay valid.
    for (let i = pieces.length - 1; i >= 0; i--) {
      const start = Math.max(pieces[i].start, from)
      const end = Math.min(pieces[i + 1]?.start ?? Infinity, to)
      if (start >= end) continue
      const part = text.splitText(start - from)
      part.splitText(end - start)
      const span = document.createElement('span')
      span.className = 'fresh'
      span.style.animationDelay = `${-(now - pieces[i].at)}ms`
      part.replaceWith(span)
      span.append(part)
    }
  }
}
