import { describe, it, expect } from 'vitest'
import { FONTS, DEFAULT_FONT, fontOf, fontFamilyCss } from './fonts.js'

describe('fonts', () => {
  it('defaults to Cairo', () => {
    expect(DEFAULT_FONT).toBe('cairo')
    expect(fontOf('nope').id).toBe('cairo')
    expect(fontOf('tajawal').family).toBe('Tajawal')
  })
  it('quotes the CSS family name', () => {
    expect(fontFamilyCss('ibmPlex')).toContain('IBM Plex Sans Arabic')
  })
  it('lists the shipped Arabic faces', () => {
    expect(Object.keys(FONTS)).toEqual([
      'cairo', 'tajawal', 'almarai', 'ibmPlex', 'notoKufi', 'notoNaskh', 'changa', 'elMessiri', 'amiri',
    ])
  })
})
