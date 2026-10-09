import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App.svelte'

// PDF.js needs a real browser (canvas, workers), so tests stop at the loader.
vi.mock('./lib/pdfjs', () => ({ loadPdfjs: () => new Promise(() => {}) }))

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** Adding a PDF folds the sidebar away; open it again to use the topics. */
async function showTopics() {
  await fireEvent.click(screen.getByRole('button', { name: 'Show topics' }))
}

const pdf = (name: string, body = '%PDF-1.7') => new File([body], name, { type: 'application/pdf' })

function renderOffline() {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  return render(App)
}

async function pick(file: File) {
  await fireEvent.change(screen.getByTestId('file-input'), { target: { files: [file] } })
}

describe('App', () => {
  it('has no header: the title lives in the sidebar and the backend status is gone', () => {
    renderOffline()
    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
    expect(screen.queryByText(/Backend/)).not.toBeInTheDocument()
    const sidebar = within(screen.getByRole('complementary', { name: 'Topics' }))
    expect(sidebar.getByRole('heading', { name: 'doc-digest' })).toBeInTheDocument()
    expect(sidebar.getByRole('heading', { name: 'Topics' })).toBeInTheDocument()
  })

  it('asks for a PDF before one is open', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    render(App)
    expect(screen.getByText('Open a PDF to start reading.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Page number')).not.toBeInTheDocument()
  })

  it('opens a picked PDF and shows its name with page and zoom controls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    render(App)
    const file = new File(['%PDF-1.7'], 'chapter-3.pdf', { type: 'application/pdf' })
    await fireEvent.change(screen.getByTestId('file-input'), { target: { files: [file] } })
    expect(await screen.findByRole('tab', { name: 'chapter-3.pdf' })).toBeInTheDocument()
    expect(screen.getByLabelText('Page number')).toBeInTheDocument()
    expect(screen.getByLabelText('Zoom in')).toBeInTheDocument()
    expect(screen.getByTestId('pdf-viewer')).toBeInTheDocument()
  })

  it('refuses files that are not PDFs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    render(App)
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    await fireEvent.change(screen.getByTestId('file-input'), { target: { files: [file] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('notes.txt is not a PDF.')
    expect(screen.getByText('Open a PDF to start reading.')).toBeInTheDocument()
  })

  it('opens PDFs as tabs in a topic named after the first file', async () => {
    renderOffline()
    await pick(pdf('Lecture 4.pdf'))
    await screen.findByRole('tab', { name: 'Lecture 4.pdf' })
    await pick(pdf('Course book.pdf', '%PDF-1.7 book'))
    const book = await screen.findByRole('tab', { name: 'Course book.pdf' })
    await showTopics()

    const topics = within(screen.getByRole('complementary', { name: 'Topics' }))
    expect(topics.getByRole('button', { name: /^Lecture 4/ })).toHaveAttribute('aria-current', 'true')
    expect(topics.getAllByRole('listitem')).toHaveLength(1)
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
    await fireEvent.click(screen.getByRole('button', { name: /^slides/ }))
    expect(screen.getByRole('tab', { name: 'slides.pdf' })).toHaveAttribute('aria-selected', 'true')
  })

  it('deletes a topic after confirming', async () => {
    renderOffline()
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
    await pick(pdf('slides.pdf'))
    await screen.findByRole('tab', { name: 'slides.pdf' })
    await showTopics()
    await fireEvent.click(screen.getByRole('button', { name: 'Delete slides' }))
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
    expect(within(sidebar).queryByRole('heading', { name: 'doc-digest' })).not.toBeInTheDocument()
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
    await fireEvent.click(sidebar.getByRole('button', { name: 'Rename Statistics' }))
    const again = sidebar.getByLabelText('Topic name')
    await fireEvent.input(again, { target: { value: 'Stats' } })
    await fireEvent.submit(again)
    expect(sidebar.getByRole('button', { name: /^Stats/ })).toBeInTheDocument()
    expect(sidebar.getByRole('button', { name: 'Hide topics' })).toBeInTheDocument()
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

    await fireEvent.keyDown(within(panel).getByLabelText('Ask a question'), { key: 'Escape' })
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
    await fireEvent.click(screen.getByRole('button', { name: /^slides/ }))
    expect(panel.getByRole('log')).toHaveTextContent('Compare the two')
    expect(panel.getByLabelText('Ask a question')).toHaveValue('half typed')
  })

  it('opens the chat with Enter, unless Enter is meant for a button or a text box', async () => {
    renderOffline()
    await fireEvent.keyDown(document.body, { key: 'Enter' })
    const panel = screen.getByRole('complementary', { name: 'Chat' }) as HTMLElement & { inert: boolean }
    // No topic yet, so there is no chat to open.
    expect(panel.inert).toBe(true)

    await pick(pdf('slides.pdf'))
    await screen.findByRole('tab', { name: 'slides.pdf' })
    await fireEvent.keyDown(screen.getByLabelText('Page number'), { key: 'Enter' })
    await fireEvent.keyDown(screen.getByRole('button', { name: 'Show chat' }), { key: 'Enter' })
    expect(panel.inert).toBe(true)

    await fireEvent.keyDown(screen.getByRole('tabpanel', { name: 'slides.pdf' }), { key: 'Enter' })
    expect(panel.inert).toBe(false)
    expect(within(panel).getByLabelText('Ask a question')).toHaveFocus()

    // With the panel already open, Enter brings the cursor back to the question box.
    screen.getByRole('tabpanel', { name: 'slides.pdf' }).focus()
    ;(document.activeElement as HTMLElement).blur()
    await fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(within(panel).getByLabelText('Ask a question')).toHaveFocus()
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

  it('swaps the chat icon for the close button in the same corner, with just the topic name as title', async () => {
    renderOffline()
    await pick(pdf('slides.pdf'))
    const toggle = await screen.findByRole('button', { name: 'Show chat' })
    // An icon, not a word, and out of the way of the tab row while the chat is closed.
    expect(toggle).toHaveClass('icon-button')
    expect(toggle).toHaveTextContent('')
    expect(toggle.querySelector('svg')).not.toBeNull()
    expect(toggle).not.toHaveClass('hidden')

    await fireEvent.click(toggle)
    expect(toggle).toHaveClass('hidden')
    expect((toggle as HTMLElement & { inert: boolean }).inert).toBe(true)
    const panel = within(screen.getByRole('complementary', { name: 'Chat' }))
    expect(panel.getByRole('button', { name: 'Close chat' })).toHaveClass('icon-button')
    // The title is the topic's name, not the word Chat.
    expect(panel.getByRole('heading', { name: 'slides' })).toBeInTheDocument()
    expect(panel.queryByRole('heading', { name: 'Chat' })).not.toBeInTheDocument()
    expect(panel.getByRole('button', { name: 'New chat' })).toHaveTextContent('New chat')

    await fireEvent.click(panel.getByRole('button', { name: 'Close chat' }))
    expect(toggle).not.toHaveClass('hidden')
  })
})

