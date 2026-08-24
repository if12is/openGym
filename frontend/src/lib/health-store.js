// Health store — everything the watch contributes, kept apart from the training log.
//
// Deliberately NOT part of `S` (useStore). Health data is bound to *this phone*,
// not to the profile: Health Connect lives on the device, so pushing it through
// /api/data would drop another phone's readings onto this one. Four more reasons
// it stays out:
//   · update() deep-clones all of S on every mutation — including every set tap
//     during a workout. Heart-rate samples in there get copied hundreds of times
//     a session for nothing.
//   · persist() writes S to localStorage unguarded, so a quota error thrown from
//     there would break every write in the app, not just this feature.
//   · the server caps a body at 5 MB and destroys the request past it, which
//     would wedge gym_dirty on forever.
//   · the JSON backup is meant to be portable between devices; watch samples are
//     the one thing in the app that isn't.
// So: own key, own file mirror, never pushed, never exported.
//
// Shape:
//   conn      the link itself — permissions, source, last sync
//   days      one summary row per local calendar day, cheap and kept forever
//   sessions  per-workout detail, keyed by workout.id, sample arrays pruned by age
//   base      rolling baselines. Every "high" or "low" the app claims is relative
//             to these, never to a population number.

import { MOBILE } from './mobile.js'

const KEY = 'gym_health_v1'
const FILE = 'opengym-health.json'

// How long raw per-session samples are worth keeping. The summary (average, max,
// zones, TRIMP) is what every chart older than this reads, and it is ~40 bytes;
// the trace behind it is ~3 kB and nobody scrolls back to a pulse curve from
// last spring.
export const SAMPLE_RETENTION_DAYS = 90

export const DEF_HEALTH = {
  v: 1,
  conn: {
    // 'off'     — never linked, or the user unlinked
    // 'ok'      — permissions granted and confirmed on the last check
    // 'revoked' — was linked, but Health Connect has since withdrawn access.
    //             Android drops health permissions after ~30 days without a
    //             launch, so this is a normal state to return to, not an error.
    state: 'off',
    deviceLabel: null,
    granted: [],
    grantedAt: null,
    lastSyncAt: null,
    history: false,      // READ_HEALTH_DATA_HISTORY — gates anything older than 30 days
    origins: [],         // [{ pkg, label }] — who writes into Health Connect
    trusted: null,       // pkg the user picked, so the phone and the watch don't
                         // both get counted for the same steps
  },
  days: {},              // iso → { sleepMin, sleepEff, sleepEnd, rhr, steps, kcalActive, kcalTotal, spo2, src }
  sessions: {},          // workoutId → see health-sync.buildSession
  base: {},              // { rhr7, rhr28, sleep14, kcal14, hrMaxObserved, loadWeek }
}

const clone = o => JSON.parse(JSON.stringify(o))

let state = load()
const subs = new Set()

// Deep-merge the known sub-objects rather than Object.assign at the top level: a
// shallow merge silently drops any field added to DEF_HEALTH after this profile
// last saved, and every read of it below would then hit undefined. (The same
// latent gap exists in useStore's DEF merge — it just hasn't bitten yet.)
function hydrate(parsed) {
  return {
    ...clone(DEF_HEALTH),
    ...parsed,
    conn: { ...clone(DEF_HEALTH.conn), ...(parsed.conn || {}) },
    days: parsed.days || {},
    sessions: parsed.sessions || {},
    base: parsed.base || {},
  }
}

function load() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return hydrate(JSON.parse(raw))
  } catch (e) { /* unreadable — start clean */ }
  return clone(DEF_HEALTH)
}

let saveTm = null
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch (e) {
    // Quota. Drop the sample traces — they are the only thing here big enough to
    // cause this, and they are also the only thing that can be re-read from
    // Health Connect later. Losing them beats losing the write.
    try {
      Object.values(state.sessions).forEach(s => { delete s.samples })
      localStorage.setItem(KEY, JSON.stringify(state))
    } catch (e2) { /* file mirror below is the durable copy */ }
  }
  if (MOBILE) {
    clearTimeout(saveTm)
    saveTm = setTimeout(() => { saveTm = null; fileSave() }, 800)
  }
  subs.forEach(f => f())
}

async function fileSave() {
  try {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
    await Filesystem.writeFile({ path: FILE, directory: Directory.Data, data: JSON.stringify(state), encoding: Encoding.UTF8 })
  } catch (e) { /* keep the localStorage copy */ }
}

// The file is the durable copy — the WebView can evict localStorage under storage
// pressure, and on the mobile build there is no server to re-pull from.
export async function loadHealthFromDisk() {
  if (!MOBILE) return state
  try {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
    const r = await Filesystem.readFile({ path: FILE, directory: Directory.Data, encoding: Encoding.UTF8 })
    const saved = JSON.parse(r.data)
    if (saved && saved.conn) { state = hydrate(saved); subs.forEach(f => f()) }
  } catch (e) { /* first launch — localStorage copy stands */ }
  return state
}

