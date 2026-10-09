import { describe, expect, it } from 'vitest'
import { assetOptions } from './pdfjs'

describe('assetOptions', () => {
  it('points PDF.js at absolute asset directories', () => {
    const options = assetOptions()
    expect(options.wasmUrl).toBe(new URL('/pdfjs/wasm/', document.baseURI).href)
    for (const url of Object.values(options)) {
      expect(url).toMatch(/^http.*\/pdfjs\/\w+\/$/)
    }
  })
})
