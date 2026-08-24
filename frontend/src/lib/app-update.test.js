import { describe, it, expect } from 'vitest'
import { isNewer } from './app-update.js'

describe('isNewer', () => {
  it('detects a higher remote versionCode', () => {
    expect(isNewer({ versionCode: 10 }, { versionCode: 9 })).toBe(true)
    expect(isNewer({ versionCode: 9 }, { versionCode: 9 })).toBe(false)
    expect(isNewer({ versionCode: 8 }, { versionCode: 9 })).toBe(false)
  })
})
