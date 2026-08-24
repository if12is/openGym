import { describe, it, expect } from 'vitest'
import {
  lastDays, estimateHrMax, computeBaselines, trainingLoad,
  readiness, overloadFlag, hrRecovery, suggestRest, pearson, sleepVsVolume, prContext,
  muscleRecovery, recoveryLevels, RECOVERY_MAX_H, energyBalance,
} from './health-insights.js'
import { isoOf } from './format.js'

const at = (y, m, d, hh = 0, mm = 0) => +new Date(y, m - 1, d, hh, mm, 0, 0)
const TODAY = '2026-08-24'

// A fortnight of unremarkable days, so a test can move one thing and see what it
// does to the score.
const steadyDays = (over = {}) => {
  const days = {}
  for (let i = 1; i <= 28; i++) {
    const d = new Date(at(2026, 8, 24)); d.setDate(d.getDate() - i)
    const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    days[iso] = { sleepMin: 420, rhr: 55, steps: 8000, kcalActive: 500 }
  }
  return { ...days, ...over }
}

describe('lastDays', () => {
  it('walks back from the given day, excluding it', () => {
    const days = steadyDays({ [TODAY]: { sleepMin: 1 } })
    const out = lastDays(days, TODAY, 7)
    expect(out).toHaveLength(7)
    expect(out.every(d => d.sleepMin === 420)).toBe(true)
  })

  it('thins rather than shifts when days are missing', () => {
    expect(lastDays({}, TODAY, 7)).toHaveLength(0)
  })
})

describe('observed max heart rate', () => {
  // The single highest reading of a training block is the most likely to be a
  // loose-strap artefact, so with enough samples the runner-up is used.
  it('takes the second highest once there are three or more', () => {
    const sessions = { a: { hrMax: 210 }, b: { hrMax: 186 }, c: { hrMax: 180 } }
    expect(estimateHrMax(sessions)).toBe(186)
  })

  it('takes the highest when there is barely any data', () => {
    expect(estimateHrMax({ a: { hrMax: 180 } })).toBe(180)
    expect(estimateHrMax({ a: { hrMax: 180 }, b: { hrMax: 175 } })).toBe(180)
  })

  it('is null with nothing to go on', () => {
    expect(estimateHrMax({})).toBeNull()
  })
})

describe('baselines', () => {
  it('averages the recent window and counts how much it had', () => {
    const base = computeBaselines(steadyDays(), {}, TODAY)
    expect(base.rhr7).toBe(55)
    expect(base.sleep14).toBe(420)
    expect(base.days7).toBe(7)
    expect(base.days28).toBe(28)
  })

  it('survives an empty history', () => {
    const base = computeBaselines({}, {}, TODAY)
    expect(base.rhr7).toBeNull()
    expect(base.sleep14).toBeNull()
  })
})

describe('training load', () => {
  const workouts = Array.from({ length: 8 }, (_, i) => {
    const d = new Date(at(2026, 8, 24, 18)); d.setDate(d.getDate() - i * 3)
    return { id: 'w' + i, start: +d, vol: 6000 }
  })

  it('prefers a measured TRIMP over the volume proxy', () => {
    const sessions = Object.fromEntries(workouts.map(w => [w.id, { trimp: 100 }]))
    const withTrimp = trainingLoad(sessions, workouts, TODAY)
    const withoutTrimp = trainingLoad({}, workouts, TODAY)
    expect(withTrimp.acute).toBeGreaterThan(withoutTrimp.acute)
  })

  // A week with no watch data must not read as zero load — every ratio built on
  // it would then look like a spike.
  it('still reports load when no session was measured', () => {
    expect(trainingLoad({}, workouts, TODAY).acute).toBeGreaterThan(0)
  })

  it('has no ratio without a chronic baseline', () => {
    expect(trainingLoad({}, [], TODAY).ratio).toBeNull()
  })
})

