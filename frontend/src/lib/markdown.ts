import DOMPurify from 'dompurify'
import katex from 'katex'
import { Marked, type TokenizerAndRendererExtension } from 'marked'

/** Typeset LaTeX with KaTeX. Bad or half-streamed LaTeX shows as red source rather than throwing. */
function tex(source: string, displayMode: boolean): string {
  return katex.renderToString(source, { displayMode, throwOnError: false, output: 'htmlAndMathml' })
}

// Display maths: $$...$$ or \[...\], which may span lines.
const blockMath: TokenizerAndRendererExtension = {
  name: 'blockMath',
  level: 'block',
  start: (src) => src.match(/\$\$|\\\[/)?.index,
  tokenizer(src) {
    const match = /^\$\$([\s\S]+?)\$\$[^\S\n]*(?:\n|$)/.exec(src) ?? /^\\\[([\s\S]+?)\\\][^\S\n]*(?:\n|$)/.exec(src)
    if (match) return { type: 'blockMath', raw: match[0], text: match[1].trim() }
  },
  renderer: (token) => `<div class="math-display">${tex(token.text, true)}</div>\n`,
}

// Inline maths: \(...\), $$...$$ inside a line, or $...$. For single dollars the opening $ must
// not be followed by a space and the closing $ must not be preceded by one or followed by a
// digit, so prices like "$5 and $10" stay as text.
const inlineMath: TokenizerAndRendererExtension = {
  name: 'inlineMath',
  level: 'inline',
  start: (src) => src.match(/\$|\\\(/)?.index,
  tokenizer(src) {
    const match =
      /^\\\(([\s\S]+?)\\\)/.exec(src) ??
      /^\$\$([^$]+?)\$\$/.exec(src) ??
      /^\$(?!\s)((?:\\\$|[^$\n])+?)(?<!\s)\$(?!\d)/.exec(src)
    if (match) return { type: 'inlineMath', raw: match[0], text: match[1].trim(), display: match[0].startsWith('$$') }
  },
  renderer: (token) => tex(token.text, token.display),
}

// Links open in a new tab: following one in place would leave the app and lose the open PDFs.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

const marked = new Marked({ gfm: true, breaks: true, extensions: [blockMath, inlineMath] })

/** Which PDFs an answer's citations can point at (see linkCitations). */
export type CitableDocs = {
  /** The topic's PDF names. */
  names: string[]
  /** The backend's aliases for them, like D1, as the model sees them. */
  aliases?: Record<string, string>
  /** The PDF a citation with only a page, like "(p. 12)", is about: the one the question was asked in. */
  current?: string
}

/**
 * Turn an answer's Markdown, with LaTeX maths, into HTML that is safe to insert: the model's
 * text is untrusted, so anything like scripts or event handlers is stripped. Citations of the
 * PDFs in `docs` become links (see linkCitations).
 */
export function renderMarkdown(source: string, docs?: CitableDocs): string {
  const html = marked.parse(source, { async: false })
  // KaTeX's MathML copy (for screen readers and copying) keeps the LaTeX in <annotation>.
  const options = { ADD_TAGS: ['semantics', 'annotation'], ADD_ATTR: ['target', 'encoding'] }
  if (!docs?.names.length) return DOMPurify.sanitize(html, options)
  const root = document.createElement('div')
  root.append(DOMPurify.sanitize(html, { ...options, RETURN_DOM_FRAGMENT: true }))
  linkCitations(root, docs)
  return root.innerHTML
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// "p. 41", "pp. 41–43", also spelled out or in Swedish ("page 41", "s. 41", "sid. 41").
const PAGES = String.raw`(?:pp?\.|pages?|ss?\.|sid\.|sidorna|sidan|sida)\s*(\d+)(?:\s*[–—-]\s*\d+)?`

/**
 * Wrap page citations in links carrying the PDF's name and the first page, so the chat can show
 * that page. ask.py asks for "(book.pdf, p. 41)" or "(book.pdf, pp. 41–43)"; the model sometimes
 * leaves out ".pdf" or the comma, uses the alias it sees in tool results ("D1, p. 41", shown with
 * the PDF's name instead), or gives only the page ("(p. 41)"), which means `current`.
 * Code, maths and links are left alone.
 */
export function linkCitations(root: HTMLElement, docs: CitableDocs) {
  const byName = new Map<string, string>()
  for (const doc of docs.names) {
    byName.set(doc.toLowerCase(), doc)
    const bare = doc.replace(/\.pdf$/i, '')
    if (bare && bare !== doc) byName.set(bare.toLowerCase(), doc)
  }
  const byAlias = new Map<string, string>()
  for (const [alias, doc] of Object.entries(docs.aliases ?? {})) {
    if (docs.names.includes(doc)) byAlias.set(alias.toLowerCase(), doc)
  }
  const names = [...byName.keys(), ...byAlias.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp)
  if (!names.length) return
  const named = String.raw`(?<![\w.-])(${names.join('|')}),?\s*${PAGES}`
  // A page alone counts only right after an opening parenthesis, as in "(p. 41)".
  const alone = String.raw`(?<=\(\s*)${PAGES}`
  const pattern = new RegExp(docs.current ? `${named}|${alone}` : named, 'gi')

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('code, pre, a, button, .katex') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  })
  const texts: Text[] = []
  while (walker.nextNode()) texts.push(walker.currentNode as Text)

  for (const node of texts) {
    const text = node.data
    const matches = [...text.matchAll(pattern)]
    if (!matches.length) continue
    const pieces: (string | HTMLElement)[] = []
    let at = 0
    for (const match of matches) {
      const [whole, name, namedPage, alonePage] = match
      const key = name?.toLowerCase()
      const doc = key ? (byName.get(key) ?? byAlias.get(key)!) : docs.current!
      const page = namedPage ?? alonePage
      // An alias means nothing to the reader, so the link shows the PDF's name instead.
      const shown = key && byAlias.has(key) && !byName.has(key) ? doc + whole.slice(name.length) : whole
      pieces.push(text.slice(at, match.index))
      // A link, so it wraps with the sentence like text; the chat handles its click.
      const link = document.createElement('a')
      link.href = '#'
      link.className = 'citation'
      link.dataset.doc = doc
      link.dataset.page = page
      link.title = `Show ${doc}, p. ${page}`
      // Non-breaking spaces keep "p. 41" with its PDF's name when the line wraps.
      const lead = key ? shown.length - (whole.length - name.length) : 0
      link.textContent = shown.slice(0, lead) + shown.slice(lead).replace(/\s+/g, '\u00a0')
      pieces.push(link)
      at = match.index + whole.length
    }
    pieces.push(text.slice(at))
    node.replaceWith(...pieces)
  }
}
