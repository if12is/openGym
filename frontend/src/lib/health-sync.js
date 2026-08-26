// Orchestration: when to read from Health Connect, and what to keep.
//
// The reading strategy matters more than it looks. A year of heart rate is
// hundreds of thousands of samples, and pulling it "just in case" would take
// minutes and fill the store with data nothing renders. So:
//   · daily rows are aggregates — three scalars and a sleep session per day
//   · the detailed pulse trace is fetched only for windows a workout occupied
//   · history older than 30 days needs a permission most users won't have, and
//     is pulled in batches, on request, never at boot
//
// Health Sync writes into Health Connect minutes after the watch hands its data
// over, so a session built right at Finish is often empty. That is not an error:
// it is recorded as `pending` and retried on the next resume.

import {
  getHealth, getConn, getSession, getDay, updateHealth, pruneHealth,
  loadHealthFromDisk, isPullingHealth,
} from './health-store.js'
import { aggregate, readHeartRate, readSleep, readRestingHeartRate, readExerciseSessions, readRecovery } from './health-connect.js'
import {
  gymWindow, hrWindow, localDayRange, hrStats, zoneMinutes, trimp,
  downsample, packSamples, sessionSamples, mainSleep, cardioOutside, splitCalories,
} from './health-match.js'
import { computeBaselines, trainingLoad } from './health-insights.js'
import { isoOf, todayISO } from './format.js'

const linked = () => getConn().state === 'ok'

// After the first calorie or recovery timeout, later days skip that metric.
// Walking 30 days that each wait 12s on a hung calorie read is how 15%
// looked frozen after the probe had already returned today's steps.
let skipKcal = false
let skipRecovery = false
export function resetPullSkips() {
  skipKcal = false
  skipRecovery = false
}

/* ============================ daily rows ============================ */

// One day = one aggregate call plus sleep and resting pulse. Cheap enough to
// re-run for today every time the app comes forward, which is what keeps the
// home card from showing this morning's numbers all afternoon.
async function readStep(kind, iso, fn, onStep) {
  onStep?.({ step: 'read', kind, iso, state: 'start' })
  const result = await fn()
  onStep?.({
    step: 'read',
    kind,
    iso,
    state: result.ok ? 'ok' : 'fail',
    reason: result.reason || null,
    result,
  })
  return result
}

export async function syncDay(iso, onStep) {
  if (!linked()) return null
  const { start, end } = localDayRange(iso)
  const now = Date.now()
  const to = Math.min(end, now)
  if (to <= start) return null

  // One after another. Four Health Connect queries in parallel are what
  // froze Honor on 0%: the binder never returned, and progress only
  // advanced after the whole day finished.
  //
  // Today's steps often already landed from the probe. Re-reading them
  // through aggregate() (steps+calories together) is what froze 15%:
  // calories hang on Honor, and the log still said "reading steps".
  const have = getDay(iso) || {}
  let agg
  if (have.steps != null) {
    agg = await readStep('steps', iso, async () => ({
      ok: true,
      steps: have.steps,
      activeCalories: have.kcalActive ?? null,
      totalCalories: have.kcalTotal ?? null,
    }), onStep)
    if (!skipKcal && have.kcalActive == null && have.kcalTotal == null) {
      const kcal = await readStep(
        'kcal', iso,
        () => aggregate(start, to, ['activeCalories', 'totalCalories']),
        onStep,
      )
      if (kcal.reason === 'timeout') skipKcal = true
      if (kcal.ok) {
        agg = {
          ...agg,
          activeCalories: kcal.activeCalories,
          totalCalories: kcal.totalCalories,
        }
      }
    }
  } else {
    agg = await readStep('steps', iso, () => aggregate(start, to, ['steps']), onStep)
    if (!skipKcal) {
      const kcal = await readStep(
        'kcal', iso,
        () => aggregate(start, to, ['activeCalories', 'totalCalories']),
        onStep,
      )
      if (kcal.reason === 'timeout') skipKcal = true
      if (kcal.ok) {
        agg = {
          ok: agg.ok || kcal.ok,
          steps: agg.steps,
          activeCalories: kcal.activeCalories,
          totalCalories: kcal.totalCalories,
        }
      }
    }
  }
  const sleep = await readStep(
    'sleep', iso,
    () => readSleep(start - 30 * 3600000, to),
    onStep,
  )
  const rhr = await readStep(
    'rhr', iso,
    () => readRestingHeartRate(start, to),
    onStep,
  )
  let rec = { ok: false }
  if (!skipRecovery) {
    rec = await readStep(
      'recovery', iso,
      () => readRecovery(start, to),
      onStep,
    )
    if (rec.reason === 'timeout') skipRecovery = true
  }

  const row = {}
  if (agg.ok) {
    row.steps = agg.steps
    row.kcalActive = agg.activeCalories
    row.kcalTotal = agg.totalCalories
  }
  if (sleep.ok) {
    const main = mainSleep(sleep.sessions, iso)
    if (main) { row.sleepMin = main.min; row.sleepEff = main.eff; row.sleepEnd = main.end }
  }
  if (rhr.ok && rhr.samples.length) {
    // Lowest of the day rather than the latest: a resting reading taken while
    // walking to the car is not a resting reading.
    row.rhr = Math.min(...rhr.samples.map(s => s.bpm))
  }
  if (rec.ok) {
    // Averaged across the night's readings rather than taking one: a wrist SpO2
    // spot check moves several points on how the arm happened to be lying.
    if (rec.spo2.length) {
      row.spo2 = Math.round((rec.spo2.reduce((n, s) => n + s.pct, 0) / rec.spo2.length) * 10) / 10
    }
    if (rec.hrv.length) {
      row.hrvMs = Math.round(rec.hrv.reduce((n, s) => n + s.ms, 0) / rec.hrv.length)
    }
  }
  if (!Object.keys(row).length) return null

  row.syncedAt = now
  updateHealth(h => { h.days[iso] = { ...(h.days[iso] || {}), ...row } })
  return row
}

