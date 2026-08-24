// Turning readings into decisions.
//
// Every number here is relative to the user's own rolling baseline, never to a
// population figure. "A resting pulse of 62" means nothing on its own; "six above
// your last week" means something. That is also why nothing in this file is a
// verdict — the app suggests, and the training log stays the user's call.
//
// Pure functions only, so the thresholds are pinned by tests rather than by
// whatever the last hand-check happened to produce.

import { localDayRange, sessionSamples, peakNearSets, hrReserve } from './health-match.js'
import { isoOf, weekKey } from './format.js'

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const mean = a => (a.length ? a.reduce((n, v) => n + v, 0) / a.length : null)

// Walk back N calendar days from `iso`, newest first. Used everywhere a baseline
// is built, so a gap in the data thins the average instead of shifting the window.
export function lastDays(days, iso, n) {
  const out = []
  const { start } = localDayRange(iso)
  for (let i = 1; i <= n; i++) {
    const d = new Date(start); d.setDate(d.getDate() - i)
    const row = days[isoOf(d)]
    if (row) out.push(row)
  }
  return out
}

/* ============================ baselines ============================ */

// The observed max is what makes zones work without asking anyone's age. It is
// taken from session peaks rather than from raw daily samples: a single spurious
// 210 from a loose strap while walking would otherwise stretch every zone for
// months. Session peaks are at least bounded by the fact that you were training.
export function estimateHrMax(sessions, sinceMs) {
  const peaks = Object.values(sessions || [])
    .filter(s => s && s.hrMax > 0 && (!sinceMs || (s.window?.[0] || s.builtAt || 0) >= sinceMs))
    .map(s => s.hrMax)
    .sort((a, b) => b - a)
  if (!peaks.length) return null
  // Second highest when there is one — the top reading of a whole training block
  // is the most likely to be an artefact, and the runner-up costs almost nothing
  // in accuracy.
  return peaks.length >= 3 ? peaks[1] : peaks[0]
}

export function computeBaselines(days, sessions, iso) {
  const d7 = lastDays(days, iso, 7)
  const d28 = lastDays(days, iso, 28)
  const d14 = lastDays(days, iso, 14)
  const rhr7 = mean(d7.map(d => d.rhr).filter(Boolean))
  const rhr28 = mean(d28.map(d => d.rhr).filter(Boolean))
  const sleep14 = mean(d14.map(d => d.sleepMin).filter(Boolean))
  const kcal14 = mean(d14.map(d => d.kcalActive).filter(Boolean))
  return {
    rhr7: rhr7 != null ? Math.round(rhr7) : null,
    rhr28: rhr28 != null ? Math.round(rhr28) : null,
    sleep14: sleep14 != null ? Math.round(sleep14) : null,
    kcal14: kcal14 != null ? Math.round(kcal14) : null,
    hrMaxObserved: estimateHrMax(sessions),
    days7: d7.length,
    days28: d28.length,
  }
}

/* ============================ training load ============================ */

// Acute load against chronic load — the ratio that says whether this week is a
// normal step up or a spike. Built from TRIMP where the watch was connected and
// from set volume where it wasn't, so it degrades instead of disappearing.
export function trainingLoad(sessions, workouts, iso) {
  const { end } = localDayRange(iso)
  const loadOf = w => {
    const s = sessions[w.id]
    if (s?.trimp) return s.trimp
    // No pulse trace: fall back to a volume proxy, scaled so a typical session
    // lands in the same range as a typical TRIMP. Crude, but a missing week
    // reading as zero load would make every ratio look like a spike.
    return Math.round((w.vol || 0) / 400)
  }
  const inWin = n => workouts.filter(w => {
    const t = w.start || new Date(w.d).getTime()
    return t <= end && t > end - n * 86400000
  })
  const acute = inWin(7).reduce((n, w) => n + loadOf(w), 0)
  const chronicTotal = inWin(28).reduce((n, w) => n + loadOf(w), 0)
  const chronic = chronicTotal / 4          // per-week equivalent
  return {
    acute,
    chronic: Math.round(chronic),
    ratio: chronic > 0 ? Math.round((acute / chronic) * 100) / 100 : null,
    sessions7: inWin(7).length,
  }
}

