import { afterEach, describe, expect, it } from 'vitest'
import { openingScale, progress, saveZoomFollowsChat, savedZoomFollowsChat } from './chatZoom'

describe('openingScale', () => {
  it('opens a little bigger than fits beside the chat', () => {
    expect(openingScale(2, 1)).toBe(1.15)
  })

  it('never opens wider than the viewer', () => {
    expect(openingScale(1.1, 1)).toBe(1.1)
  })

  it('rounds down to whole percents', () => {
    expect(openingScale(3, 0.987)).toBe(1.13)
  })
})

describe('progress', () => {
  it('goes from 0 to 1 as the width shrinks', () => {
    expect(progress(1000, 600, 1000)).toBe(0)
    expect(progress(1000, 600, 800)).toBe(0.5)
    expect(progress(1000, 600, 600)).toBe(1)
  })

  it('goes from 0 to 1 as the width grows, and stays within', () => {
    expect(progress(600, 1000, 700)).toBe(0.25)
    expect(progress(600, 1000, 1100)).toBe(1)
    expect(progress(600, 1000, 500)).toBe(0)
  })

  it('is done when there is nowhere to go', () => {
    expect(progress(800, 800, 800)).toBe(1)
  })
})

describe('the setting', () => {
  afterEach(() => localStorage.clear())

  it('is on until turned off, and remembered', () => {
    expect(savedZoomFollowsChat()).toBe(true)
    saveZoomFollowsChat(false)
    expect(savedZoomFollowsChat()).toBe(false)
    saveZoomFollowsChat(true)
    expect(savedZoomFollowsChat()).toBe(true)
  })
})
