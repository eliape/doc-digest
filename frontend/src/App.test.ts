import { render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App.svelte'

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
})
