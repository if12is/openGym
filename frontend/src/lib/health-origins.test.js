import { describe, it, expect } from 'vitest'
import {
  pickWatchOrigin, originLabel, isPhoneOrigin,
  HEALTH_SYNC_PKG, HONOR_HEALTH_PKG,
} from './health-origins.js'

describe('pickWatchOrigin', () => {
  it('prefers Health Sync over Honor Health and the phone', () => {
    expect(pickWatchOrigin([
      'com.android.healthconnect.phone',
      HONOR_HEALTH_PKG,
      HEALTH_SYNC_PKG,
    ])).toBe(HEALTH_SYNC_PKG)
  })

  it('falls back to Honor Health when Health Sync is not writing', () => {
    expect(pickWatchOrigin([HONOR_HEALTH_PKG, 'com.android.healthconnect.phone']))
      .toBe(HONOR_HEALTH_PKG)
  })

  it('does not pick the phone when a watch writer is present', () => {
    expect(isPhoneOrigin('com.android.healthconnect.phone')).toBe(true)
    expect(pickWatchOrigin(['com.android.healthconnect.phone'])).toBe('com.android.healthconnect.phone')
  })

  it('accepts { pkg } objects from listOrigins', () => {
    expect(pickWatchOrigin([{ pkg: HEALTH_SYNC_PKG, label: 'Health Sync' }])).toBe(HEALTH_SYNC_PKG)
  })

  it('names the known writers', () => {
    expect(originLabel(HEALTH_SYNC_PKG)).toBe('Health Sync')
    expect(originLabel('com.android.healthconnect.phone')).toBe('Phone')
  })
})