export const getHealth = () => state
export const getConn = () => state.conn
export const getDay = iso => state.days[iso] || null
export const getSession = id => state.sessions[id] || null
export const getBase = () => state.base

export function subscribeHealth(fn) { subs.add(fn); return () => subs.delete(fn) }

export function updateHealth(mut) {
  const next = clone(state)
  mut(next)
  state = next
  save()
  return state
}

export const updateConn = mut => updateHealth(h => mut(h.conn))

// Called at boot. Two jobs, both cheap:
//   · a workout deleted from History leaves its session row behind forever
//   · sample traces past the retention window are dead weight in every save
export function pruneHealth(workoutIds) {
  const live = new Set(workoutIds)
  const cutoff = Date.now() - SAMPLE_RETENTION_DAYS * 86400000
  let dirty = false
  const next = clone(state)
  Object.keys(next.sessions).forEach(id => {
    if (!live.has(id)) { delete next.sessions[id]; dirty = true; return }
    const s = next.sessions[id]
    if (s.samples && (s.window?.[0] || s.builtAt || 0) < cutoff) { delete s.samples; dirty = true }
  })
  if (!dirty) return state
  state = next
  save()
  return state
}

/* ============================ native bridge ============================ */

// Read-only scopes. Kept as narrow as the features allow: Health Connect shows
// every declared permission on a single consent screen, and a long list is what
// makes people decline the whole thing.
export const READ_SCOPES = [
  'READ_HEART_RATE',
  'READ_STEPS',
  'READ_ACTIVE_CALORIES_BURNED',
  'READ_TOTAL_CALORIES_BURNED',
  'READ_SLEEP',
  'READ_RESTING_HEART_RATE',
  'READ_EXERCISE',
]

let plugin = null
export async function healthPlugin() {
  if (!MOBILE) return null
  if (plugin) return plugin
  try {
    const { registerPlugin } = await import('@capacitor/core')
    plugin = registerPlugin('Health')
    return plugin
  } catch (e) { return null }
}

// Failures come back as a named reason rather than a thrown string, because each
// one needs a different thing from the user:
//   'no-plugin'   — native side isn't in this build
//   'unavailable' — Health Connect isn't installed on this phone
//   'update'      — installed but too old
//   'denied'      — consent screen dismissed, or heart rate refused
export async function checkAvailability() {
  const p = await healthPlugin()
  if (!p) return { ok: false, reason: 'no-plugin' }
  try {
    const r = await p.isAvailable()
    if (r?.available) return { ok: true }
    return { ok: false, reason: r?.reason === 'update-required' ? 'update' : 'unavailable' }
  } catch (e) { return { ok: false, reason: 'no-plugin' } }
}

export async function connectWatch(deviceLabel) {
  const avail = await checkAvailability()
  if (!avail.ok) return avail

  const p = await healthPlugin()
  let res
  try {
    res = await p.requestAuthorization({ read: READ_SCOPES, requestHistoryAccess: true })
  } catch (e) {
    return { ok: false, reason: 'denied' }
  }

  const granted = res?.granted || []
  // Heart rate is the one scope nothing degrades gracefully without — a session
  // with no pulse trace has nothing to show. Everything else is additive.
  if (!granted.includes('READ_HEART_RATE')) return { ok: false, reason: 'denied', granted }

  updateConn(c => {
    c.state = 'ok'
    c.granted = granted
    c.grantedAt = Date.now()
    c.history = !!res?.historyAccessAuthorized
    c.deviceLabel = deviceLabel || c.deviceLabel
  })
  return { ok: true, granted }
}

// Called on every resume. Health Connect withdraws permissions silently after a
// month of not opening the app, so a stored `state: 'ok'` is a claim to re-check,
// not a fact to trust.
export async function refreshLinkState() {
  if (state.conn.state === 'off') return 'off'
  const p = await healthPlugin()
  if (!p) return state.conn.state
  try {
    const res = await p.checkAuthorization({ read: READ_SCOPES })
    const granted = res?.granted || []
    const ok = granted.includes('READ_HEART_RATE')
    updateConn(c => { c.state = ok ? 'ok' : 'revoked'; c.granted = granted })
  } catch (e) { /* leave the last known state rather than guess */ }
  return state.conn.state
}

// Unlinking drops what came from the watch. It never touches the training log —
// those are the user's own entries and have nothing to do with the device.
export function disconnectWatch() {
  updateHealth(h => {
    h.conn = { ...clone(DEF_HEALTH.conn) }
    h.days = {}
    h.sessions = {}
    h.base = {}
  })
}

export async function openHealthConnectSettings() {
  const p = await healthPlugin()
  try { await p?.openSettings() } catch (e) { /* nothing to fall back to */ }
}

export async function installHealthConnect() {
  const p = await healthPlugin()
  try { await p?.openPlayStore() } catch (e) { /* nothing to fall back to */ }
}