// Today and yesterday on every resume. Yesterday because Health Sync often
// finishes writing a night's sleep well after midnight, so the row written at
// 08:00 yesterday is usually incomplete.
//
// onProgress(frac, info) fires before each read, not after each day. A day
// used to be four silent queries, so a hang looked like 0% forever.
export async function syncRecentDays(days = 2, onProgress) {
  if (!linked()) return 0
  resetPullSkips()
  const out = []
  const base = new Date()
  const totalReads = Math.max(1, days * 4)
  let done = 0
  let empty = 0

  for (let i = 0; i < days; i++) {
    const d = new Date(base); d.setDate(d.getDate() - i)
    const iso = isoOf(d)
    let dayReads = 0
    let dayTimeouts = 0
    onProgress?.(done / totalReads, { step: 'day', iso, index: i, total: days })
    const row = await syncDay(iso, info => {
      if (info.state === 'start') {
        onProgress?.(done / totalReads, info)
        return
      }
      if (info.step === 'read') {
        dayReads++
        if (info.reason === 'timeout') dayTimeouts++
        done++
      }
      onProgress?.(Math.min(done / totalReads, 0.99), info)
    })
    out.push(row)
    // First day: every read timed out. Walking more days will not start
    // answering. Stop and let the log say so, rather than sit on 0% for
    // another minute.
    if (i === 0 && dayReads > 0 && dayTimeouts === dayReads) {
      onProgress?.(1, { step: 'stopped', reason: 'timeout', iso })
      updateHealth(h => { h.conn.lastSyncAt = Date.now() })
      return 0
    }
    // Without READ_HEALTH_DATA_HISTORY, days older than ~30 error or come
    // back empty. Six empty days in a row is the end of what this phone
    // will give, not a reason to grind through the rest of the year.
    empty = row ? 0 : empty + 1
    if (empty >= 6) {
      onProgress?.(1, { step: 'stopped', reason: 'empty', iso })
      updateHealth(h => { h.conn.lastSyncAt = Date.now() })
      return out.filter(Boolean).length
    }
  }
  onProgress?.(1, { step: 'done' })
  updateHealth(h => { h.conn.lastSyncAt = Date.now() })
  return out.filter(Boolean).length
}

/* ============================ per-workout ============================ */