/* ============================ readiness ============================ */

// 0-100, from three things the watch can actually see. Each part reports its own
// sub-score and a reason, because a single number with no explanation is not
// something anyone should change their training over.
//
// Weights: sleep leads because it is the one input the user can still act on when
// they read this in the morning.
export const READINESS_WEIGHTS = { sleep: 0.4, rhr: 0.3, load: 0.3 }

export function readiness(day, base, load) {
  const parts = []
  let total = 0, weight = 0

  // --- sleep vs your own average (7h if there is no average yet) ---
  if (day?.sleepMin) {
    const target = base?.sleep14 || 420
    const ratio = day.sleepMin / target
    // 60% of your normal night scores 0; 105% scores full. Above that adds
    // nothing — a ten-hour night after a bad week is catching up, not surplus.
    const s = clamp((ratio - 0.6) / 0.45, 0, 1)
    parts.push({ key: 'sleep', score: Math.round(s * 100), value: day.sleepMin, target: Math.round(target) })
    total += s * READINESS_WEIGHTS.sleep; weight += READINESS_WEIGHTS.sleep
  }

  // --- resting pulse against last week ---
  if (day?.rhr && base?.rhr7) {
    const delta = day.rhr - base.rhr7
    // Ten beats over baseline is the floor. That much is a real signal — illness,
    // heat, a very hard day before — not noise.
    const s = clamp(1 - delta / 10, 0, 1)
    parts.push({ key: 'rhr', score: Math.round(s * 100), value: day.rhr, target: base.rhr7, delta: Math.round(delta) })
    total += s * READINESS_WEIGHTS.rhr; weight += READINESS_WEIGHTS.rhr
  }

  // --- how much you have already asked of yourself this week ---
  if (load?.ratio != null) {
    // 0.8-1.3 of your usual week is the band where training is progressing rather
    // than either detraining or piling up. Outside it the score falls away either
    // side, steeper above than below.
    const r = load.ratio
    const s = r < 0.8 ? clamp(0.75 + r * 0.3, 0, 1)
      : r <= 1.3 ? 1
        : clamp(1 - (r - 1.3) / 0.7, 0, 1)
    parts.push({ key: 'load', score: Math.round(s * 100), value: r })
    total += s * READINESS_WEIGHTS.load; weight += READINESS_WEIGHTS.load
  }

  if (!weight) return null
  const score = Math.round((total / weight) * 100)
  return {
    score,
    band: score >= 75 ? 'go' : score >= 50 ? 'normal' : score >= 30 ? 'easy' : 'rest',
    parts,
    // How much of the picture this is actually built on. Shown next to the score
    // the same way the effort card shows what share of sets were rated.
    confidence: weight / (READINESS_WEIGHTS.sleep + READINESS_WEIGHTS.rhr + READINESS_WEIGHTS.load),
  }
}

// A harder signal than a low score, and separate from it on purpose: this is the
// combination that says stop, rather than the gradient that says maybe.
export function overloadFlag(day, base, load, recentSessions) {
  if (!day || !base) return null
  const reasons = []
  if (day.rhr && base.rhr7 && day.rhr - base.rhr7 >= 5) reasons.push('rhr')
  if (day.sleepMin && day.sleepMin < 330) reasons.push('sleep')
  if (load?.ratio != null && load.ratio > 1.5) reasons.push('load')
  // Two hard sessions back to back with no easy day between them.
  const hard = (recentSessions || []).filter(s => s?.trimp).slice(-2)
  if (hard.length === 2 && hard.every(s => s.trimp > (base.trimpTypical || 90))) reasons.push('backToBack')
  return reasons.length >= 2 ? { reasons } : null
}

/* ============================ recovery per muscle ============================ */

