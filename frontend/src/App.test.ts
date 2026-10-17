import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tick } from 'svelte'
import App from './App.svelte'

// PDF.js needs a real browser (canvas, workers), so tests stop at the loader.
vi.mock('./lib/pdfjs', () => ({ loadPdfjs: () => new Promise(() => {}) }))

/** A backend with nothing saved that is otherwise unreachable, unless a test stands in its own. */
function offline() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/workspace') return new Response('{}')
    if (url.startsWith('/api/workspace?') && init?.method === 'PUT') return new Response('{"status": "saved", "revision": 1}')
    throw new Error('offline')
  })
}

beforeEach(() => {
  vi.stubGlobal('fetch', offline())
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** Adding a PDF folds the sidebar away; open it again to use the topics. */
async function showTopics() {
  await fireEvent.click(screen.getByRole('button', { name: 'Show topics' }))
}

const pdf = (name: string, body = '%PDF-1.7') => new File([body], name, { type: 'application/pdf' })

function renderOffline() {
  vi.stubGlobal('fetch', offline())
  return render(App)
}

async function pick(file: File) {
  await fireEvent.change(screen.getByTestId('file-input'), { target: { files: [file] } })
}

/** PDF.js does not run here, so stand in a rendered page for it in the open viewer. */
function standInPage(n: number) {
  const page = document.createElement('div')
  page.className = 'page'
  page.dataset.pageNumber = String(n)
  page.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600 }) as DOMRect
  screen.getByTestId('pdf-viewer').querySelector('.pdfViewer')!.appendChild(page)
  return page
}

async function leftClick(target: Element, clientX: number, clientY: number) {
  await fireEvent.pointerDown(target, { button: 0, clientX, clientY, isPrimary: true })
  await fireEvent.pointerUp(target, { button: 0, clientX, clientY })
}

