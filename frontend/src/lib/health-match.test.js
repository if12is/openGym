import { describe, it, expect } from 'vitest'
import {
  gymWindow, hrWindow, localDayRange, overlapMs, GYM_WINDOW_CAP_MS, HR_PAD_MS,
  packSamples, unpackSamples, sliceSamples, downsample, hrStats, sessionSamples,
  zoneOf, zoneMinutes, hrReserve, trimp, density,
  splitCalories, cardioOutside, mainSleep, sleepSearchRange,
} from './health-match.js'

// Local time throughout — these rules are about calendar days as the user sees
// them, and a test written in UTC would pass in London and fail in Cairo.
const at = (y, m, d, hh = 0, mm = 0) => +new Date(y, m - 1, d, hh, mm, 0, 0)
const MIN = 60000

describe('gym window', () => {
  it('is start to end for a normal session', () => {
    const w = { d: '2026-08-24', start: at(2026, 8, 24, 18, 0), end: at(2026, 8, 24, 19, 15) }
    const g = gymWindow(w)
    expect(g.start).toBe(w.start)
    expect(g.end).toBe(w.end)
    expect(g.clamped).toBe(false)
  })

  it('caps a session left running overnight and says so', () => {
    // Nothing in the app closes an abandoned workout, so this is the normal
    // shape of "forgot to tap Finish", not an edge case.
    const start = at(2026, 8, 24, 18, 0)
    const w = { d: '2026-08-24', start, end: at(2026, 8, 25, 9, 0) }
    const g = gymWindow(w)
    expect(g.end).toBe(start + GYM_WINDOW_CAP_MS)
    expect(g.clamped).toBe(true)
  })

  it('falls back to the logged date when start is missing', () => {
    const g = gymWindow({ d: '2026-08-24' })
    expect(Number.isFinite(g.start)).toBe(true)
    expect(g.end).toBe(g.start)
  })
})

describe('heart-rate window vs calorie window', () => {
  const w = { d: '2026-08-24', start: at(2026, 8, 24, 18, 0), end: at(2026, 8, 24, 19, 0) }

  it('pads heart rate on both sides', () => {
    const hr = hrWindow(w)
    expect(hr.start).toBe(w.start - HR_PAD_MS)
    expect(hr.end).toBe(w.end + HR_PAD_MS)
  })

  // The bug this guards: padding the calorie query counts ten minutes of
  // non-gym burn INTO the gym bucket, and kcalOther subtracts them back out of
  // the rest of the day. The same minutes get moved twice.
  it('leaves the calorie window unpadded', () => {
    const g = gymWindow(w)
    expect(g.start).toBe(w.start)
    expect(g.end).toBe(w.end)
    expect(hrWindow(w).start).toBeLessThan(g.start)
  })
})

describe('local day range', () => {
  it('runs local midnight to local midnight', () => {
    const { start, end } = localDayRange('2026-08-24')
    expect(new Date(start).getHours()).toBe(0)
    expect(new Date(start).getDate()).toBe(24)
    expect(new Date(end).getDate()).toBe(25)
    expect(end - start).toBe(24 * 3600000)
  })

  it('handles a month boundary', () => {
    const { end } = localDayRange('2026-08-31')
    expect(new Date(end).getMonth()).toBe(8)   // September, 0-indexed
    expect(new Date(end).getDate()).toBe(1)
  })
})

describe('overlap', () => {
  it('measures the shared span', () => {
    expect(overlapMs({ start: 0, end: 100 }, { start: 50, end: 200 })).toBe(50)
  })
  it('is zero when disjoint', () => {
    expect(overlapMs({ start: 0, end: 10 }, { start: 20, end: 30 })).toBe(0)
  })
})