// How long a muscle needs before it is worth training hard again, and how far
// through that it currently is.
//
// The app already knows when each muscle was last worked and how much. What it
// could never know before is whether the time since was spent recovering or just
// passing — eight hours of sleep and four hours of sleep are not the same 24
// hours. That is the entire reason this belongs to the watch and not to the log.
//
// Deliberately not presented as a clock. It is a direction ("chest is still
// cooked"), and dressing an estimate up as "17h 40m remaining" would claim a
// precision that a wrist-worn sleep estimate does not have.
export const RECOVERY_BASE_H = 24        // even one hard set buys a day
export const RECOVERY_PER_SET_H = 4
export const RECOVERY_MAX_H = 72         // past three days, everything is ready

// `lastLoads` is { muscle: { sets, at } } — built by the caller from the workout
// log, so this file never has to pull in the exercise database.
export function muscleRecovery(lastLoads, days, base, now = Date.now()) {
  const out = {}
  for (const [muscle, last] of Object.entries(lastLoads || {})) {
    if (!last || !last.at) continue
    const hours = (now - last.at) / 3600000
    const need = Math.min(RECOVERY_MAX_H, RECOVERY_BASE_H + (last.sets || 0) * RECOVERY_PER_SET_H)
    const factor = sleepDebtFactor(last.at, days, base, now)
    const pct = Math.round(Math.max(0, Math.min(1, hours / (need * factor))) * 100)
    out[muscle] = {
      pct,
      hoursSince: Math.round(hours),
      sets: last.sets || 0,
      // Only worth surfacing when sleep actually moved the answer, otherwise it
      // is noise on a screen that already has a lot of numbers.
      slowedBySleep: factor > 1.1,
    }
  }
  return out
}

// Nights since the muscle was worked, against this person's own average. Short
// nights stretch the window; there is no credit for sleeping more than usual,
// because catching up is not the same as banking.
function sleepDebtFactor(sinceMs, days, base, now) {
  const target = base?.sleep14
  if (!target) return 1
  const slept = []
  for (const d = new Date(sinceMs); +d <= now; d.setDate(d.getDate() + 1)) {
    const row = days?.[isoOf(d)]
    if (row?.sleepMin) slept.push(row.sleepMin)
  }
  if (!slept.length) return 1
  const avg = mean(slept)
  return clamp(target / avg, 1, 1.4)
}

// 0 = ready (or never trained), 4 = worked within the last few hours. Higher
// shading means "needs attention", which is the same direction the load map
// reads in, so one map does not contradict the other.
export function recoveryLevels(rec) {
  const lv = {}
  for (const [muscle, r] of Object.entries(rec || {})) {
    lv[muscle] = r.pct >= 100 ? 0
      : r.pct >= 75 ? 1
        : r.pct >= 50 ? 2
          : r.pct >= 25 ? 3
            : 4
  }
  return lv
}

export const READY = r => !r || r.pct >= 100

/* ============================ rest between sets ============================ */

// How far the pulse came down in the minute after a peak. The single most useful
// thing the watch can tell a lifter that a stopwatch cannot: it is the difference
// between "90 seconds elapsed" and "you are actually ready".
export function hrRecovery(samples, peakT, windowMs = 60000) {
  if (!samples || samples.length < 2) return null
  const at = t => {
    let best = null
    for (const s of samples) {
      if (s.t > t) break
      best = s
    }
    return best
  }
  const peak = at(peakT)
  const after = at(peakT + windowMs)
  if (!peak || !after || after.t <= peak.t) return null
  return { drop: Math.max(0, peak.bpm - after.bpm), from: peak.bpm, to: after.bpm }
}

