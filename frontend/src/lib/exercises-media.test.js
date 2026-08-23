import { describe, it, expect } from 'vitest'
import { imgCandidates, gifCandidates, EXDB } from './exercises.js'

describe('exercise media URLs', () => {
  const ex = EXDB.find(e => e.id === '0007') || EXDB[0]

  it('offers local then remote fallbacks for stills', () => {
    const urls = imgCandidates(ex)
    expect(urls[0]).toMatch(/img\//)
    expect(urls.some(u => u.includes('raw.githubusercontent.com'))).toBe(true)
    expect(urls.some(u => u.includes('cdn.jsdelivr.net'))).toBe(true)
    expect(urls.every(u => u.endsWith(ex.img))).toBe(true)
  })

  it('offers local then remote fallbacks for gifs', () => {
    const urls = gifCandidates(ex)
    expect(urls[0]).toMatch(/gif\//)
    expect(urls.some(u => u.includes('/videos/'))).toBe(true)
    expect(urls.every(u => u.endsWith(ex.gif))).toBe(true)
  })
})
