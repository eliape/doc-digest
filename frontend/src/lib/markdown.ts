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
 * text is untrusted, so anything like scripts or event handlers is stripped.
 */
export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false })
  // KaTeX's MathML copy (for screen readers and copying) keeps the LaTeX in <annotation>.
  return DOMPurify.sanitize(html, { ADD_TAGS: ['semantics', 'annotation'], ADD_ATTR: ['target', 'encoding'] })
}
