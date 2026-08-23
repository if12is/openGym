import { describe, it, expect } from 'vitest'
import ar from '../instr/ar.js'
import { EXDB } from './exercises-data.js'
import { translateExName } from './exName.js'

describe('Arabic exercise pack', () => {
  it('covers every catalogue exercise with Arabic steps', () => {
    const missing = EXDB.filter(e => !ar[e.id] || !ar[e.id].length).map(e => e.id)
    expect(missing).toEqual([])
  })

  it('has Arabic text for alternate lateral pulldown', () => {
    const steps = ar['0007']
    expect(steps[0]).toMatch(/[\u0600-\u06FF]/)
    expect(steps[0]).not.toMatch(/Sit on the cable/)
  })

  it('leaves already-Arabic custom names alone', () => {
    expect(translateExName('سكوات دمبل')).toBe('سكوات دمبل')
  })
})
