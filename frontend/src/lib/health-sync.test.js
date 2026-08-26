import { describe, it, expect, vi, beforeEach } from 'vitest'
import { updateConn, updateHealth } from './health-store.js'
import { isoOf } from './format.js'
import { logLine } from './health-pull-log.js'

const order = []
const hold = {}
let mode = 'ok'

vi.mock('./health-connect.js', () => ({
  aggregate: async () => {
    order.push('agg')
    if (hold.agg) await hold.agg
    if (mode === 'timeout') return { ok: false, reason: 'timeout' }
    return { ok: true, steps: 1200, activeCalories: 10, totalCalories: 20 }
  },
  readSleep: async () => {
    order.push('sleep')
    if (mode === 'timeout') return { ok: false, reason: 'timeout' }
    return { ok: true, sessions: [] }
  },
  readRestingHeartRate: async () => {
    order.push('rhr')
    if (mode === 'timeout') return { ok: false, reason: 'timeout' }
    return { ok: true, samples: [{ t: 1, bpm: 54 }] }
  },
  readRecovery: async () => {
    order.push('rec')
    if (mode === 'timeout') return { ok: false, reason: 'timeout' }
    return { ok: true, spo2: [], hrv: [] }
  },
  readHeartRate: async () => ({ ok: true, samples: [] }),
  readExerciseSessions: async () => ({ ok: true, sessions: [] }),
}))

const { syncDay, syncRecentDays, bootHealth, resetPullSkips } = await import('./health-sync.js')

beforeEach(() => {
  order.length = 0
  hold.agg = null
  mode = 'ok'
  resetPullSkips()
  updateHealth(h => {
    h.days = {}
    h.conn.state = 'ok'
  })
})

describe('syncDay', () => {
  it('reads one metric after another, not all at once', async () => {
    let release
    hold.agg = new Promise(r => { release = r })
    const pending = syncDay(isoOf(new Date()))
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['agg'])
    release()
    await pending
    expect(order).toEqual(['agg', 'agg', 'sleep', 'rhr', 'rec'])
  })

  it('does not re-query steps when today already has them from the probe', async () => {
    const iso = isoOf(new Date())
    updateHealth(h => { h.days[iso] = { steps: 13331 } })
    await syncDay(iso)
    // Calories still run once; steps are not asked again.
    expect(order.filter(x => x === 'agg')).toHaveLength(1)
  })
})

describe('syncRecentDays', () => {
  it('reports progress on the first read, not after the day finishes', async () => {
    const seen = []
    let release
    hold.agg = new Promise(r => { release = r })
    const pending = syncRecentDays(1, (frac, info) => seen.push({ frac, info }))
    await Promise.resolve()
    await Promise.resolve()
    expect(seen.some(s => s.info?.state === 'start' && s.info?.kind === 'steps')).toBe(true)
    expect(seen.some(s => s.frac === 1)).toBe(false)
    release()
    await pending
    expect(seen.some(s => s.info?.step === 'done')).toBe(true)
  })

  it('stops after the first day if every read times out', async () => {
    mode = 'timeout'
    const seen = []
    const n = await syncRecentDays(3, (_frac, info) => seen.push(info))
    expect(n).toBe(0)
    expect(seen.some(s => s?.step === 'stopped')).toBe(true)
    expect(order.filter(x => x === 'agg')).toHaveLength(2)
    expect(order.filter(x => x === 'sleep')).toHaveLength(1)
  })
})

describe('logLine', () => {
  it('names a timed-out read', () => {
    expect(logLine({
      step: 'read', kind: 'steps', iso: '2099-01-01', state: 'fail', reason: 'timeout',
    })).toBe('step count for 2099-01-01 failed: timeout')
  })

  it('shows a successful steps probe', () => {
    expect(logLine({
      step: 'probe', state: 'ok', records: 3, steps: 8400,
      origins: ['com.healthsync'], ms: 220,
    })).toBe('Probe: 3 records, 8400 steps from com.healthsync (220 ms)')
  })

  it('names Health Sync when that is the chosen origin', () => {
    expect(logLine({
      step: 'probe', state: 'ok', records: 80, steps: 7000,
      origin: 'nl.appyhapps.healthsync',
      origins: ['nl.appyhapps.healthsync', 'com.hihonor.health'],
      ms: 98,
    })).toBe('Probe: 80 records, 7000 steps from Health Sync (98 ms)')
  })

  it('starts the pull on a steps read, not a permission check', () => {
    expect(logLine({ step: 'probe', state: 'start' })).toBe('Testing a one-day steps read…')
    expect(logLine({ step: 'probe', state: 'start' })).not.toBe('Checking permissions…')
  })
})

describe('bootHealth', () => {
  it('does not touch Health Connect when the link is off', async () => {
    updateConn(c => { c.state = 'off' })
    await expect(bootHealth([])).resolves.toBe(false)
  })
})