describe('readiness', () => {
  const base = { sleep14: 420, rhr7: 55 }
  const normalLoad = { ratio: 1.0 }

  it('is null when there is nothing to score', () => {
    expect(readiness({}, base, {})).toBeNull()
    expect(readiness(null, null, null)).toBeNull()
  })

  it('scores a well-slept, well-rested, normally-loaded day high', () => {
    const r = readiness({ sleepMin: 440, rhr: 53 }, base, normalLoad)
    expect(r.score).toBeGreaterThanOrEqual(75)
    expect(r.band).toBe('go')
    expect(r.confidence).toBe(1)
  })

  it('drops the score when the night was short and the pulse is up', () => {
    const r = readiness({ sleepMin: 270, rhr: 64 }, base, { ratio: 1.7 })
    expect(r.score).toBeLessThan(40)
    expect(['easy', 'rest']).toContain(r.band)
  })

  // A score built on one input out of three is not the same number as one built
  // on all three, and the UI leans on this to say so.
  it('reports partial confidence when inputs are missing', () => {
    const r = readiness({ sleepMin: 420 }, base, null)
    expect(r.confidence).toBeLessThan(0.5)
    expect(r.parts).toHaveLength(1)
  })

  it('falls back to a seven-hour target with no sleep baseline', () => {
    const r = readiness({ sleepMin: 420 }, {}, null)
    expect(r.parts[0].target).toBe(420)
    expect(r.score).toBeGreaterThan(70)
  })

  it('treats an undertrained week as less than ideal but not alarming', () => {
    const low = readiness({ sleepMin: 420, rhr: 55 }, base, { ratio: 0.2 })
    const ok = readiness({ sleepMin: 420, rhr: 55 }, base, { ratio: 1.0 })
    expect(low.score).toBeLessThan(ok.score)
    expect(low.score).toBeGreaterThan(50)
  })
})

describe('overload flag', () => {
  const base = { sleep14: 420, rhr7: 55, trimpTypical: 90 }

  it('stays quiet on a single signal', () => {
    expect(overloadFlag({ sleepMin: 300, rhr: 55 }, base, { ratio: 1 }, [])).toBeNull()
  })

  it('fires when two signals line up', () => {
    const f = overloadFlag({ sleepMin: 300, rhr: 62 }, base, { ratio: 1 }, [])
    expect(f.reasons).toContain('rhr')
    expect(f.reasons).toContain('sleep')
  })

  it('counts two hard sessions back to back', () => {
    const f = overloadFlag({ sleepMin: 420, rhr: 62 }, base, { ratio: 1 },
      [{ trimp: 150 }, { trimp: 160 }])
    expect(f.reasons).toContain('backToBack')
  })

  it('needs a day to judge', () => {
    expect(overloadFlag(null, base, {}, [])).toBeNull()
  })
})

