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

/**
 * Turn an answer's Markdown, with LaTeX maths, into HTML that is safe to insert: the model's
 * text is untrusted, so anything like scripts or event handlers is stripped. Citations of the
 * PDFs named in `docs` become links (see linkCitations).
 */
export function renderMarkdown(source: string, docs: string[] = []): string {
  const html = marked.parse(source, { async: false })
  // KaTeX's MathML copy (for screen readers and copying) keeps the LaTeX in <annotation>.
  const options = { ADD_TAGS: ['semantics', 'annotation'], ADD_ATTR: ['target', 'encoding'] }
  if (!docs.length) return DOMPurify.sanitize(html, options)
  const root = document.createElement('div')
  root.append(DOMPurify.sanitize(html, { ...options, RETURN_DOM_FRAGMENT: true }))
  linkCitations(root, docs)
  return root.innerHTML
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Wrap page citations of the given PDFs, written as ask.py asks ("book.pdf, p. 41" or
 * "book.pdf, pp. 41–43", the .pdf optional), in links carrying the PDF's name and the
 * first page, so the chat can show that page. Code, maths and links are left alone.
 */
export function linkCitations(root: HTMLElement, docs: string[]) {
  const byName = new Map<string, string>()
  for (const doc of docs) {
    byName.set(doc.toLowerCase(), doc)
    const bare = doc.replace(/\.pdf$/i, '')
    if (bare && bare !== doc) byName.set(bare.toLowerCase(), doc)
  }
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp)
  if (!names.length) return
  const pattern = new RegExp(`(?<![\\w.-])(${names.join('|')}),\\s*pp?\\.\\s*(\\d+)(?:\\s*[–—-]\\s*\\d+)?`, 'gi')

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
      const doc = byName.get(match[1].toLowerCase())!
      pieces.push(text.slice(at, match.index))
      // A link, so it wraps with the sentence like text; the chat handles its click.
      const link = document.createElement('a')
      link.href = '#'
      link.className = 'citation'
      link.dataset.doc = doc
      link.dataset.page = match[2]
      link.title = `Show ${doc}, p. ${match[2]}`
      // Non-breaking spaces keep "p. 41" with its PDF's name when the line wraps.
      link.textContent = match[1] + match[0].slice(match[1].length).replace(/\s+/g, '\u00a0')
      pieces.push(link)
      at = match.index + match[0].length
    }
    pieces.push(text.slice(at))
    node.replaceWith(...pieces)
  }
}
