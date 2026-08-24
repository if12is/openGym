// Turning readings into decisions.
//
// Every number here is relative to the user's own rolling baseline, never to a
// population figure. "A resting pulse of 62" means nothing on its own; "six above
// your last week" means something. That is also why nothing in this file is a
// verdict — the app suggests, and the training log stays the user's call.
//
// Pure functions only, so the thresholds are pinned by tests rather than by
// whatever the last hand-check happened to produce.

import { localDayRange } from './health-match.js'
import { isoOf } from './format.js'

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