// Turn that into an actual rest-timer suggestion. Deliberately conservative: it
// only speaks up when the evidence is one-sided across several sessions, because
// a timer that changes its mind every workout is worse than a fixed one.
export function suggestRest(currentSec, recoveries) {
  const usable = (recoveries || []).filter(r => r && r.drop != null)
  if (usable.length < 5) return null
  const avg = mean(usable.map(r => r.drop))
  // A drop under 12 bpm in the minute after a working set means you are starting
  // the next one still loaded. Over 25 and you have been sitting around.
  if (avg < 12 && currentSec < 180) return { sec: Math.min(180, currentSec + 30), why: 'slow', avg: Math.round(avg) }
  if (avg > 25 && currentSec > 60) return { sec: Math.max(60, currentSec - 15), why: 'fast', avg: Math.round(avg) }
  return null
}

/* ============================ what each lift costs you ============================ */

// Which exercises actually drive your heart rate, ranked.
//
// Everyone knows squats are harder than curls; what nobody knows is by how much,
// for them, on their programme. This answers it with the two things the app now
// has together: when each set was finished, and what the pulse was doing then.
//
// Needs `doneAt` on the sets, so it only sees sessions logged after that started
// being recorded — the card says so rather than looking broken.
export const COST_MIN_SETS = 3

export function exerciseCost(workouts, sessions, hrMax, rhr) {
  const acc = {}
  for (const w of workouts || []) {
    const s = sessions?.[w.id]
    if (!s || s.state !== 'ok') continue
    const samples = sessionSamples(s)
    if (samples.length < 4) continue
    for (const e of w.entries || []) {
      const doneAts = (e.sets || []).filter(x => x.done && x.doneAt).map(x => x.doneAt)
      if (!doneAts.length) continue
      const peaks = peakNearSets(samples, doneAts)
      if (!peaks.length) continue
      const a = acc[e.id] || (acc[e.id] = { peaks: [], sessions: 0 })
      a.peaks.push(...peaks)
      a.sessions++
    }
  }
  return Object.entries(acc)
    .filter(([, a]) => a.peaks.length >= COST_MIN_SETS)
    .map(([id, a]) => {
      const avg = mean(a.peaks)
      return {
        id,
        avgPeak: Math.round(avg),
        // As a share of reserve, so the ranking means the same thing to someone
        // with a resting pulse of 48 and someone at 70.
        reserve: hrMax > rhr ? Math.round(clamp(hrReserve(avg, hrMax, rhr), 0, 1) * 100) : null,
        sets: a.peaks.length,
        sessions: a.sessions,
      }
    })
    .sort((x, y) => y.avgPeak - x.avgPeak)
}

/* ============================ sleep streak ============================ */

// Seven hours, five nights out of the week. A fixed target rather than the
// user's own average on purpose: a streak measured against yourself is one you
// cannot fail, and a streak you cannot fail is not worth keeping.
export const SLEEP_TARGET_MIN = 420
export const SLEEP_NIGHTS_PER_WEEK = 5

// Counts back the same way the training streak does — including the courtesy
// that the current week does not break it before it has had a chance to finish.
export function sleepStreakWeeks(days, target = SLEEP_TARGET_MIN, nights = SLEEP_NIGHTS_PER_WEEK, now = new Date()) {
  const good = {}
  for (const [iso, d] of Object.entries(days || {})) {
    if (!d?.sleepMin || d.sleepMin < target) continue
    const wk = weekKey(iso)
    good[wk] = (good[wk] || 0) + 1
  }
  let streak = 0
  const cur = new Date(now)
  for (let i = 0; i < 520; i++) {
    const wk = weekKey(isoOf(cur))
    if ((good[wk] || 0) >= nights) streak++
    else if (i > 0) break
    cur.setDate(cur.getDate() - 7)
  }
  return streak
}

/* ============================ energy balance ============================ */

// Roughly what a kilo of body mass is worth in calories. A textbook figure, and
// treated as one: it is here to turn a weight trend into an order of magnitude,
// not to promise anyone a number to the calorie.
export const KCAL_PER_KG = 7700
export const KCAL_PER_LB = 3500