describe('samples', () => {
  const origin = at(2026, 8, 24, 18, 0)
  const samples = [
    { t: origin, bpm: 80 },
    { t: origin + 30000, bpm: 120 },
    { t: origin + 60000, bpm: 155 },
  ]

  it('packs relative and unpacks back', () => {
    const packed = packSamples(samples, origin)
    expect(packed).toEqual([[0, 80], [30000, 120], [60000, 155]])
    expect(unpackSamples(packed, origin)).toEqual(samples)
  })

  it('reads a stored session back through sessionSamples', () => {
    const session = { window: [origin, origin + 60000], samples: packSamples(samples, origin) }
    expect(sessionSamples(session)).toEqual(samples)
    expect(sessionSamples({})).toEqual([])
  })

  it('slices to a window', () => {
    expect(sliceSamples(samples, origin + 20000, origin + 40000)).toHaveLength(1)
  })

  it('reports stats over the full trace', () => {
    expect(hrStats(samples)).toMatchObject({ avg: 118, max: 155, min: 80, n: 3 })
    expect(hrStats([])).toBeNull()
  })

  it('downsamples to the cap without inventing points', () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ t: origin + i * 1000, bpm: 100 + (i % 20) }))
    const out = downsample(many, 240)
    expect(out.length).toBeLessThanOrEqual(240)
    expect(out[0].t).toBeGreaterThanOrEqual(origin)
    expect(out[out.length - 1].t).toBeLessThanOrEqual(many[many.length - 1].t)
  })

  it('leaves a short trace alone', () => {
    expect(downsample(samples, 240)).toBe(samples)
  })
})

describe('zones', () => {
  // Reserve, not raw percentage: rhr 50, max 190 → reserve span 140.
  const hrMax = 190, rhr = 50

  it('places a reading by heart-rate reserve', () => {
    expect(hrReserve(120, hrMax, rhr)).toBeCloseTo(0.5, 5)
    expect(zoneOf(100, hrMax, rhr)).toBe(0)    // .357 — recovery
    expect(zoneOf(125, hrMax, rhr)).toBe(1)    // .536 — warm-up
    expect(zoneOf(140, hrMax, rhr)).toBe(2)    // .643 — fat burn
    expect(zoneOf(150, hrMax, rhr)).toBe(3)    // .714 — past the .70 cardio edge
    expect(zoneOf(185, hrMax, rhr)).toBe(4)    // .964 — peak
  })

  it('degrades to zone 0 rather than dividing by zero', () => {
    expect(zoneOf(120, 60, 60)).toBe(0)
  })

  it('counts minutes from the real gaps between samples', () => {
    const t0 = at(2026, 8, 24, 18, 0)
    const s = [
      { t: t0, bpm: 100 },
      { t: t0 + 2 * MIN, bpm: 100 },
      { t: t0 + 4 * MIN, bpm: 180 },
    ]
    const z = zoneMinutes(s, hrMax, rhr)
    expect(z[0]).toBeCloseTo(4, 1)   // two 2-minute gaps at 100 bpm
    expect(z.reduce((a, b) => a + b, 0)).toBeCloseTo(4, 1)
  })

  // A watch that stops reporting while the wrist is still would otherwise turn
  // a coffee break into "40 minutes in zone 2".
  it('ignores gaps longer than five minutes', () => {
    const t0 = at(2026, 8, 24, 18, 0)
    const s = [{ t: t0, bpm: 100 }, { t: t0 + 40 * MIN, bpm: 100 }]
    expect(zoneMinutes(s, hrMax, rhr).reduce((a, b) => a + b, 0)).toBe(0)
  })
})

describe('session load', () => {
  const hrMax = 190, rhr = 50
  const t0 = at(2026, 8, 24, 18, 0)
  const trace = (bpm, minutes) =>
    Array.from({ length: minutes + 1 }, (_, i) => ({ t: t0 + i * MIN, bpm }))

  it('scores a harder session above an easier one of the same length', () => {
    expect(trimp(trace(160, 30), hrMax, rhr)).toBeGreaterThan(trimp(trace(110, 30), hrMax, rhr))
  })

  it('scores a longer session above a shorter one at the same intensity', () => {
    expect(trimp(trace(150, 60), hrMax, rhr)).toBeGreaterThan(trimp(trace(150, 20), hrMax, rhr))
  })

  it('is zero without a usable reserve', () => {
    expect(trimp(trace(150, 30), 60, 60)).toBe(0)
    expect(trimp([], hrMax, rhr)).toBe(0)
  })

  it('reports work per minute', () => {
    expect(density(6000, 60 * MIN)).toBe(100)
    expect(density(6000, 0)).toBe(0)
  })
})

