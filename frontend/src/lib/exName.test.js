import { describe, it, expect } from 'vitest'
import { translateExName } from './exName.js'

describe('translateExName', () => {
  it('translates the pulldown from the exercise screen', () => {
    expect(translateExName('alternate lateral pulldown')).toBe('متناوب سحب جانبي')
  })
  it('keeps common gym names readable', () => {
    expect(translateExName('barbell bench press')).toMatch(/بنش/)
    expect(translateExName('dumbbell curl')).toMatch(/كيرل/)
  })
  it('drops leftover male/female tags from the dataset', () => {
    expect(translateExName('male bench press')).not.toMatch(/male/)
  })
})
