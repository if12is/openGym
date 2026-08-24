// Matching watch readings to gym sessions — the rules, written down once.
//
// Everything here is pure: it takes numbers and returns numbers, never touches
// Health Connect or the store. That is the whole point — these are the decisions
// that are easy to get subtly wrong and impossible to notice afterwards (an hour
// of sleep attributed to the wrong day reads perfectly plausible), so they live
// where a test can pin them.

/* ============================ time windows ============================ */

// A workout has a start and an end, and nothing in the app closes an abandoned
// one — `end` is stamped when Finish is tapped, whenever that happens. A session
// left open overnight would otherwise claim the whole day's calories as gym work.
// Four hours is past any real session and short enough that the lie stays small.
export const GYM_WINDOW_CAP_MS = 4 * 3600000

// Heart rate is sampled on the watch's own schedule, and the interesting part of
// a session runs a little past the last set (the pulse comes down slowly, which
// is itself a fitness signal). Widening by five minutes each way catches that.
export const HR_PAD_MS = 5 * 60000

// The window a workout actually occupied. `clamped` is surfaced in the UI rather
// than hidden: a truncated window is a worse number, and the user is the only one
// who knows whether they really trained for six hours.
export function gymWindow(w) {
  const start = w.start || new Date(w.d).getTime()
  const rawEnd = w.end || start
  const end = Math.min(rawEnd, start + GYM_WINDOW_CAP_MS)
  return { start, end, clamped: rawEnd > end }
}

// Widened — for heart rate ONLY. Calories must use the exact window: the day
// total is aggregated separately and the two get subtracted from each other, so
// ten padded minutes would be counted into the gym bucket and out of the rest of
// the day at the same time.
export function hrWindow(w) {
  const g = gymWindow(w)
  return { start: g.start - HR_PAD_MS, end: g.end + HR_PAD_MS }
}

// Local midnight to local midnight. Health Connect takes instants, but `w.d` and
// every date the user sees are local calendar days — mixing the two shifts every
// summary by the UTC offset, which in Cairo is a silent three-hour error.
export function localDayRange(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  const start = new Date(y, m - 1, d, 0, 0, 0, 0)
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0)
  return { start: +start, end: +end }
}

export const overlapMs = (a, b) =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))

/* ============================ samples ============================ */

// Samples are stored as [tRelativeMs, bpm] pairs rather than objects: about 55%
// smaller as JSON, and this store gets written to disk on a timer.
export const packSamples = (samples, origin) =>
  samples.map(s => [Math.round(s.t - origin), Math.round(s.bpm)])

export const unpackSamples = (packed, origin) =>
  (packed || []).map(([dt, bpm]) => ({ t: origin + dt, bpm }))

// Lives here rather than in health-sync so that views can read a stored session
// without pulling the whole sync layer (and the Capacitor bridge behind it) into
// the main bundle.
export const sessionSamples = session =>
  session?.samples ? unpackSamples(session.samples, session.window?.[0] || 0) : []

export const sliceSamples = (samples, start, end) =>
  (samples || []).filter(s => s.t >= start && s.t <= end)

// Chart-sized. Bucket averages, not bucket maxima: a max-per-bucket curve looks
// spikier than the session was and quietly overstates the whole trace. The true
// peak is not lost — hrStats runs on the full set before this does.
export function downsample(samples, cap = 240) {
  if (!samples || samples.length <= cap) return samples || []
  const out = []
  const size = samples.length / cap
  for (let i = 0; i < cap; i++) {
    const from = Math.floor(i * size)
    const to = Math.min(samples.length, Math.floor((i + 1) * size))
    if (to <= from) continue
    let sum = 0
    for (let j = from; j < to; j++) sum += samples[j].bpm
    const mid = samples[Math.floor((from + to - 1) / 2)]
    out.push({ t: mid.t, bpm: Math.round(sum / (to - from)) })
  }
  return out
}

