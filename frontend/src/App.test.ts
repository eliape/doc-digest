import { fireEvent, render, screen, within } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App.svelte'

// PDF.js needs a real browser (canvas, workers), so tests stop at the loader.
vi.mock('./lib/pdfjs', () => ({ loadPdfjs: () => new Promise(() => {}) }))

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

const pdf = (name: string, body = '%PDF-1.7') => new File([body], name, { type: 'application/pdf' })

function renderOffline() {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  return render(App)
}

async function pick(file: File) {
  await fireEvent.change(screen.getByTestId('file-input'), { target: { files: [file] } })
}

describe('App', () => {
  it('shows the backend as connected when /api/health is ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }))))
    render(App)
    expect(screen.getByRole('heading', { name: 'doc-digest' })).toBeInTheDocument()
    expect(await screen.findByText(/connected/)).toBeInTheDocument()
  })

  it('shows the backend as not reachable when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    render(App)
    expect(await screen.findByText(/not reachable/)).toBeInTheDocument()
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

    await fireEvent.click(screen.getByRole('button', { name: /^slides/ }))
    expect(screen.getByRole('tab', { name: 'slides.pdf' })).toHaveAttribute('aria-selected', 'true')
  })

  it('deletes a topic after confirming', async () => {
    renderOffline()
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
    await pick(pdf('slides.pdf'))
    await screen.findByRole('tab', { name: 'slides.pdf' })
    await fireEvent.click(screen.getByRole('button', { name: 'Delete slides' }))
    expect(confirm).toHaveBeenCalledWith('Delete “slides” and close its PDF?')
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.getByText('Open a PDF to start reading.')).toBeInTheDocument()
  })

  it('collapses and expands the topics sidebar, remembering the choice', async () => {
    renderOffline()
    const toggle = screen.getByRole('button', { name: 'Hide topics' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await fireEvent.click(toggle)
    expect(screen.queryByRole('complementary', { name: 'Topics' })).not.toBeInTheDocument()
    expect(localStorage.getItem('doc-digest.sidebarOpen')).toBe('false')
    await fireEvent.click(screen.getByRole('button', { name: 'Show topics' }))
    expect(screen.getByRole('complementary', { name: 'Topics' })).toBeInTheDocument()
  })
})