describe('muscle recovery', () => {
  const NOW = at(2026, 8, 24, 18, 0)
  const base = { sleep14: 420 }
  const hoursAgo = h => NOW - h * 3600000

  it('is fully recovered once enough time has passed', () => {
    const r = muscleRecovery({ chest: { sets: 6, at: hoursAgo(96) } }, {}, base, NOW)
    expect(r.chest.pct).toBe(100)
  })

  it('is barely started right after a session', () => {
    const r = muscleRecovery({ chest: { sets: 6, at: hoursAgo(2) } }, {}, base, NOW)
    expect(r.chest.pct).toBeLessThan(10)
    expect(r.chest.sets).toBe(6)
    expect(r.chest.hoursSince).toBe(2)
  })

  // More work needs more time — 20 hard sets is not the same ask as 2.
  it('gives a heavier session a longer window', () => {
    const light = muscleRecovery({ chest: { sets: 2, at: hoursAgo(30) } }, {}, base, NOW)
    const heavy = muscleRecovery({ chest: { sets: 14, at: hoursAgo(30) } }, {}, base, NOW)
    expect(light.chest.pct).toBeGreaterThan(heavy.chest.pct)
  })

  it('caps the window so nothing stays cooked forever', () => {
    const r = muscleRecovery({ chest: { sets: 99, at: hoursAgo(RECOVERY_MAX_H + 1) } }, {}, base, NOW)
    expect(r.chest.pct).toBe(100)
  })

  // The reason this belongs to the watch: the same 30 hours are not the same
  // 30 hours if they were slept through badly.
  it('slows recovery after short nights', () => {
    const days = {}
    for (let i = 0; i < 4; i++) {
      const d = new Date(NOW); d.setDate(d.getDate() - i)
      days[isoOf(d)] = { sleepMin: 280 }
    }
    const rested = muscleRecovery({ chest: { sets: 8, at: hoursAgo(40) } }, {}, base, NOW)
    const tired = muscleRecovery({ chest: { sets: 8, at: hoursAgo(40) } }, days, base, NOW)
    expect(tired.chest.pct).toBeLessThan(rested.chest.pct)
    expect(tired.chest.slowedBySleep).toBe(true)
    expect(rested.chest.slowedBySleep).toBe(false)
  })

  it('gives no credit for sleeping more than usual', () => {
    const days = {}
    for (let i = 0; i < 4; i++) {
      const d = new Date(NOW); d.setDate(d.getDate() - i)
      days[isoOf(d)] = { sleepMin: 600 }
    }
    const long = muscleRecovery({ chest: { sets: 8, at: hoursAgo(30) } }, days, base, NOW)
    const normal = muscleRecovery({ chest: { sets: 8, at: hoursAgo(30) } }, {}, base, NOW)
    expect(long.chest.pct).toBe(normal.chest.pct)
  })

  it('ignores entries with no timestamp', () => {
    expect(muscleRecovery({ chest: { sets: 6 } }, {}, base, NOW)).toEqual({})
    expect(muscleRecovery(null, {}, base, NOW)).toEqual({})
  })

  it('maps percentages onto shading steps, ready being unshaded', () => {
    const lv = recoveryLevels({
      a: { pct: 100 }, b: { pct: 80 }, c: { pct: 60 }, d: { pct: 30 }, e: { pct: 5 },
    })
    expect(lv).toEqual({ a: 0, b: 1, c: 2, d: 3, e: 4 })
  })
})

describe('pulse recovery', () => {
  const t0 = at(2026, 8, 24, 18, 0)
  const samples = [
    { t: t0, bpm: 120 },
    { t: t0 + 30000, bpm: 165 },
    { t: t0 + 60000, bpm: 150 },
    { t: t0 + 90000, bpm: 130 },
  ]

  it('measures the drop over the minute after a peak', () => {
    expect(hrRecovery(samples, t0 + 30000)).toMatchObject({ from: 165, to: 130, drop: 35 })
  })

  it('is null without a reading a minute later', () => {
    expect(hrRecovery(samples, t0 + 90000)).toBeNull()
    expect(hrRecovery([], t0)).toBeNull()
  })
})

describe('rest suggestion', () => {
  // Deliberately conservative: a timer that changes its mind every session is
  // worse than a fixed one.
  it('says nothing without enough evidence', () => {
    expect(suggestRest(90, [{ drop: 5 }, { drop: 6 }])).toBeNull()
  })

  it('lengthens rest when the pulse comes down slowly', () => {
    const slow = Array.from({ length: 6 }, () => ({ drop: 8 }))
    expect(suggestRest(90, slow)).toMatchObject({ sec: 120, why: 'slow' })
  })

  it('shortens rest when recovery is quick', () => {
    const fast = Array.from({ length: 6 }, () => ({ drop: 32 }))
    expect(suggestRest(120, fast)).toMatchObject({ sec: 105, why: 'fast' })
  })

  it('leaves an ordinary pattern alone', () => {
    const mid = Array.from({ length: 6 }, () => ({ drop: 18 }))
    expect(suggestRest(90, mid)).toBeNull()
  })

  it('will not push past the bounds', () => {
    expect(suggestRest(180, Array.from({ length: 6 }, () => ({ drop: 5 })))).toBeNull()
    expect(suggestRest(60, Array.from({ length: 6 }, () => ({ drop: 40 })))).toBeNull()
  })
})

