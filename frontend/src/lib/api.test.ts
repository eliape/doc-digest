import { describe, expect, it } from 'vitest'
import { fetchAnswer } from './api'

const request = { topic: 'T', messages: [{ role: 'user' as const, text: 'hi' }] }

/** A fake fetch whose response body arrives in the given chunks. */
function respond(chunks: string[], init: ResponseInit = {}) {
  return (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
          controller.close()
        },
      }),
      init,
    )) as unknown as typeof fetch
}

async function collect<T>(stream: AsyncIterable<T>) {
  const pieces: T[] = []
  for await (const piece of stream) pieces.push(piece)
  return pieces
}

describe('fetchAnswer', () => {
  it('yields text pieces, even when a line is split across chunks', async () => {
    const fetchFn = respond([
      '{"type":"step","text":"Searched"}\n{"type":"text","text":"Hel"}\n{"type":"te',
      'xt","text":"lo"}\n{"type":"done","seconds":2}\n',
    ])
    expect(await collect(fetchAnswer(request, undefined, fetchFn))).toEqual([
      { type: 'step', text: 'Searched' },
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
    ])
  })

  it('throws the error the backend reports in the stream', async () => {
    const fetchFn = respond(['{"type":"text","text":"Par"}\n{"type":"error","message":"Rate limited"}\n'])
    await expect(collect(fetchAnswer(request, undefined, fetchFn))).rejects.toThrow('Rate limited')
  })

  it('throws the reason the backend refused the request', async () => {
    const fetchFn = respond(['{"detail":"No API key: add ANTHROPIC_API_KEY"}'], { status: 503 })
    await expect(collect(fetchAnswer(request, undefined, fetchFn))).rejects.toThrow('No API key')
  })

  it('throws when the answer stops without finishing', async () => {
    const fetchFn = respond(['{"type":"text","text":"Par"}\n'])
    await expect(collect(fetchAnswer(request, undefined, fetchFn))).rejects.toThrow('stopped before')
  })
})
