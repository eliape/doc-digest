/** Turn what the user typed into the page box into a valid page number, or null. */
export function parsePageInput(input: string, pageCount: number): number | null {
  const trimmed = input.trim()
  const page = Number(trimmed)
  if (trimmed === '' || !Number.isInteger(page) || pageCount < 1) return null
  return Math.min(Math.max(page, 1), pageCount)
}

/** Format a PDF.js scale (1 = 100%) for display. */
export function formatScale(scale: number): string {
  return `${Math.round(scale * 100)}%`
}

/** Whether a dropped or picked file looks like a PDF. */
export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
}