describe('saving', () => {
  /** A backend with one saved topic at revision 5 that answers saves with `answer`. */
  function backend(answer: (url: string) => Response) {
    const saves: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/workspace') {
          return new Response(JSON.stringify({ version: 1, topics: [{ id: 't', name: 'Saved', docs: [], chats: [] }], revision: 5 }))
        }
        if (url.startsWith('/api/workspace?') && init?.method === 'PUT') {
          saves.push(url)
          return answer(url)
        }
        throw new Error('offline')
      }),
    )
    return saves
  }

  it('says which revision each save builds on, and which tab sent it', async () => {
    let revision = 5
    const saves = backend(() => new Response(JSON.stringify({ status: 'saved', revision: ++revision })))
    render(App)
    await screen.findByText('Saved')
    await fireEvent.click(screen.getByRole('button', { name: 'New topic' }))
    await waitFor(() => expect(saves).toHaveLength(1), { timeout: 2000 })
    expect(saves[0]).toMatch(/^\/api\/workspace\?base=5&writer=[\w-]+$/)
    await fireEvent.keyDown(screen.getByRole('textbox', { name: 'Topic name' }), { key: 'Escape' })
    await waitFor(() => expect(saves).toHaveLength(2), { timeout: 2000 })
    expect(saves[1]).toContain('base=6&')
    expect(saves[1].split('writer=')[1]).toBe(saves[0].split('writer=')[1])
  })

  it('stops saving and asks for a reload once another tab has saved', async () => {
    const saves = backend(() => new Response(JSON.stringify({ detail: 'Saved from another tab.' }), { status: 409 }))
    render(App)
    await screen.findByText('Saved')
    await fireEvent.click(screen.getByRole('button', { name: 'New topic' }))
    expect(await screen.findByText(/changed in another tab/, {}, { timeout: 2000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    await fireEvent.keyDown(screen.getByRole('textbox', { name: 'Topic name' }), { key: 'Escape' })
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(saves).toHaveLength(1)
  })
})

describe('App', () => {
  it('has no header: the title lives in the sidebar and the backend status is gone', () => {
    renderOffline()
    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
    expect(screen.queryByText(/Backend/)).not.toBeInTheDocument()
    const sidebar = within(screen.getByRole('complementary', { name: 'Topics' }))
    expect(sidebar.getByRole('heading', { name: 'Leqtern' })).toBeInTheDocument()
    expect(sidebar.getByRole('heading', { name: 'Topics' })).toBeInTheDocument()
  })

  it('asks for a PDF before one is open', () => {
    vi.stubGlobal('fetch', offline())
    render(App)
    expect(screen.getByText('Open a PDF to start reading.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Page number')).not.toBeInTheDocument()
  })

  it('opens a picked PDF and shows its name with page and zoom controls', async () => {
    vi.stubGlobal('fetch', offline())
    render(App)
    const file = new File(['%PDF-1.7'], 'chapter-3.pdf', { type: 'application/pdf' })
    await fireEvent.change(screen.getByTestId('file-input'), { target: { files: [file] } })
    expect(await screen.findByRole('tab', { name: 'chapter-3.pdf' })).toBeInTheDocument()
    expect(screen.getByLabelText('Page number')).toBeInTheDocument()
    expect(screen.getByLabelText('Zoom in')).toBeInTheDocument()
    expect(screen.getByTestId('pdf-viewer')).toBeInTheDocument()
  })

  it('refuses files that are not PDFs', async () => {
    vi.stubGlobal('fetch', offline())
    render(App)
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    await fireEvent.change(screen.getByTestId('file-input'), { target: { files: [file] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('notes.txt is not a PDF.')
    expect(screen.getByText('Open a PDF to start reading.')).toBeInTheDocument()
  })

  it('opens several picked PDFs at once as tabs in one topic, on the first, and folds the sidebar away', async () => {
    renderOffline()
    await fireEvent.change(screen.getByTestId('file-input'), {
      target: { files: [pdf('Lecture 4.pdf'), pdf('Course book.pdf', '%PDF-1.7 book'), pdf('Old exam.pdf', '%PDF-1.7 exam')] },
    })
    await screen.findByRole('tab', { name: 'Old exam.pdf' })
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.trim())).toEqual(
      expect.arrayContaining(['Lecture 4.pdf', 'Course book.pdf', 'Old exam.pdf']),
    )
    expect(screen.getByRole('tab', { name: 'Lecture 4.pdf', selected: true })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show topics' })).toBeInTheDocument()
    await showTopics()
    expect(screen.getAllByRole('button', { name: /^Actions for (?!.*\.pdf)/ })).toHaveLength(1)
  })

  it('opens the PDFs in a mixed pick and names the ones that are not PDFs', async () => {
    renderOffline()
    await fireEvent.change(screen.getByTestId('file-input'), {
      target: { files: [pdf('a.pdf'), new File(['x'], 'notes.txt', { type: 'text/plain' })] },
    })
    expect(await screen.findByRole('tab', { name: 'a.pdf' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('notes.txt is not a PDF.')
  })

  it('lets the file picker choose more than one file', () => {
    renderOffline()
    expect(screen.getByTestId('file-input')).toHaveAttribute('multiple')
  })

  it('opens PDFs as tabs in a topic named after the first file', async () => {
    renderOffline()
    await pick(pdf('Lecture 4.pdf'))
    await screen.findByRole('tab', { name: 'Lecture 4.pdf' })
    await pick(pdf('Course book.pdf', '%PDF-1.7 book'))
    const book = await screen.findByRole('tab', { name: 'Course book.pdf' })
    await showTopics()

    const topics = within(screen.getByRole('complementary', { name: 'Topics' }))
    expect(topics.getByRole('button', { name: /^Lecture 4(?!\.pdf)/ })).toHaveAttribute('aria-current', 'true')
    expect(topics.getAllByRole('button', { name: /^Actions for (?!.*\.pdf)/ })).toHaveLength(1)
    expect(book).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByTestId('pdf-viewer')).toHaveLength(2)

    await fireEvent.click(screen.getByRole('tab', { name: 'Lecture 4.pdf' }))
    expect(screen.getByRole('tab', { name: 'Lecture 4.pdf' })).toHaveAttribute('aria-selected', 'true')
    expect(book).toHaveAttribute('aria-selected', 'false')
  })

  it('closes a tab and switches to the next one', async () => {
    renderOffline()
    await pick(pdf('a.pdf', 'a'))
    await pick(pdf('b.pdf', 'b'))
    await screen.findByRole('tab', { name: 'b.pdf' })
    await fireEvent.click(screen.getByRole('button', { name: 'Close b.pdf' }))
    expect(screen.queryByRole('tab', { name: 'b.pdf' })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'a.pdf' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByTestId('pdf-viewer')).toHaveLength(1)
  })

  it('keeps each topic to its own tabs', async () => {
    renderOffline()
    await pick(pdf('slides.pdf'))
    await screen.findByRole('tab', { name: 'slides.pdf' })

    await fireEvent.click(screen.getByRole('button', { name: 'New topic' }))
    const name = screen.getByLabelText('Topic name')
    await fireEvent.input(name, { target: { value: 'Statistics' } })
    await fireEvent.submit(name)
    expect(screen.getByText('Add a PDF to Statistics.')).toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()

    await pick(pdf('stats.pdf', 'stats'))
    expect(await screen.findByRole('tab', { name: 'stats.pdf' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'slides.pdf' })).not.toBeInTheDocument()

    await showTopics()
    await fireEvent.click(screen.getByRole('button', { name: /^slides(?!\.pdf)/ }))
    expect(screen.getByRole('tab', { name: 'slides.pdf' })).toHaveAttribute('aria-selected', 'true')
  })

  it('deletes a topic after confirming', async () => {
    renderOffline()
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
    await pick(pdf('slides.pdf'))
    await screen.findByRole('tab', { name: 'slides.pdf' })
    await showTopics()
    await fireEvent.click(screen.getByRole('button', { name: 'Actions for slides' }))
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(confirm).toHaveBeenCalledWith('Delete “slides” and close its PDF?')
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.getByText('Open a PDF to start reading.')).toBeInTheDocument()
  })

  it('collapses the sidebar to a strip that keeps the menu and New topic buttons', async () => {
    renderOffline()
    const sidebar = screen.getByRole('complementary', { name: 'Topics' })
    const toggle = within(sidebar).getByRole('button', { name: 'Hide topics' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await fireEvent.click(toggle)

    // The contents stay while the sidebar slides shut, then go.
    await waitFor(() => expect(within(sidebar).queryByRole('heading', { name: 'Topics' })).not.toBeInTheDocument())
    expect(within(sidebar).queryByRole('heading', { name: 'Leqtern' })).not.toBeInTheDocument()
    expect(within(sidebar).getByRole('button', { name: 'Show topics' })).toHaveAttribute('aria-expanded', 'false')
    expect(within(sidebar).getByRole('button', { name: 'New topic' })).toBeInTheDocument()

    await fireEvent.click(within(sidebar).getByRole('button', { name: 'Show topics' }))
    expect(within(sidebar).getByRole('heading', { name: 'Topics' })).toBeInTheDocument()
  })

  it('starts every load with the sidebar open and the chat closed, whatever an earlier visit left', () => {
    localStorage.setItem('doc-digest.sidebarOpen', 'false')
    localStorage.setItem('doc-digest.chatOpen', 'true')
    renderOffline()
    expect(screen.getByRole('button', { name: 'Hide topics' })).toHaveAttribute('aria-expanded', 'true')
    expect((screen.getByRole('complementary', { name: 'Chat' }) as HTMLElement & { inert: boolean }).inert).toBe(true)
  })

  it('folds the sidebar away when a PDF is added, every time', async () => {
    renderOffline()
    expect(screen.getByRole('button', { name: 'Hide topics' })).toBeInTheDocument()
    await pick(pdf('a.pdf', 'a'))
    expect(screen.getByRole('button', { name: 'Show topics' })).toHaveAttribute('aria-expanded', 'false')

    await showTopics()
    await pick(pdf('b.pdf', 'b'))
    expect(screen.getByRole('button', { name: 'Show topics' })).toBeInTheDocument()
  })

  it('leaves the sidebar open when the file is not a PDF', async () => {
    renderOffline()
    await pick(new File(['hello'], 'notes.txt', { type: 'text/plain' }))
    expect(screen.getByRole('button', { name: 'Hide topics' })).toBeInTheDocument()
  })

  it('names the browser tab after the open topic', async () => {
    renderOffline()
    expect(document.title).toBe('Leqtern')
    const sidebar = within(screen.getByRole('complementary', { name: 'Topics' }))
    await fireEvent.click(sidebar.getByRole('button', { name: 'New topic' }))
    const name = sidebar.getByLabelText('Topic name')
    await fireEvent.input(name, { target: { value: 'Statistics' } })
    await fireEvent.submit(name)
    expect(document.title).toBe('Statistics · Leqtern')

    await showTopics()
    await fireEvent.click(sidebar.getByRole('button', { name: 'Actions for Statistics' }))
    await fireEvent.click(sidebar.getByRole('menuitem', { name: 'Rename' }))
    const again = sidebar.getByLabelText('Topic name')
    await fireEvent.input(again, { target: { value: 'Stats' } })
    await fireEvent.submit(again)
    expect(document.title).toBe('Stats · Leqtern')
  })

  it('folds the sidebar away once a new topic is named, but not when a topic is only renamed', async () => {
    renderOffline()
    const sidebar = within(screen.getByRole('complementary', { name: 'Topics' }))
    await fireEvent.click(sidebar.getByRole('button', { name: 'New topic' }))
    // Still open while the name is being typed.
    const name = sidebar.getByLabelText('Topic name')
    expect(sidebar.getByRole('button', { name: 'Hide topics' })).toBeInTheDocument()
    await fireEvent.input(name, { target: { value: 'Statistics' } })
    await fireEvent.submit(name)
    expect(sidebar.getByRole('button', { name: 'Show topics' })).toBeInTheDocument()

    await showTopics()
    await fireEvent.click(sidebar.getByRole('button', { name: 'Actions for Statistics' }))
    await fireEvent.click(sidebar.getByRole('menuitem', { name: 'Rename' }))
    const again = sidebar.getByLabelText('Topic name')
    await fireEvent.input(again, { target: { value: 'Stats' } })
    await fireEvent.submit(again)
    expect(sidebar.getByRole('button', { name: /^Stats/ })).toBeInTheDocument()
    expect(sidebar.getByRole('button', { name: 'Hide topics' })).toBeInTheDocument()
  })

  it('puts rename and delete in a three-dot menu on each topic that closes on Escape or an outside click', async () => {
    renderOffline()
    await pick(pdf('slides.pdf'))
    await screen.findByRole('tab', { name: 'slides.pdf' })
    await showTopics()
    expect(screen.queryByRole('button', { name: /^(Rename|Delete) / })).not.toBeInTheDocument()
    const dots = screen.getByRole('button', { name: 'Actions for slides' })
    expect(dots).toHaveAttribute('aria-expanded', 'false')
    await fireEvent.click(dots)
    expect(dots).toHaveAttribute('aria-expanded', 'true')
    const items = screen.getAllByRole('menuitem')
    expect(items.map((i) => i.textContent?.trim())).toEqual(['Rename', 'Conventions and purpose', 'Flashcards', 'Delete'])
    expect(items.every((i) => i.querySelector('svg'))).toBe(true)
    expect(items[3]).toHaveClass('danger')

    await fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    await fireEvent.click(dots)
    await fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('edits the conventions and purpose of a topic from its menu, keeping the sidebar open', async () => {
    renderOffline()
    await pick(pdf('slides.pdf'))
    await screen.findByRole('tab', { name: 'slides.pdf' })
    await showTopics()
    await fireEvent.click(screen.getByRole('button', { name: 'Actions for slides' }))
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Conventions and purpose' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Conventions and purpose' }))
    const purpose = dialog.getByRole('textbox', { name: /^Purpose/ })
    expect(purpose).toHaveFocus()
    await fireEvent.pointerDown(purpose)
    await fireEvent.input(purpose, { target: { value: 'Exam in December' } })
    await fireEvent.input(dialog.getByRole('textbox', { name: /^Conventions/ }), { target: { value: 'j is the imaginary unit' } })
    await fireEvent.keyDown(purpose, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide topics' })).toBeInTheDocument()

    // It comes back with what was typed.
    await fireEvent.click(screen.getByRole('button', { name: 'Actions for slides' }))
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Conventions and purpose' }))
    expect(screen.getByRole('textbox', { name: /^Purpose/ })).toHaveValue('Exam in December')
    expect(screen.getByRole('textbox', { name: /^Conventions/ })).toHaveValue('j is the imaginary unit')
  })

  it('cancels a new topic on Escape: the placeholder goes, the sidebar stays open and the earlier topic stays selected', async () => {
    renderOffline()
    await pick(pdf('slides.pdf'))
    await screen.findByRole('tab', { name: 'slides.pdf' })
    await showTopics()
    const sidebar = within(screen.getByRole('complementary', { name: 'Topics' }))
    await fireEvent.click(sidebar.getByRole('button', { name: 'New topic' }))
    await fireEvent.keyDown(sidebar.getByLabelText('Topic name'), { key: 'Escape' })

    expect(sidebar.queryByLabelText('Topic name')).not.toBeInTheDocument()
    expect(sidebar.queryByRole('button', { name: /^New topic/  })).toBeInTheDocument()
    expect(sidebar.queryByText('New topic', { selector: '.name' })).not.toBeInTheDocument()
    expect(sidebar.getByRole('button', { name: 'Hide topics' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'slides.pdf' })).toBeInTheDocument()
  })

  it('folds the sidebar away when the content is pressed', async () => {
    renderOffline()
    await pick(pdf('slides.pdf'))
    await screen.findByRole('tab', { name: 'slides.pdf' })
    await showTopics()
    expect(screen.getByRole('button', { name: 'Hide topics' })).toBeInTheDocument()
    await fireEvent.pointerDown(screen.getByTestId('pdf-viewer'))
    expect(screen.getByRole('button', { name: 'Show topics' })).toBeInTheDocument()
  })

  it('folds the sidebar away when the chat is pressed, but not when the sidebar itself is', async () => {
    renderOffline()
    await pick(pdf('slides.pdf'))
    await screen.findByRole('tab', { name: 'slides.pdf' })
    await showTopics()
    await fireEvent.pointerDown(screen.getByRole('heading', { name: 'Topics' }))
    expect(screen.getByRole('button', { name: 'Hide topics' })).toBeInTheDocument()
    await fireEvent.pointerDown(screen.getByRole('complementary', { name: 'Chat' }))
    expect(screen.getByRole('button', { name: 'Show topics' })).toBeInTheDocument()
  })

  it('keeps the sidebar open when a topic is clicked, so a discussion can be picked', async () => {
    renderOffline()
    await pick(pdf('slides.pdf'))
    await screen.findByRole('tab', { name: 'slides.pdf' })
    await showTopics()
    await fireEvent.click(screen.getByRole('button', { name: /^slides(?!\.pdf)/ }))
    expect(screen.getByRole('button', { name: 'Hide topics' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New discussion' })).toBeInTheDocument()
  })

  it('lists a closed tab under Sources and reopens it from there', async () => {
    renderOffline()
    await pick(pdf('a.pdf', 'a'))
    await pick(pdf('b.pdf', 'b'))
    await screen.findByRole('tab', { name: 'b.pdf' })
    await fireEvent.click(screen.getByRole('button', { name: 'Close a.pdf' }))
    expect(screen.queryByRole('tab', { name: 'a.pdf' })).not.toBeInTheDocument()
    await showTopics()
    // Sources start closed; Discussions start open.
    expect(screen.getByRole('button', { name: 'Sources' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: 'Discussions' })).toHaveAttribute('aria-expanded', 'true')
    await fireEvent.click(screen.getByRole('button', { name: 'Sources' }))
    const sources = within(screen.getByRole('list', { name: 'Sources' }))
    expect(sources.getByRole('button', { name: /^b\.pdf/ })).toBeInTheDocument()
    await fireEvent.click(sources.getByRole('button', { name: /^a\.pdf/ }))
    expect(await screen.findByRole('tab', { name: 'a.pdf', selected: true })).toBeInTheDocument()
  })

  it('opens the file picker from Upload source, and toggles the lists', async () => {
    renderOffline()
    await pick(pdf('a.pdf', 'a'))
    await screen.findByRole('tab', { name: 'a.pdf' })
    await showTopics()
    const click = vi.spyOn(HTMLInputElement.prototype, 'click')
    await fireEvent.click(screen.getByRole('button', { name: 'Sources' }))
    await fireEvent.click(screen.getByRole('button', { name: /Upload source/ }))
    expect(click).toHaveBeenCalled()
    click.mockRestore()
    await fireEvent.click(screen.getByRole('button', { name: 'Discussions' }))
    expect(screen.getByRole('button', { name: 'Sources' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Discussions' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('reorders tabs by dragging one onto another', async () => {
    renderOffline()
    await pick(pdf('a.pdf', 'a'))
    await pick(pdf('b.pdf', 'b'))
    await screen.findByRole('tab', { name: 'b.pdf' })
    const tabs = () => screen.getAllByRole('tab').map((t) => t.textContent?.trim())
    expect(tabs()).toEqual(['a.pdf', 'b.pdf'])
    const first = screen.getByRole('tab', { name: 'a.pdf' }).parentElement!
    const second = screen.getByRole('tab', { name: 'b.pdf' }).parentElement!
    const data = new Map<string, string>()
    const dragImages: Element[] = []
    const dataTransfer = {
      setData: (k: string, v: string) => data.set(k, v),
      setDragImage: (el: Element) => dragImages.push(el),
      types: [],
      dropEffect: '',
      effectAllowed: '',
    }
    await fireEvent.dragStart(first, { dataTransfer })
    // A card with the PDF's name is carried along, and a line shows where the tab will land.
    expect(dragImages).toHaveLength(1)
    expect(dragImages[0].textContent).toBe('a.pdf')
    await fireEvent.dragOver(second, { dataTransfer, clientX: 10_000 })
    expect(document.querySelector('.drop-line')).toBeInTheDocument()
    // Once the drag has started, the PDF and chat stop taking the pointer, so nothing auto-scrolls.
    await waitFor(() => expect(document.querySelector('.app')).toHaveClass('tab-dragging'))
    await fireEvent.drop(second, { dataTransfer })
    expect(tabs()).toEqual(['b.pdf', 'a.pdf'])
    expect(document.querySelector('.drop-line')).not.toBeInTheDocument()
    expect(document.querySelector('.app')).not.toHaveClass('tab-dragging')
  })

  it('expands the sidebar when New topic is pressed while it is collapsed', async () => {
    renderOffline()
    const sidebar = within(screen.getByRole('complementary', { name: 'Topics' }))
    await fireEvent.click(sidebar.getByRole('button', { name: 'Hide topics' }))
    await fireEvent.click(sidebar.getByRole('button', { name: 'New topic' }))
    expect(sidebar.getByLabelText('Topic name')).toBeInTheDocument()
    expect(sidebar.getByRole('button', { name: 'Hide topics' })).toBeInTheDocument()
  })

  it('has no Open PDF button, and shows the open tab\'s controls in the tab row', async () => {
    renderOffline()
    expect(screen.queryByRole('button', { name: 'Open PDF' })).not.toBeInTheDocument()
    await pick(pdf('a.pdf', 'a'))
    await pick(pdf('b.pdf', 'b'))
    await screen.findByRole('tab', { name: 'b.pdf' })

    // One toolbar only (the open tab's), in the same row as the tabs.
    const toolbar = await screen.findByRole('toolbar', { name: 'PDF controls' })
    const tablist = screen.getByRole('tablist')
    expect(tablist.parentElement).toBe(toolbar.parentElement?.parentElement)
    expect(screen.getAllByLabelText('Page number')).toHaveLength(1)
    const sidebar = within(screen.getByRole('complementary', { name: 'Topics' }))
    expect(sidebar.queryByLabelText('Page number')).not.toBeInTheDocument()

    // The other tab is inert, so keyboard focus and screen readers skip it.
    const hidden = screen.getByLabelText('a.pdf', { selector: '[role=tabpanel]' }) as HTMLElement & { inert: boolean }
    expect(hidden.inert).toBe(true)
    expect((screen.getByRole('tabpanel', { name: 'b.pdf' }) as HTMLElement & { inert: boolean }).inert).toBeFalsy()
  })

  it('pairs the page and zoom buttons to the left of their readouts', async () => {
    renderOffline()
    await pick(pdf('a.pdf'))
    const toolbar = within(await screen.findByRole('toolbar', { name: 'PDF controls' }))
    const order = (names: string[]) =>
      names.map((name) => toolbar.getByLabelText(name)).sort((a, b) => (a.compareDocumentPosition(b) & 4 ? -1 : 1))
    expect(order(['Previous page', 'Next page', 'Page number']).map((e) => e.getAttribute('aria-label'))).toEqual([
      'Previous page',
      'Next page',
      'Page number',
    ])
    expect(order(['Zoom out', 'Zoom in', 'Zoom level']).map((e) => e.getAttribute('aria-label'))).toEqual([
      'Zoom out',
      'Zoom in',
      'Zoom level',
    ])
    // Up arrow for the previous page (the line runs up to its head), down arrow for the next.
    const arrow = (name: string) => toolbar.getByLabelText(name).querySelector('path')?.getAttribute('d')
    expect(arrow('Previous page')).toBe('M12 19V5M5 12l7-7 7 7')
    expect(arrow('Next page')).toBe('M12 5v14M19 12l-7 7-7-7')
  })

  it('moves the controls to whichever tab is open', async () => {
    renderOffline()
    await pick(pdf('a.pdf', 'a'))
    await pick(pdf('b.pdf', 'b'))
    await screen.findByRole('tab', { name: 'b.pdf' })
    await fireEvent.click(screen.getByRole('tab', { name: 'a.pdf' }))
    expect(await screen.findAllByRole('toolbar', { name: 'PDF controls' })).toHaveLength(1)
    expect(within(screen.getByRole('tabpanel', { name: 'a.pdf' })).queryByRole('toolbar')).not.toBeInTheDocument()
  })

  it('opens the chat from the tab row and closes it without clearing it', async () => {
    renderOffline()
    expect(screen.queryByRole('button', { name: 'Show chat' })).not.toBeInTheDocument()
    await pick(pdf('slides.pdf'))
    await screen.findByRole('tab', { name: 'slides.pdf' })

    const toggle = screen.getByRole('button', { name: 'Show chat' })
    expect(screen.getByRole('tablist').parentElement).toBe(toggle.parentElement)
    const panel = screen.getByRole('complementary', { name: 'Chat' }) as HTMLElement & { inert: boolean }
    expect(panel.inert).toBe(true)
    await fireEvent.click(toggle)
    expect(panel.inert).toBe(false)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    const box = within(panel).getByLabelText('Ask a question')
    await fireEvent.input(box, { target: { value: 'What is on slide 3?' } })
    await fireEvent.keyDown(box, { key: 'Enter' })
    expect(within(panel).getByRole('log')).toHaveTextContent('What is on slide 3?')
    expect(box).toHaveValue('')

    await fireEvent.click(within(panel).getByRole('button', { name: 'Close chat' }))
    expect(panel.inert).toBe(true)
    expect(screen.getByRole('button', { name: 'Show chat' })).toHaveFocus()
    await fireEvent.click(screen.getByRole('button', { name: 'Show chat' }))
    expect(within(panel).getByRole('log')).toHaveTextContent('What is on slide 3?')

    await fireEvent.keyDown(document.body, { key: 'c' })
    expect(panel.inert).toBe(true)
  })

  it('keeps the chat across tabs and gives each topic its own', async () => {
    renderOffline()
    await pick(pdf('slides.pdf', 'a'))
    await pick(pdf('book.pdf', 'b'))
    await screen.findByRole('tab', { name: 'book.pdf' })
    await fireEvent.click(screen.getByRole('button', { name: 'Show chat' }))
    const panel = within(screen.getByRole('complementary', { name: 'Chat' }))
    await fireEvent.input(panel.getByLabelText('Ask a question'), { target: { value: 'Compare the two' } })
    await fireEvent.click(panel.getByRole('button', { name: 'Send' }))

    await fireEvent.click(screen.getByRole('tab', { name: 'slides.pdf' }))
    expect(panel.getByRole('log')).toHaveTextContent('Compare the two')

    // A half-typed question stays with its topic too.
    await fireEvent.input(panel.getByLabelText('Ask a question'), { target: { value: 'half typed' } })
    await showTopics()
    await fireEvent.click(screen.getByRole('button', { name: 'New topic' }))
    await fireEvent.submit(screen.getByLabelText('Topic name'))
    expect(panel.getByRole('log', { name: 'Chat in New topic' })).not.toHaveTextContent('Compare the two')
    expect(panel.getByLabelText('Ask a question')).toHaveValue('')

    await showTopics()
    await fireEvent.click(screen.getByRole('button', { name: /^slides(?!\.pdf)/ }))
    expect(panel.getByRole('log')).toHaveTextContent('Compare the two')
    expect(panel.getByLabelText('Ask a question')).toHaveValue('half typed')
  })

  it('toggles the chat with C, unless C is typing or meant for a menu, and leaves Enter and Escape alone', async () => {
    renderOffline()
    await fireEvent.keyDown(document.body, { key: 'c' })
    const panel = screen.getByRole('complementary', { name: 'Chat' }) as HTMLElement & { inert: boolean }
    // No topic yet, so there is no chat to open.
    expect(panel.inert).toBe(true)

    await pick(pdf('slides.pdf'))
    await screen.findByRole('tab', { name: 'slides.pdf' })
    expect(screen.getByRole('button', { name: 'Show chat' })).toHaveTextContent('Chat C')
    // Enter belongs to whatever has focus, and C typed in a text box is just a letter.
    await fireEvent.keyDown(screen.getByRole('tabpanel', { name: 'slides.pdf' }), { key: 'Enter' })
    await fireEvent.keyDown(screen.getByLabelText('Page number'), { key: 'c' })
    await fireEvent.keyDown(document.body, { key: 'c', ctrlKey: true })
    expect(panel.inert).toBe(true)

    // C works with a button focused, since it does nothing for a button.
    await fireEvent.keyDown(screen.getByRole('button', { name: 'Show chat' }), { key: 'c' })
    expect(panel.inert).toBe(false)
    await waitFor(() => expect(within(panel).getByLabelText('Ask a question')).toHaveFocus())

    // Escape leaves the chat open (the browser uses it to leave full screen); C in the box types.
    await fireEvent.keyDown(within(panel).getByLabelText('Ask a question'), { key: 'Escape' })
    await fireEvent.keyDown(within(panel).getByLabelText('Ask a question'), { key: 'c' })
    expect(panel.inert).toBe(false)

    await fireEvent.keyDown(within(panel).getByRole('button', { name: 'Close chat' }), { key: 'c' })
    expect(panel.inert).toBe(true)
    // Focus does not jump to the chat button, which would light up its outline and tooltip.
    await tick()
    expect(screen.getByRole('button', { name: 'Show chat' })).not.toHaveFocus()
  })

  it('resizes the chat by dragging or with the arrow keys, and remembers the width', async () => {
    renderOffline()
    await pick(pdf('slides.pdf'))
    await fireEvent.click(await screen.findByRole('button', { name: 'Show chat' }))
    const panel = screen.getByRole('complementary', { name: 'Chat' })
    const handle = within(panel).getByRole('separator', { name: 'Resize chat' })
    expect(handle).toHaveAttribute('aria-valuenow', '384')

    // Dragging the left edge 100px to the left makes the panel 100px wider.
    await fireEvent.pointerDown(handle, { clientX: 600, button: 0 })
    await fireEvent.pointerMove(handle, { clientX: 500 })
    await fireEvent.pointerUp(handle)
    expect(handle).toHaveAttribute('aria-valuenow', '484')
    expect(panel.style.getPropertyValue('--width')).toBe('484px')

    await fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(handle).toHaveAttribute('aria-valuenow', '468')
    expect(localStorage.getItem('doc-digest.chatWidth')).toBe('468')

    // It never gets narrower than the minimum, and double-click resets it.
    await fireEvent.pointerDown(handle, { clientX: 500, button: 0 })
    await fireEvent.pointerMove(handle, { clientX: 1000 })
    await fireEvent.pointerUp(handle)
    expect(handle).toHaveAttribute('aria-valuenow', '280')
    await fireEvent.dblClick(handle)
    expect(handle).toHaveAttribute('aria-valuenow', '384')
  })

  it('offers Select and Click to ask in the toolbar, starts on Select and remembers the pick', async () => {
    const { unmount } = renderOffline()
    await pick(pdf('slides.pdf'))
    const toolbar = within(await screen.findByRole('toolbar', { name: 'PDF controls' }))
    const tools = within(toolbar.getByRole('group', { name: 'Tool' }))
    expect(tools.getByRole('button', { name: 'Select', pressed: true })).toBeInTheDocument()
    expect(tools.getByRole('button', { name: 'Click to ask', pressed: false })).toBeInTheDocument()
    // To the right of the zoom controls.
    const zoom = toolbar.getByRole('group', { name: 'Zoom' })
    expect(zoom.compareDocumentPosition(tools.getByRole('button', { name: 'Select' })) & 4).toBeTruthy()

    await fireEvent.click(tools.getByRole('button', { name: 'Click to ask' }))
    expect(tools.getByRole('button', { name: 'Click to ask', pressed: true })).toBeInTheDocument()
    expect(tools.getByRole('button', { name: 'Select', pressed: false })).toBeInTheDocument()
    expect(screen.getByTestId('pdf-viewer')).toHaveClass('ask')

    unmount()
    renderOffline()
    await pick(pdf('slides.pdf'))
    expect(await screen.findByRole('button', { name: 'Click to ask', pressed: true })).toBeInTheDocument()
  })

  it('keeps the tool with the topic', async () => {
    renderOffline()
    await pick(pdf('slides.pdf'))
    const tool = (name: string) => screen.findByRole('button', { name })
    await fireEvent.click(await tool('Click to ask'))

    // A new topic starts on the tool picked last; picking Select there leaves slides alone.
    const sidebar = within(screen.getByRole('complementary', { name: 'Topics' }))
    await showTopics()
    await fireEvent.click(sidebar.getByRole('button', { name: 'New topic' }))
    const name = sidebar.getByLabelText('Topic name')
    await fireEvent.input(name, { target: { value: 'Stats' } })
    await fireEvent.submit(name)
    await pick(pdf('notes.pdf'))
    await screen.findByRole('tab', { name: 'notes.pdf' })
    expect((await tool('Click to ask')).getAttribute('aria-pressed')).toBe('true')
    await fireEvent.click(await tool('Select'))

    await showTopics()
    await fireEvent.click(sidebar.getByRole('button', { name: /^slides(?!\.pdf)/ }))
    await screen.findByRole('tab', { name: 'slides.pdf' })
    expect((await tool('Click to ask')).getAttribute('aria-pressed')).toBe('true')
    // Clicking a topic leaves the sidebar open.
    await fireEvent.click(sidebar.getByRole('button', { name: /^Stats/ }))
    await screen.findByRole('tab', { name: 'notes.pdf' })
    expect((await tool('Select')).getAttribute('aria-pressed')).toBe('true')
  })

  it('attaches nothing on a left click with Select, and the clicked spot with Click to ask', async () => {
    renderOffline()
    await pick(pdf('slides.pdf'))
    await screen.findByRole('tab', { name: 'slides.pdf' })
    const page = standInPage(3)
    const panel = screen.getByRole('complementary', { name: 'Chat' }) as HTMLElement & { inert: boolean }

    await leftClick(page, 100, 300)
    expect(page.querySelector('.context-marker')).toBeNull()
    expect(panel.inert).toBe(true)

    // Pressing a button focuses it, so the window has focus and the next click is not just bringing it to the front.
    const askTool = screen.getByRole('button', { name: 'Click to ask' })
    askTool.focus()
    await fireEvent.click(askTool)
    await leftClick(page, 100, 300)
    expect(page.querySelector('.context-marker')).not.toBeNull()
    expect(panel.inert).toBe(false)
    expect(within(panel).getByLabelText('Ask a question')).toHaveAttribute('placeholder', 'Ask about p. 3…')
  })

  it('opens a menu on a right-click on the page, whose Socratic and Quiz me attach the spot and wait for a focus', async () => {
    renderOffline()
    await pick(pdf('slides.pdf'))
    await screen.findByRole('tab', { name: 'slides.pdf' })
    const viewer = screen.getByTestId('pdf-viewer')
    const page = standInPage(3)

    // Off the page, the browser's own menu shows.
    expect(await fireEvent.contextMenu(viewer, { clientX: 500, clientY: 100 })).toBe(true)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    expect(await fireEvent.contextMenu(page, { clientX: 200, clientY: 150 })).toBe(false)
    const menu = screen.getByRole('menu', { name: 'Study this' })
    // Copy is only there for selected text.
    const labels = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.querySelector('.text > span')?.textContent)
    expect(labels).toEqual(['Ask', 'Socratic', 'Quiz me', 'Make flashcards'])
    expect(within(menu).getByRole('menuitem', { name: /^Quiz me/ })).not.toHaveAttribute('aria-disabled')
    await fireEvent.click(within(menu).getByRole('menuitem', { name: /^Socratic/ }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    // Like Ask, the spot is attached and nothing is sent until the reader says what to focus on, if anything.
    expect(page.querySelector('.context-marker:not(.fade)')).not.toBeNull()
    const panel = screen.getByRole('complementary', { name: 'Chat' }) as HTMLElement & { inert: boolean }
    expect(panel.inert).toBe(false)
    expect(within(panel).queryByText('Socratic session')).not.toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Mode: Socratic' })).toBeInTheDocument()
    expect(within(panel).getByLabelText('Ask a question')).toHaveAttribute('placeholder', 'What should it focus on? (optional)')

    await fireEvent.contextMenu(page, { clientX: 220, clientY: 160 })
    await fireEvent.click(screen.getByRole('menuitem', { name: /^Quiz me/ }))
    expect(within(panel).getByRole('button', { name: 'Mode: Quiz' })).toBeInTheDocument()
    expect(within(panel).getByLabelText('Attached to your question')).toBeInTheDocument()

    // A left click with Click to ask attaches the spot and switches back to normal answers.
    await fireEvent.click(screen.getByRole('button', { name: 'Click to ask' }))
    await leftClick(page, 100, 300)
    expect(within(panel).getByRole('button', { name: 'Mode: Normal' })).toBeInTheDocument()
  })

  it('opens Make flashcards for a right-clicked spot, and the deck from the topic’s menu', async () => {
    renderOffline()
    await pick(pdf('slides.pdf'))
    await screen.findByRole('tab', { name: 'slides.pdf' })
    const page = standInPage(3)
    await fireEvent.contextMenu(page, { clientX: 200, clientY: 150 })
    await fireEvent.click(screen.getByRole('menuitem', { name: /^Make flashcards/ }))
    const dialog = within(screen.getByRole('dialog', { name: 'Make flashcards' }))
    expect(dialog.getByText('The spot you right-clicked on p. 3 of slides.pdf')).toBeInTheDocument()
    // The chat stays as it was: nothing is attached to it.
    expect(page.querySelector('.context-marker')).toBeNull()
    await fireEvent.keyDown(dialog.getByRole('textbox', { name: /Focus/ }), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await showTopics()
    await fireEvent.click(screen.getByRole('button', { name: 'Actions for slides' }))
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Flashcards' }))
    expect(screen.getByRole('dialog', { name: 'Flashcards' })).toHaveTextContent('slides')
    // The sidebar stays open behind it.
    expect(screen.getByRole('button', { name: 'Actions for slides' })).toBeInTheDocument()
  })

  it('asks about a right-clicked spot from the menu, as a click with Click to ask would', async () => {
    renderOffline()
    await pick(pdf('slides.pdf'))
    await screen.findByRole('tab', { name: 'slides.pdf' })
    const page = standInPage(3)
    const panel = screen.getByRole('complementary', { name: 'Chat' }) as HTMLElement & { inert: boolean }
    const box = within(panel).getByLabelText('Ask a question')
    await fireEvent.input(box, { target: { value: 'Why is this' } })
    await fireEvent.click(within(panel).getByRole('button', { name: /^Mode:/ }))
    await fireEvent.click(within(panel).getByRole('menuitemradio', { name: 'Socratic' }))

    await fireEvent.contextMenu(page, { clientX: 200, clientY: 150 })
    await fireEvent.click(screen.getByRole('menuitem', { name: /^Ask/ }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(panel.inert).toBe(false)
    expect(page.querySelector('.context-marker')).not.toBeNull()
    expect(box).toHaveAttribute('placeholder', 'Ask about p. 3…')
    // What was typed stays, and asking about something goes back to normal answers.
    expect(box).toHaveValue('Why is this')
    expect(within(panel).getByRole('button', { name: 'Mode: Normal' })).toBeInTheDocument()
  })

  it('takes the attached spot off when the chat closes, and its marker fades out', async () => {
    renderOffline()
    await pick(pdf('slides.pdf'))
    await screen.findByRole('tab', { name: 'slides.pdf' })
    const page = standInPage(3)
    await fireEvent.contextMenu(page, { clientX: 200, clientY: 150 })
    await fireEvent.click(screen.getByRole('menuitem', { name: /^Ask/ }))
    expect(page.querySelector('.context-marker:not(.fade)')).not.toBeNull()

    const panel = within(screen.getByRole('complementary', { name: 'Chat' }))
    await fireEvent.click(panel.getByRole('button', { name: 'Close chat' }))
    expect(page.querySelector('.context-marker:not(.fade)')).toBeNull()
    expect(page.querySelector('.context-marker.fade')).not.toBeNull()
    await waitFor(() => expect(page.querySelector('.context-marker')).toBeNull())
    await fireEvent.click(screen.getByRole('button', { name: 'Show chat' }))
    expect(panel.queryByLabelText('Attached to your question')).not.toBeInTheDocument()
  })

  it('fades the marker out when the question about it is sent', async () => {
    renderOffline()
    await pick(pdf('slides.pdf'))
    await screen.findByRole('tab', { name: 'slides.pdf' })
    const page = standInPage(3)
    await fireEvent.contextMenu(page, { clientX: 200, clientY: 150 })
    await fireEvent.click(screen.getByRole('menuitem', { name: /^Ask/ }))
    const box = within(screen.getByRole('complementary', { name: 'Chat' })).getByLabelText('Ask a question')
    await fireEvent.input(box, { target: { value: 'What is this?' } })
    await fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(page.querySelector('.context-marker.fade')).not.toBeNull())
    expect(page.querySelector('.context-marker:not(.fade)')).toBeNull()
  })

  it('offers Copy for right-clicked selected text, and asks about that text', async () => {
    renderOffline()
    await pick(pdf('slides.pdf'))
    await screen.findByRole('tab', { name: 'slides.pdf' })
    const page = standInPage(3)
    const text = page.appendChild(document.createTextNode('the chain rule'))
    const line = { left: 50, top: 100, width: 120, height: 20, right: 170, bottom: 120 } as DOMRect
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      toString: () => 'the chain rule',
      getRangeAt: () => ({ startContainer: text, getClientRects: () => [line] }),
    } as unknown as Selection)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    try {
      // With Select, making the selection attaches nothing.
      await leftClick(page, 60, 110)
      expect(page.querySelector('.context-marker')).toBeNull()

      await fireEvent.pointerDown(page, { button: 2, clientX: 100, clientY: 110 })
      await fireEvent.contextMenu(page, { clientX: 100, clientY: 110 })
      const menu = screen.getByRole('menu', { name: 'Study this' })
      expect(within(menu).getByRole('separator').nextElementSibling).toBe(within(menu).getByRole('menuitem', { name: 'Copy' }))
      await fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy' }))
      expect(writeText).toHaveBeenCalledWith('the chain rule')
      expect(page.querySelector('.context-marker')).toBeNull()

      await fireEvent.pointerDown(page, { button: 2, clientX: 100, clientY: 110 })
      await fireEvent.contextMenu(page, { clientX: 100, clientY: 110 })
      await fireEvent.click(screen.getByRole('menuitem', { name: /^Ask/ }))
      const panel = within(screen.getByRole('complementary', { name: 'Chat' }))
      expect(panel.getByLabelText('Ask a question')).toHaveAttribute('placeholder', 'Ask about p. 3…')
      expect(panel.getByLabelText('Attached to your question')).toHaveTextContent('“the chain rule”')
      expect(page.querySelector('.context-marker.box')).not.toBeNull()
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard
    }
  })

  it('remembers per topic whether the chat is open', async () => {
    renderOffline()
    await pick(pdf('slides.pdf'))
    const sidebar = within(screen.getByRole('complementary', { name: 'Topics' }))
    await showTopics()
    await fireEvent.click(sidebar.getByRole('button', { name: 'New topic' }))
    const name = sidebar.getByLabelText('Topic name')
    await fireEvent.input(name, { target: { value: 'Stats' } })
    await fireEvent.submit(name)
    await pick(pdf('notes.pdf'))
    await screen.findByRole('tab', { name: 'notes.pdf' })
    const chat = () => screen.getByRole('complementary', { name: 'Chat' })

    // Stats is read with the chat closed; slides has it open.
    await showTopics()
    await fireEvent.click(sidebar.getByRole('button', { name: /^slides(?!\.pdf)/ }))
    await fireEvent.click(screen.getByRole('button', { name: 'Show chat' }))
    expect(chat()).toHaveClass('open')
    await fireEvent.click(sidebar.getByRole('button', { name: /^Stats/ }))
    expect(chat()).not.toHaveClass('open')
    await fireEvent.click(sidebar.getByRole('button', { name: /^slides(?!\.pdf)/ }))
    expect(chat()).toHaveClass('open')
  })

  it('opens the chat from New discussion under the open topic in the sidebar', async () => {
    renderOffline()
    await pick(pdf('slides.pdf'))
    await showTopics()
    const sidebar = within(screen.getByRole('complementary', { name: 'Topics' }))
    await fireEvent.click(sidebar.getByRole('button', { name: 'New discussion' }))
    expect(screen.getByRole('button', { name: 'Show topics' })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Chat' })).toHaveClass('open')
    // New discussion is an action, never marked as the open discussion.
    await showTopics()
    expect(sidebar.getByRole('button', { name: 'New discussion' }).parentElement).not.toHaveClass('active')
  })

  it('swaps the chat icon for the close button in the same corner, with the discussion title', async () => {
    renderOffline()
    await pick(pdf('slides.pdf'))
    const toggle = await screen.findByRole('button', { name: 'Show chat' })
    // An icon, not a word, and out of the way of the tab row while the chat is closed.
    expect(toggle).toHaveClass('icon-button')
    // Its only text is the styled tooltip.
    expect(toggle).toHaveTextContent('Chat C')
    expect(toggle.querySelector('.tip')).toHaveAttribute('aria-hidden', 'true')
    expect(toggle.querySelector('svg')).not.toBeNull()
    expect(toggle).not.toHaveClass('hidden')

    await fireEvent.click(toggle)
    expect(toggle).toHaveClass('hidden')
    expect((toggle as HTMLElement & { inert: boolean }).inert).toBe(true)
    const panel = within(screen.getByRole('complementary', { name: 'Chat' }))
    expect(panel.getByRole('button', { name: 'Close chat' })).toHaveClass('icon-button')
    // The title is the open discussion's, which opens the topic's list of discussions.
    // With nothing to switch to, it is just the title, without the arrow.
    expect(panel.getByRole('heading', { name: 'New chat' })).toHaveAttribute('title', 'New chat · slides')
    expect(panel.queryByRole('button', { name: /^Discussion:/ })).not.toBeInTheDocument()
    expect(panel.queryByRole('heading', { name: 'Chat' })).not.toBeInTheDocument()
    expect(panel.getByRole('button', { name: 'New chat' })).toHaveTextContent('New chat')

    await fireEvent.click(panel.getByRole('button', { name: 'Close chat' }))
    expect(toggle).not.toHaveClass('hidden')
  })
})