export function hrStats(samples) {
  if (!samples || !samples.length) return null
  let sum = 0, max = -Infinity, min = Infinity
  for (const s of samples) { sum += s.bpm; if (s.bpm > max) max = s.bpm; if (s.bpm < min) min = s.bpm }
  return { avg: Math.round(sum / samples.length), max, min, n: samples.length }
}

// The pulse a set actually drove, read at the set rather than averaged over the
// session. A session average says nothing about which exercise cost what —
// squats and leg press land in the same number once you smear them together.
//
// The window leans backwards from the moment the set was ticked, because that is
// when the work happened; a little after, because the peak usually arrives a few
// seconds late.
export function peakNearSets(samples, doneAts, before = 45000, after = 15000) {
  const out = []
  for (const t of doneAts || []) {
    let peak = null
    for (const s of samples || []) {
      if (s.t < t - before) continue
      if (s.t > t + after) break
      if (peak == null || s.bpm > peak) peak = s.bpm
    }
    if (peak != null) out.push(peak)
  }
  return out
}

/* ============================ heart-rate zones ============================ */

// Karvonen: zones off heart-rate *reserve*, not raw percentage of max.
//
// The usual shortcut is 220 − age, which nobody in this app has told us and which
// carries a ±10-12 bpm spread anyway. Reserve needs two numbers we can actually
// measure from the watch — the highest pulse it has seen you hit, and your
// resting rate — and it gets more accurate the longer you train, instead of
// staying wrong forever.
export const ZONE_EDGES = [0.50, 0.60, 0.70, 0.85]   // reserve fractions
export const ZONE_COUNT = 5

export const hrReserve = (bpm, hrMax, rhr) =>
  hrMax > rhr ? (bpm - rhr) / (hrMax - rhr) : 0

export function zoneOf(bpm, hrMax, rhr) {
  const f = hrReserve(bpm, hrMax, rhr)
  for (let i = 0; i < ZONE_EDGES.length; i++) if (f < ZONE_EDGES[i]) return i
  return ZONE_COUNT - 1
}

// Minutes spent in each zone. Each sample carries the gap to the next one rather
// than an assumed interval, because watches drop to a slow polling rate when the
// wrist is still and a fixed step would invent time that was never measured.
export function zoneMinutes(samples, hrMax, rhr) {
  const out = new Array(ZONE_COUNT).fill(0)
  if (!samples || samples.length < 2) return out
  for (let i = 0; i < samples.length - 1; i++) {
    const dt = samples[i + 1].t - samples[i].t
    // A gap longer than five minutes is the watch not reporting, not you holding
    // a heart rate. Counting it would turn a break into "42 minutes in zone 2".
    if (dt <= 0 || dt > 5 * 60000) continue
    out[zoneOf(samples[i].bpm, hrMax, rhr)] += dt / 60000
  }
  return out.map(v => Math.round(v * 10) / 10)
}

/* ============================ session load ============================ */

// Banister TRIMP — the comparable-load number that calories are not.
//
// A watch estimates calories from heart rate, and heart rate under a heavy set
// is driven by pressure and breath-holding as much as by work done, so resistance
// training reads systematically wrong. TRIMP does not pretend to be energy: it is
// duration weighted by how hard the session was relative to *your* reserve, which
// is exactly the comparison the app wants to make between two of your own leg days.
export function trimp(samples, hrMax, rhr, factor = 1.92) {
  if (!samples || samples.length < 2 || !(hrMax > rhr)) return 0
  let total = 0
  for (let i = 0; i < samples.length - 1; i++) {
    const dt = samples[i + 1].t - samples[i].t
    if (dt <= 0 || dt > 5 * 60000) continue
    const f = Math.max(0, Math.min(1, hrReserve(samples[i].bpm, hrMax, rhr)))
    total += (dt / 60000) * f * 0.64 * Math.exp(factor * f)
  }
  return Math.round(total)
}

