// The JS side of the health bridge (Huawei Health Kit, with Health Connect as
// a GMS fallback).
//
// This module is the contract the native plugin implements — one place that knows
// the method names, the argument shapes and what a missing value looks like. The
// rest of the app never calls the plugin directly, so a plugin swap (or a second
// platform) touches this file and nothing else.
//
// Conventions with the native side:
//   · every instant is epoch milliseconds, never an ISO string — the app already
//     works in ms (`workout.start`) and round-tripping through ISO in two
//     timezones is a bug waiting to happen
//   · every read returns [] / null rather than throwing on "nothing recorded",
//     because an empty day and a failed query need to look different to the caller
//   · `origins` filters to one writing app when the user has picked a trusted
//     source, so the phone and the watch can't both be counted for the same steps

import { healthPlugin, getConn } from './health-store.js'

// Watch data often lands a few minutes after the watch syncs, so a query that
// returns nothing is usually "not yet", not "never". Callers distinguish the two
// by the `ok` flag rather than by an empty array.
const fail = reason => ({ ok: false, reason })

async function call(method, args = {}) {
  const p = await healthPlugin()
  if (!p || typeof p[method] !== 'function') return fail('no-plugin')
  try {
    const res = await p[method](args)
    return { ok: true, ...res }
  } catch (e) {
    const msg = String(e?.message || e?.code || e || '')
    if (msg.includes('not-authorized')) return fail('denied')
    if (msg.includes('no-bind')) return fail('no-bind')
    return fail('error')
  }
}

// Applied to every read that supports it. Null means "no preference yet" — the
// first sync happens before the user has seen the source list, and filtering to
// nothing would make that sync silently empty.
const originFilter = () => {
  const t = getConn().trusted
  return t ? { origins: [t] } : {}
}

/* ============================ reads ============================ */

export async function readHeartRate(start, end) {
  const r = await call('readHeartRate', { start, end, ...originFilter() })
  if (!r.ok) return r
  // Sorted here rather than trusted from the platform: zone minutes and TRIMP
  // both walk the array pairwise and would produce negative intervals otherwise.
  const samples = (r.samples || [])
    .filter(s => s && s.bpm > 0)
    .map(s => ({ t: s.t, bpm: s.bpm }))
    .sort((a, b) => a.t - b.t)
  return { ok: true, samples }
}

export async function readRestingHeartRate(start, end) {
  const r = await call('readRestingHeartRate', { start, end, ...originFilter() })
  if (!r.ok) return r
  return { ok: true, samples: (r.samples || []).filter(s => s && s.bpm > 0) }
}

// Blood oxygen and heart-rate variability together — nothing wants one without
// the other, and one round trip beats two. Both are overnight spot readings on
// a wrist device, so they are only ever reported as a trend.
export async function readRecovery(start, end) {
  const r = await call('readRecovery', { start, end, ...originFilter() })
  if (!r.ok) return r
  return {
    ok: true,
    spo2: (r.spo2 || []).filter(s => s && s.pct > 0),
    hrv: (r.hrv || []).filter(s => s && s.ms > 0),
  }
}

export async function readSleep(start, end) {
  const r = await call('readSleep', { start, end, ...originFilter() })
  if (!r.ok) return r
  return {
    ok: true,
    sessions: (r.sessions || [])
      .filter(s => s && s.end > s.start)
      .map(s => ({ start: s.start, end: s.end, asleepMin: s.asleepMin ?? null })),
  }
}

export async function readExerciseSessions(start, end) {
  const r = await call('readExerciseSessions', { start, end, ...originFilter() })
  if (!r.ok) return r
  return {
    ok: true,
    sessions: (r.sessions || [])
      .filter(s => s && s.end > s.start)
      .map(s => ({ start: s.start, end: s.end, type: s.type || null, kcal: s.kcal || 0 })),
  }
}

// One round trip for every scalar a day needs. Three separate calls would be
// three permission checks and three cursor walks over the same range.
export async function aggregate(start, end, metrics = ['steps', 'activeCalories', 'totalCalories']) {
  const r = await call('aggregate', { start, end, metrics, ...originFilter() })
  if (!r.ok) return r
  return {
    ok: true,
    steps: r.steps ?? null,
    activeCalories: r.activeCalories ?? null,
    totalCalories: r.totalCalories ?? null,
  }
}

// Who is writing into Health Connect on this phone. Shown during setup so the
// user can point the app at the watch instead of the phone's own step counter —
// which is the difference between "you walked 6,000 steps" and "you walked
// 6,000 steps twice".
export async function listOrigins(start, end) {
  const r = await call('listOrigins', { start, end })
  if (!r.ok) return r
  return { ok: true, origins: (r.origins || []).filter(o => o && o.pkg) }
}