describe('energy balance', () => {
  const NOW = at(2026, 8, 24, 12, 0)
  // 28 days of burn readings and a weigh-in every few days.
  const burnDays = (kcal = 2600) => {
    const days = {}
    for (let i = 0; i < 28; i++) {
      const d = new Date(NOW); d.setDate(d.getDate() - i)
      days[isoOf(d)] = { kcalTotal: kcal }
    }
    return days
  }
  const weighIns = (startKg, perWeek, n = 8) =>
    Array.from({ length: n }, (_, i) => {
      const daysAgo = (n - 1 - i) * 3
      return { t: NOW - daysAgo * 86400000, w: startKg + (perWeek / 7) * ((n - 1 - i) * -3) }
    })

  it('says so plainly when there is not enough to go on', () => {
    expect(energyBalance({}, [], 'kg', 28, NOW).enough).toBe(false)
    expect(energyBalance(burnDays(), [{ t: NOW, w: 80 }], 'kg', 28, NOW).enough).toBe(false)
  })

  it('reads a steady weight as eating what you burn', () => {
    const e = energyBalance(burnDays(2600), weighIns(80, 0), 'kg', 28, NOW)
    expect(e.enough).toBe(true)
    expect(e.direction).toBe('steady')
    expect(e.intake).toBeCloseTo(e.burn, -2)
  })

  it('turns weight gain into a surplus above burn', () => {
    const e = energyBalance(burnDays(2600), weighIns(80, 0.4), 'kg', 28, NOW)
    expect(e.direction).toBe('surplus')
    expect(e.balance).toBeGreaterThan(150)
    expect(e.intake).toBeGreaterThan(e.burn)
  })

  it('turns weight loss into a deficit below burn', () => {
    const e = energyBalance(burnDays(2600), weighIns(80, -0.5), 'kg', 28, NOW)
    expect(e.direction).toBe('deficit')
    expect(e.balance).toBeLessThan(-150)
    expect(e.intake).toBeLessThan(e.burn)
  })

  // The scale swings a kilo on water alone; anything inside that is not a signal.
  it('refuses to call a tiny drift a surplus', () => {
    const e = energyBalance(burnDays(2600), weighIns(80, 0.05), 'kg', 28, NOW)
    expect(e.direction).toBe('steady')
  })

  it('uses the pounds constant when the profile logs pounds', () => {
    const kg = energyBalance(burnDays(2600), weighIns(180, 1), 'kg', 28, NOW)
    const lb = energyBalance(burnDays(2600), weighIns(180, 1), 'lb', 28, NOW)
    expect(lb.balance).toBeLessThan(kg.balance)
  })
})

describe('correlation', () => {
  it('refuses to report on too few points', () => {
    expect(pearson([[1, 1], [2, 2], [3, 3]])).toBeNull()
  })

  it('finds a clean positive relationship', () => {
    expect(pearson([[1, 2], [2, 4], [3, 6], [4, 8], [5, 10], [6, 12]])).toBe(1)
  })

  it('finds a clean negative one', () => {
    expect(pearson([[1, 12], [2, 10], [3, 8], [4, 6], [5, 4], [6, 2]])).toBe(-1)
  })

  it('is null when one side never varies', () => {
    expect(pearson([[1, 5], [2, 5], [3, 5], [4, 5], [5, 5], [6, 5]])).toBeNull()
  })

  it('pairs each workout with the night before it', () => {
    const days = { '2026-08-01': { sleepMin: 400 }, '2026-08-02': { sleepMin: 300 } }
    const workouts = [
      { d: '2026-08-01', vol: 5000 },
      { d: '2026-08-02', vol: 3000 },
      { d: '2026-08-03', vol: 9000 },   // no sleep row — dropped
    ]
    const out = sleepVsVolume(days, workouts)
    expect(out.n).toBe(2)
    expect(out.points[0]).toMatchObject({ sleepMin: 400, vol: 5000 })
  })
})

describe('PR context', () => {
  it('flags a lift set on a short night', () => {
    expect(prContext({ sleepMin: 320 }, { sleep14: 420 })).toMatchObject({ deficitMin: 100 })
  })

  it('says nothing about a normal night', () => {
    expect(prContext({ sleepMin: 415 }, { sleep14: 420 })).toBeNull()
    expect(prContext({}, { sleep14: 420 })).toBeNull()
  })
})
