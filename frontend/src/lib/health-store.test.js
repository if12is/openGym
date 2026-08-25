import { describe, it, expect } from 'vitest'
import { mapAvailabilityReason } from './health-reasons.js'

describe('mapAvailabilityReason', () => {
  it('keeps Huawei-specific failures intact', () => {
    expect(mapAvailabilityReason('no-hms')).toBe('no-hms')
    expect(mapAvailabilityReason('no-health-app')).toBe('no-health-app')
    expect(mapAvailabilityReason('not-configured')).toBe('not-configured')
  })

  it('maps Health Connect status codes', () => {
    expect(mapAvailabilityReason('update-required')).toBe('update')
    expect(mapAvailabilityReason('not-installed')).toBe('unavailable')
    expect(mapAvailabilityReason('timeout')).toBe('timeout')
    expect(mapAvailabilityReason('no-bind')).toBe('no-bind')
    expect(mapAvailabilityReason('need-permission')).toBe('need-permission')
    expect(mapAvailabilityReason('no-picker')).toBe('no-picker')
  })

  it('falls back on unknown strings', () => {
    expect(mapAvailabilityReason('mystery')).toBe('unavailable')
    expect(mapAvailabilityReason('mystery', 'denied')).toBe('denied')
  })
})