// Work per minute, in whatever unit the log is in. Distinguishes a heavy hour
// from a long one — the two currently read identically in the history list.
export function density(volume, windowMs) {
  const min = windowMs / 60000
  return min > 0 ? Math.round((volume / min) * 10) / 10 : 0
}

/* ============================ calories ============================ */

// Three buckets, because "you burned 2,300 today" answers nothing: the question
// is what the gym did versus what walking around did.
//
// The subtraction is clamped at zero on purpose. Two sources (the phone's own
// step counter and whatever Health Sync writes) can both hold calorie records,
// and a window aggregate taken from one is not guaranteed to nest inside a day
// aggregate resolved across both. A negative "rest of day" is a data artefact,
// not a fact worth showing.
export function splitCalories({ kcalDay = 0, kcalGym = 0, cardio = [] }) {
  const kcalCardio = cardio.reduce((n, c) => n + (c.kcal || 0), 0)
  const kcalOther = Math.max(0, kcalDay - kcalGym - kcalCardio)
  return {
    gym: Math.round(kcalGym),
    cardio: Math.round(kcalCardio),
    other: Math.round(kcalOther),
    total: Math.round(Math.max(kcalDay, kcalGym + kcalCardio)),
  }
}

// Watch-logged sessions that were not this gym visit. Treadmill work started from
// the watch *inside* the gym window overlaps it heavily and belongs to the gym
// bucket; a run at 6am does not. Half the session outside is the dividing line.
export function cardioOutside(exerciseSessions, gymWin) {
  return (exerciseSessions || []).filter(s => {
    const dur = s.end - s.start
    if (dur <= 0) return false
    return overlapMs(s, gymWin) / dur < 0.5
  }).map(s => ({
    type: s.type || 'workout',
    start: s.start,
    min: Math.round((s.end - s.start) / 60000),
    kcal: Math.round(s.kcal || 0),
  }))
}

/* ============================ sleep ============================ */

// Sleep crosses midnight, so "last night" needs a rule or two readers of the same
// data will disagree.
//
// The rule: the night belonging to day D is the LONGEST sleep session that ENDS
// between D 00:00 and D 12:00, searched from 18:00 the day before. Anchoring on
// the end rather than the start is what makes a 01:30 → 09:00 night belong to the
// morning you woke up in, which is the day whose training it is going to affect.
// The noon cutoff keeps an afternoon nap from being promoted to the main night.
export const SLEEP_SEARCH_FROM_HOUR = 18
export const SLEEP_END_CUTOFF_HOUR = 12

export function sleepSearchRange(iso) {
  const { start } = localDayRange(iso)
  const from = new Date(start); from.setDate(from.getDate() - 1); from.setHours(SLEEP_SEARCH_FROM_HOUR, 0, 0, 0)
  const to = new Date(start); to.setHours(SLEEP_END_CUTOFF_HOUR, 0, 0, 0)
  return { start: +from, end: +to }
}

export function mainSleep(sessions, iso) {
  const range = sleepSearchRange(iso)
  let best = null
  for (const s of sessions || []) {
    if (s.end < range.start || s.end > range.end) continue
    const dur = s.end - s.start
    if (dur <= 0) continue
    if (!best || dur > best.end - best.start) best = s
  }
  if (!best) return null
  const durMin = Math.round((best.end - best.start) / 60000)
  // Efficiency needs staged data; plenty of bridges only pass a total. Reporting
  // null is better than reporting 100%.
  const asleep = best.asleepMin != null ? best.asleepMin : null
  return {
    min: durMin,
    eff: asleep != null && durMin > 0 ? Math.round((asleep / durMin) * 100) : null,
    start: best.start,
    end: best.end,
  }
}

/* ============================ formatting helpers ============================ */

export const sleepLabel = min => {
  const h = Math.floor(min / 60), m = min % 60
  return { h, m }
}