describe('calorie split', () => {
  it('splits a day into gym, watch cardio and everything else', () => {
    const out = splitCalories({ kcalDay: 900, kcalGym: 300, cardio: [{ kcal: 200 }] })
    expect(out).toMatchObject({ gym: 300, cardio: 200, other: 400, total: 900 })
  })

  // Two writers (the phone's own counter and the watch bridge) can disagree, and
  // a window aggregate is not guaranteed to nest inside a day aggregate. A
  // negative "rest of day" is an artefact, not a fact worth rendering.
  it('never reports negative rest-of-day', () => {
    const out = splitCalories({ kcalDay: 100, kcalGym: 400, cardio: [] })
    expect(out.other).toBe(0)
    expect(out.total).toBe(400)
  })

  it('handles an empty day', () => {
    expect(splitCalories({})).toMatchObject({ gym: 0, cardio: 0, other: 0, total: 0 })
  })
})

describe('cardio outside the gym', () => {
  const gym = { start: at(2026, 8, 24, 18, 0), end: at(2026, 8, 24, 19, 0) }

  it('keeps a morning run', () => {
    const out = cardioOutside([{ start: at(2026, 8, 24, 6, 0), end: at(2026, 8, 24, 6, 40), type: 'running', kcal: 320 }], gym)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'running', min: 40, kcal: 320 })
  })

  // Treadmill work started from the watch during the gym visit is the gym visit.
  it('drops a session that mostly overlaps the gym window', () => {
    const out = cardioOutside([{ start: at(2026, 8, 24, 18, 10), end: at(2026, 8, 24, 18, 40), type: 'running' }], gym)
    expect(out).toHaveLength(0)
  })

  it('keeps a session that only clips the edge', () => {
    const out = cardioOutside([{ start: at(2026, 8, 24, 17, 0), end: at(2026, 8, 24, 18, 10), type: 'walking' }], gym)
    expect(out).toHaveLength(1)
  })

  it('ignores zero-length records', () => {
    expect(cardioOutside([{ start: 1, end: 1 }], gym)).toHaveLength(0)
    expect(cardioOutside(null, gym)).toEqual([])
  })
})

describe('which night belongs to which day', () => {
  it('searches from 18:00 the day before to noon', () => {
    const r = sleepSearchRange('2026-08-24')
    expect(new Date(r.start).getDate()).toBe(23)
    expect(new Date(r.start).getHours()).toBe(18)
    expect(new Date(r.end).getDate()).toBe(24)
    expect(new Date(r.end).getHours()).toBe(12)
  })

  // The rule anchors on when you woke up, not when you fell asleep — that is the
  // day whose training the night affects.
  it('assigns a night that crosses midnight to the morning it ends in', () => {
    const s = [{ start: at(2026, 8, 23, 23, 30), end: at(2026, 8, 24, 7, 0) }]
    expect(mainSleep(s, '2026-08-24')).toMatchObject({ min: 450 })
    expect(mainSleep(s, '2026-08-23')).toBeNull()
  })

  it('prefers the long night over an afternoon nap', () => {
    const s = [
      { start: at(2026, 8, 24, 14, 0), end: at(2026, 8, 24, 15, 0) },     // nap — ends after noon
      { start: at(2026, 8, 24, 1, 0), end: at(2026, 8, 24, 6, 30) },      // the night
    ]
    expect(mainSleep(s, '2026-08-24').min).toBe(330)
  })

  it('picks the longest when two sessions both qualify', () => {
    const s = [
      { start: at(2026, 8, 24, 3, 0), end: at(2026, 8, 24, 4, 0) },
      { start: at(2026, 8, 23, 23, 0), end: at(2026, 8, 24, 6, 0) },
    ]
    expect(mainSleep(s, '2026-08-24').min).toBe(420)
  })

  it('reports efficiency only when stages were recorded', () => {
    const withStages = [{ start: at(2026, 8, 24, 0, 0), end: at(2026, 8, 24, 8, 0), asleepMin: 420 }]
    expect(mainSleep(withStages, '2026-08-24').eff).toBe(88)
    const without = [{ start: at(2026, 8, 24, 0, 0), end: at(2026, 8, 24, 8, 0) }]
    expect(mainSleep(without, '2026-08-24').eff).toBeNull()
  })

  it('returns null with nothing recorded', () => {
    expect(mainSleep([], '2026-08-24')).toBeNull()
    expect(mainSleep(null, '2026-08-24')).toBeNull()
  })
})
