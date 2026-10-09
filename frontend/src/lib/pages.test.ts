import { describe, expect, it } from 'vitest'
import { formatScale, isPdfFile, parsePageInput } from './pages'

describe('parsePageInput', () => {
  it('accepts a page in range', () => {
    expect(parsePageInput(' 3 ', 10)).toBe(3)
  })

  it('clamps pages outside the document', () => {
    expect(parsePageInput('0', 10)).toBe(1)
    expect(parsePageInput('99', 10)).toBe(10)
  })

  it('rejects text, fractions and empty documents', () => {
    expect(parsePageInput('abc', 10)).toBeNull()
    expect(parsePageInput('2.5', 10)).toBeNull()
    expect(parsePageInput('', 10)).toBeNull()
    expect(parsePageInput('1', 0)).toBeNull()
  })
})

describe('formatScale', () => {
  it('shows a percentage', () => {
    expect(formatScale(1)).toBe('100%')
    expect(formatScale(1.256)).toBe('126%')
  })
})

describe('isPdfFile', () => {
  it('recognises PDFs by type or extension', () => {
    expect(isPdfFile(new File([], 'a.bin', { type: 'application/pdf' }))).toBe(true)
    expect(isPdfFile(new File([], 'Notes.PDF'))).toBe(true)
    expect(isPdfFile(new File([], 'notes.txt', { type: 'text/plain' }))).toBe(false)
  })
})