// Least squares over (time, weight). A first-vs-last reading is at the mercy of
// which two days happened to have a weigh-in, and body weight swings a kilo on
// water alone — the slope of everything in the window is far steadier.
function weightTrend(points) {
  const n = points.length
  if (n < 2) return null
  const mx = mean(points.map(p => p.t)), my = mean(points.map(p => p.w))
  let num = 0, den = 0
  for (const p of points) { const dx = p.t - mx; num += dx * (p.w - my); den += dx * dx }
  if (!den) return null
  return num / den            // weight units per millisecond
}

/**
 * What you have been eating, without ever asking you to log a meal.
 *
 * The watch estimates what you burn; the scale records what that did to you.
 * The gap between them is intake — and the gap is the only part neither device
 * can see on its own. That is the whole trick, and it is why this needs both.
 *
 * Returns null rather than a shaky number when the window is too thin: two
 * weigh-ins a fortnight apart is a rumour, not a trend.
 */
export function energyBalance(days, bodyweight, unit = 'kg', windowDays = 28, now = Date.now()) {
  const from = now - windowDays * 86400000
  const points = (bodyweight || [])
    .map(b => ({ t: b.t || new Date(b.d).getTime(), w: b.w }))
    .filter(p => p.t >= from && p.w > 0)
    .sort((a, b) => a.t - b.t)

  const burns = Object.entries(days || {})
    .filter(([iso, d]) => d.kcalTotal && new Date(iso + 'T12:00:00').getTime() >= from)
    .map(([, d]) => d.kcalTotal)

  // Both halves are required: a weight trend with no burn figure cannot become
  // an intake, and a burn figure with no trend is just a number.
  if (points.length < 4 || burns.length < 7) {
    return { enough: false, weighIns: points.length, burnDays: burns.length }
  }

  const slope = weightTrend(points)
  if (slope == null) return { enough: false, weighIns: points.length, burnDays: burns.length }

  const perKg = unit === 'lb' ? KCAL_PER_LB : KCAL_PER_KG
  const perDay = slope * 86400000                       // weight units gained per day
  const burn = Math.round(mean(burns))
  const balance = Math.round(perDay * perKg)            // + surplus, − deficit
  return {
    enough: true,
    burn,
    intake: Math.round(burn + balance),
    balance,
    perWeek: Math.round(perDay * 7 * 100) / 100,
    weighIns: points.length,
    burnDays: burns.length,
    // Under ~150 kcal/day the estimate is inside the noise of both the scale and
    // the watch, and calling that a surplus would be inventing a signal.
    direction: Math.abs(balance) < 150 ? 'steady' : balance > 0 ? 'surplus' : 'deficit',
  }
}

/* ============================ relationships ============================ */

export function pearson(pairs) {
  const n = pairs.length
  if (n < 6) return null
  const xs = pairs.map(p => p[0]), ys = pairs.map(p => p[1])
  const mx = mean(xs), my = mean(ys)
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my
    num += a * b; dx += a * a; dy += b * b
  }
  if (!dx || !dy) return null
  return Math.round((num / Math.sqrt(dx * dy)) * 100) / 100
}

// Last night's sleep against what you managed the next day. Needs a couple of
// months before it says anything — below that it is reading noise, so it returns
// the points but no coefficient.
export function sleepVsVolume(days, workouts) {
  const pairs = []
  const points = []
  for (const w of workouts) {
    const iso = w.d
    const d = days[iso]
    if (!d?.sleepMin || !w.vol) continue
    pairs.push([d.sleepMin, w.vol])
    points.push({ sleepMin: d.sleepMin, vol: w.vol, d: iso })
  }
  return { points, r: pearson(pairs), n: pairs.length }
}

// Was this PR set in a hole? A lift that went up on five hours of sleep is worth
// more than the same lift on eight, and the app is the only thing that knows both.
export function prContext(day, base) {
  if (!day?.sleepMin || !base?.sleep14) return null
  const deficit = base.sleep14 - day.sleepMin
  return deficit >= 60 ? { deficitMin: Math.round(deficit) } : null
}