// Everything the watch has to say about one gym session.
//
// Note the two different windows: heart rate is read with five minutes of padding
// either side (the pulse keeps talking after the last set), while calories use the
// exact window. Padding the calorie query would count those minutes into the gym
// bucket AND leave them subtracted out of the rest of the day.
export async function buildSession(workout) {
  if (!linked()) return null
  const gym = gymWindow(workout)
  const hrWin = hrWindow(workout)
  const day = localDayRange(workout.d)

  const [hr, kcalWin, kcalDay, exercise, sleepRes] = await Promise.all([
    readHeartRate(hrWin.start, hrWin.end),
    aggregate(gym.start, gym.end, ['activeCalories']),
    aggregate(day.start, Math.min(day.end, Date.now()), ['activeCalories', 'totalCalories']),
    readExerciseSessions(day.start, day.end),
    readSleep(day.start - 30 * 3600000, day.start + 12 * 3600000),
  ])

  const samples = hr.ok ? hr.samples : []
  // Nothing to attach yet. Health Sync is probably still catching up — record the
  // attempt so the retry on resume knows to come back, rather than writing an
  // empty session that looks like "the watch was off".
  if (!samples.length && !kcalWin.ok) {
    return { state: 'pending', window: [gym.start, gym.end], clamped: gym.clamped, builtAt: Date.now() }
  }

  const health = getHealth()
  const base = health.base || {}
  const stats = hrStats(samples)
  const hrMax = base.hrMaxObserved || (stats ? Math.max(stats.max, 160) : 180)
  const rhr = base.rhr28 || base.rhr7 || 60

  const cardio = exercise.ok ? cardioOutside(exercise.sessions, gym) : []
  const sleepBefore = sleepRes.ok ? mainSleep(sleepRes.sessions, workout.d) : null

  const kcalGym = kcalWin.ok ? (kcalWin.activeCalories || 0) : 0
  const split = splitCalories({
    kcalDay: kcalDay.ok ? (kcalDay.activeCalories || 0) : kcalGym,
    kcalGym,
    cardio,
  })

  return {
    state: samples.length ? 'ok' : 'partial',
    window: [gym.start, gym.end],
    clamped: gym.clamped,
    hrAvg: stats?.avg ?? null,
    hrMax: stats?.max ?? null,
    hrMin: stats?.min ?? null,
    zones: samples.length ? zoneMinutes(samples, hrMax, rhr) : null,
    trimp: samples.length ? trimp(samples, hrMax, rhr) : null,
    kcal: split,
    // Stored relative to the window start and capped for the chart. hrMax/hrAvg
    // above were taken from the full trace first, so the peak survives the
    // downsample even though the curve drawn from it is smoother.
    samples: samples.length ? packSamples(downsample(samples), gym.start) : null,
    sleepBefore: sleepBefore ? { min: sleepBefore.min, eff: sleepBefore.eff } : null,
    cardioOutside: cardio,
    builtAt: Date.now(),
  }
}

// Build and store. Safe to call more than once for the same workout — a session
// that already came back `ok` is left alone.
export async function ensureSession(workout, { force = false } = {}) {
  if (!linked() || !workout?.id) return null
  const have = getSession(workout.id)
  if (have && have.state === 'ok' && !force) return have
  const built = await buildSession(workout)
  if (!built) return have
  updateHealth(h => { h.sessions[workout.id] = built })
  return built
}

// Retry anything the watch hadn't caught up on yet. Bounded so a long history
// with a briefly-connected watch can't turn a resume into a hundred queries.
export async function retryPending(workouts, limit = 5) {
  if (!linked()) return 0
  const health = getHealth()
  const stale = workouts
    .filter(w => {
      const s = health.sessions[w.id]
      if (!s) return false
      if (s.state !== 'pending') return false
      // Give up after a week — by then the data was never written, and retrying
      // it on every resume forever is just a battery cost.
      return Date.now() - (s.builtAt || 0) < 7 * 86400000
    })
    .slice(-limit)
  let n = 0
  for (const w of stale) {
    const r = await ensureSession(w, { force: true })
    if (r?.state === 'ok') n++
  }
  return n
}

/* ============================ baselines ============================ */

