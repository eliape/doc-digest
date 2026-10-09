import { fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App.svelte'

// PDF.js needs a real browser (canvas, workers), so tests stop at the loader.
vi.mock('./lib/pdfjs', () => ({ loadPdfjs: () => new Promise(() => {}) }))

afterEach(() => vi.unstubAllGlobals())

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
    expect(await screen.findByText('chapter-3.pdf')).toBeInTheDocument()
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
})