export function recomputeBaselines(workouts, iso = todayISO()) {
  const h = getHealth()
  const base = computeBaselines(h.days, h.sessions, iso)
  const load = trainingLoad(h.sessions, workouts || [], iso)
  const trimps = Object.values(h.sessions).map(s => s?.trimp).filter(Boolean).sort((a, b) => a - b)
  // The median session, used as the "hard" threshold for the overload check —
  // relative to this person's own training, not to a textbook number.
  const trimpTypical = trimps.length ? trimps[Math.floor(trimps.length / 2)] : null
  updateHealth(hh => { hh.base = { ...base, loadWeek: load.acute, loadRatio: load.ratio, trimpTypical } })
  return getHealth().base
}

/* ============================ history backfill ============================ */

// Older days, in batches, only when asked. Without READ_HEALTH_DATA_HISTORY the
// platform caps reads at ~30 days from the first grant, so this reports how far
// it actually got rather than pretending to have filled the year.
export async function backfillDays(fromIso, toIso, onProgress) {
  if (!linked()) return { done: 0, blocked: true }
  const from = new Date(fromIso), to = new Date(toIso)
  const total = Math.max(1, Math.round((to - from) / 86400000))
  let done = 0, empty = 0
  for (const d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    const iso = isoOf(d)
    if (getHealth().days[iso]?.syncedAt) { done++; onProgress?.(done / total); continue }
    const row = await syncDay(iso)
    done++
    // Six consecutive empty days past the start means the permission window has
    // closed behind us. Walking the rest of the year would take minutes and find
    // nothing.
    empty = row ? 0 : empty + 1
    if (empty >= 6) return { done, total, stoppedEarly: true }
    onProgress?.(done / total)
  }
  return { done, total, stoppedEarly: false }
}

/* ============================ boot ============================ */

// Called once from the store's boot, and again on every resume.
export async function bootHealth(workouts) {
  await loadHealthFromDisk()
  pruneHealth((workouts || []).map(w => w.id))
  if (isPullingHealth()) return false
  // Do not call checkAuthorization here. On Honor that binder call is what
  // froze Pull on "checking permissions…" — the grant is already in Health
  // Connect, and probe is the check that actually returns.
  if (getConn().state !== 'ok') return false
  await syncRecentDays(2)
  await retryPending(workouts || [])
  recomputeBaselines(workouts)
  return true
}

/* ============================ read helpers for views ============================ */

export { sessionSamples } from './health-match.js'

// The most recent pulse the watch has written, for the chip on the running
// workout screen. Not a stream: reading health data in the background needs a
// permission this app deliberately never asks for, so the best available answer
// is "the newest sample in the last quarter hour", and the UI says how old it is.
export async function readLivePulse() {
  if (!linked()) return null
  const now = Date.now()
  const r = await readHeartRate(now - 15 * 60000, now)
  if (!r.ok || !r.samples.length) return null
  const last = r.samples[r.samples.length - 1]
  return { bpm: last.bpm, at: last.t }
}

// Pulse recovery across the sets of a session — the number a rest timer should
// actually be set by. Peaks are found in the trace rather than taken from set
// timestamps, because sets are not timestamped individually: a local maximum
// followed by a decline is a set, near enough, and averaging over several
// sessions washes out the ones that aren't.
export function recoveriesFor(session) {
  const samples = sessionSamples(session)
  if (samples.length < 8) return []
  const out = []
  for (let i = 2; i < samples.length - 2; i++) {
    const s = samples[i]
    const isPeak = s.bpm > samples[i - 1].bpm && s.bpm > samples[i - 2].bpm &&
      s.bpm >= samples[i + 1].bpm && s.bpm >= samples[i + 2].bpm
    if (!isPeak) continue
    // Only peaks that actually reached working intensity — the warm-up walk in
    // has plenty of little bumps and none of them are sets.
    if (s.bpm < (session.hrMax || 0) * 0.8) continue
    const after = samples.find(x => x.t >= s.t + 60000)
    if (!after) continue
    out.push({ drop: Math.max(0, s.bpm - after.bpm), from: s.bpm, to: after.bpm })
    i += 4   // one peak per set, not five points along the same one
  }
  return out
}

// Across the last few sessions, so one odd workout can't move the suggestion.
export function recentRecoveries(workouts, n = 6) {
  const h = getHealth()
  return (workouts || []).slice(-n)
    .map(w => h.sessions[w.id])
    .filter(s => s && s.state === 'ok')
    .flatMap(recoveriesFor)
}
