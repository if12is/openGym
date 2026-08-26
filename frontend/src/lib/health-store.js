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
import { mapAvailabilityReason } from './health-reasons.js'

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
    origins: [],         // [{ pkg, label }] — who writes the data we read
    trusted: null,       // pkg the user picked, so the phone and the watch don't
                         // both get counted for the same steps
    provider: null,      // 'huawei' | 'health-connect' — which native backend granted access
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
  // Night-time spot readings. Additive: nothing breaks if the user declines
  // them, the two cards that use them simply do not appear.
  'READ_OXYGEN_SATURATION',
  'READ_HEART_RATE_VARIABILITY',
]

// Statically imported, and that is load-bearing.
//
// @capacitor/core is its own Vite chunk, so `await import('@capacitor/core')`
// is a network fetch through the service worker, not a function call. At boot
// — which is exactly when the update check and the health boot run — that
// fetch competes with the rest of the app's chunks while the service worker is
// still activating, and it does not come back. Every caller then sat on a
// promise that never settled, so nothing was ever called natively at all: no
// version, no permission picker, no update check.
//
// The bridge itself was never the problem. A connection check on the device
// showed both plugins registered and both answering, at a moment when the chunk
// happened to already be loaded. A static import removes the fetch, so the
// plugin is there before any of this module's code runs.
import { Capacitor, registerPlugin } from '@capacitor/core'

let plugin = null
export async function healthPlugin() {
  if (!MOBILE) return null
  if (plugin) return plugin
  // Vite with VITE_MOBILE=1 still runs on the web platform during `npm run dev`.
  // Calling a custom plugin there never settles, which left the Settings pull
  // button spinning. Checked per call rather than cached: caching a null here
  // meant one early miss disabled the plugin for the rest of the session.
  if (Capacitor.getPlatform() === 'web') return null
  plugin = registerPlugin('Health')
  return plugin
}

// One Health Connect call at a time. WatchCard's mount check, the resume
// boot, the connection-check probe, and the pull button all talk to the
// same Honor binder; two at once is how a working diagnose (7496 steps in
// 65ms) sat next to a pull frozen on 0%.
let healthChain = Promise.resolve()
export function enqueueHealth(fn) {
  const run = healthChain.then(fn, fn)
  healthChain = run.then(() => {}, () => {})
  return run
}

let pullBusy = false
export const isPullingHealth = () => pullBusy

function todayIso() {
  const d = new Date()
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

function withTimeout(p, ms, reason) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(Object.assign(new Error(reason), { code: reason })), ms)
    Promise.resolve(p).then(
      v => { clearTimeout(id); resolve(v) },
      e => { clearTimeout(id); reject(e) },
    )
  })
}

function rejectReason(e, fallback = 'denied') {
  const msg = String(e?.code || e?.message || e || '')
  if (msg.includes('timeout')) return 'timeout'
  if (msg.includes('not-configured')) return 'not-configured'
  if (msg.includes('no-hms')) return 'no-hms'
  if (msg.includes('no-health-app')) return 'no-health-app'
  if (msg.includes('no-picker') || msg.includes('no-activity')) return 'no-picker'
  if (msg.includes('no-bind')) return 'no-bind'
  if (msg.includes('unavailable')) return 'unavailable'
  if (msg.includes('UNIMPLEMENTED') || msg.includes('not implemented')) return 'no-plugin'
  return fallback
}

export { mapAvailabilityReason } from './health-reasons.js'

// Failures come back as a named reason rather than a thrown string, because each
// one needs a different thing from the user:
//   'no-plugin'       — native side isn't in this build
//   'unavailable'     — Health Connect isn't installed (GMS fallback)
//   'update'          — Health Connect installed but too old
//   'denied'          — consent screen dismissed, or heart rate refused
//   'timeout'         — native call never returned
//   'no-picker'       — permission intent could not be launched
//   'no-bind'         — Health Connect store is there but the client never bound
//   'need-permission' — user has not allowed Gemak in Health Connect yet
//   'no-hms'          — HMS Core missing
//   'no-health-app'   — Huawei Health isn't installed
//   'not-configured'  — AppGallery Connect App ID not baked into this APK
export async function checkAvailability() {
  const p = await healthPlugin()
  if (!p) return { ok: false, reason: 'no-plugin' }
  try {
    const r = await withTimeout(p.isAvailable(), 10000, 'timeout')
    const provider = r?.provider || 'health-connect'
    if (r?.available) return { ok: true, provider }
    if (r?.reason === 'timeout') return { ok: false, reason: 'timeout', provider }
    return { ok: false, reason: mapAvailabilityReason(r?.reason), provider }
  } catch (e) { return { ok: false, reason: rejectReason(e, 'timeout') } }
}

export async function connectWatch(deviceLabel) {
  const avail = await checkAvailability()
  if (!avail.ok) return avail

  const p = await healthPlugin()
  let res
  try {
    // Finite. Honor/Huawei often never return from the picker; Settings now
    // opens Health Connect itself for the grant, and the pull button only reads.
    // This timeout is a backstop if something still calls connectWatch.
    res = await withTimeout(
      p.requestAuthorization({ read: READ_SCOPES, requestHistoryAccess: true }),
      25000, 'timeout',
    )
  } catch (e) {
    // The picker may have granted access and simply failed to say so. Ask the
    // platform before reporting a failure the user can see is wrong.
    if (await refreshLinkState() === 'ok') return { ok: true, granted: getConn().granted }
    return { ok: false, reason: rejectReason(e, 'denied') }
  }

  const granted = res?.granted || []
  // Heart rate is the one scope nothing degrades gracefully without — a session
  // with no pulse trace has nothing to show. Everything else is additive.
  // Some providers hand back an empty set from the result contract even when the
  // grant went through, so an apparent refusal is double-checked against what is
  // actually held before it is reported as one.
  if (!granted.includes('READ_HEART_RATE')) {
    if (await refreshLinkState() === 'ok') return { ok: true, granted: getConn().granted }
    return { ok: false, reason: 'denied', granted }
  }

  const provider = res?.provider || avail.provider || 'health-connect'
  updateConn(c => {
    c.state = 'ok'
    c.granted = granted
    c.grantedAt = Date.now()
    c.history = provider === 'huawei' ? true : !!res?.historyAccessAuthorized
    c.deviceLabel = deviceLabel || c.deviceLabel
    c.provider = provider
  })
  return { ok: true, granted, provider }
}

// Called on every resume. Health Connect withdraws permissions silently after a
// month of not opening the app, so a stored `state: 'ok'` is a claim to re-check,
// not a fact to trust.
export async function refreshLinkState() {
  if (pullBusy) return state.conn.state
  const p = await healthPlugin()
  if (!p) return state.conn.state
  let granted
  let provider
  try {
    const res = await enqueueHealth(() =>
      withTimeout(p.checkAuthorization({ read: READ_SCOPES }), 10000, 'timeout'),
    )
    granted = res?.granted || []
    provider = res?.provider
  } catch (e) {
    const r = rejectReason(e, 'timeout')
    if (r === 'no-bind') return 'no-bind'
    return state.conn.state   // leave the last known state rather than guess
  }
  const ok = granted.includes('READ_HEART_RATE')

  // This runs on every resume, and it is deliberately allowed to promote a link
  // that was never confirmed.
  //
  // The permission picker is a system activity, and on some devices it grants
  // access and then never delivers a result back — the callback is simply lost.
  // Before this, that left the app saying "not linked" while Health Connect said
  // it had access, with no way out but unlinking and trying again. Asking the
  // platform what is actually granted makes the whole flow self-healing: come
  // back to the app and it has caught up, however the picker behaved.
  if (state.conn.state === 'off') {
    if (!ok) return 'off'
    updateConn(c => {
      c.state = 'ok'
      c.granted = granted
      c.grantedAt = c.grantedAt || Date.now()
      if (provider) c.provider = provider
      if (provider === 'huawei') c.history = true
    })
    return 'ok'
  }

  updateConn(c => {
    c.state = ok ? 'ok' : 'revoked'
    c.granted = granted
    if (provider) c.provider = provider
  })
  return state.conn.state
}

// Unlinking drops what came from the watch. It never touches the training log —
// those are the user's own entries and have nothing to do with the device.
export function disconnectWatch() {
  healthPlugin().then(p => p?.signOut?.()).catch(() => {})
  updateHealth(h => {
    h.conn = { ...clone(DEF_HEALTH.conn) }
    h.days = {}
    h.sessions = {}
    h.base = {}
  })
}

export async function openHealthConnectSettings() {
  const p = await healthPlugin()
  if (!p) return false
  try {
    // Always prefer the Health Connect permission screen. Honor/Huawei with
    // Health Sync need that store, not Huawei Health. Kit still has its own
    // openSettings when the native side is on that backend.
    if (typeof p.openHealthConnectPermissions === 'function' && getConn().provider !== 'huawei') {
      await withTimeout(p.openHealthConnectPermissions(), 8000, 'timeout')
      return true
    }
    await withTimeout(p.openSettings(), 8000, 'timeout')
    return true
  } catch (e) { return false }
}

/**
 * Opens Health Connect itself (per-app permission page when the OS has one).
 * This is the Honor/Huawei grant path: the in-app picker never appears there,
 * so Settings asks Health Connect directly and the pull button only reads.
 */
export async function openHealthConnectPermissions() {
  const p = await healthPlugin()
  if (!p) return false
  try {
    if (typeof p.openHealthConnectPermissions === 'function') {
      await withTimeout(p.openHealthConnectPermissions(), 8000, 'timeout')
      return true
    }
    await withTimeout(p.openSettings(), 8000, 'timeout')
    return true
  } catch (e) { return false }
}

/**
 * Read what is already granted. Does not launch a permission picker — Honor
 * and Huawei hang on that sheet. Allow from Health Connect first.
 */
// Bounded, because this is a lazy chunk — a fetch through the service worker,
// not a function call. An unbounded await on one of these is exactly what left
// the update card and the connection check spinning with nothing to show.
export const loadHealthSync = () => withTimeout(import('./health-sync.js'), 10000, 'chunk-timeout')

export async function pullWatchData(days = 7, onProgress) {
  const note = (frac, info) => { try { onProgress?.(frac, info) } catch (e) { /* UI */ } }
  pullBusy = true
  note(0.01, { step: 'checking' })
  const p = await healthPlugin()
  if (!p) {
    pullBusy = false
    return { ok: false, reason: 'no-plugin' }
  }

  // Do not call checkAuthorization here. Settings already fires that on
  // mount, and a second binder call is what froze the pull at 0% while
  // diagnose — the same probe — returned 7,496 steps in 65ms. Probe is
  // the grant check: not-authorized means we need permission, data means
  // we are allowed, and the steps land in today's row before anything
  // else can hang.
  note(0.05, { step: 'probe', state: 'start' })
  let probe = null
  try {
    const now = Date.now()
    if (typeof p.probe !== 'function') {
      note(0.1, { step: 'probe', state: 'skip' })
    } else {
      probe = await enqueueHealth(() =>
        withTimeout(p.probe({ start: now - 86400000, end: now }), 12000, 'timeout'),
      )
      const origins = Array.isArray(probe?.origins)
        ? probe.origins
        : (probe?.origins && typeof probe.origins.length === 'number'
          ? Array.from(probe.origins)
          : [])
      note(0.15, {
        step: 'probe',
        state: 'ok',
        records: probe?.records,
        steps: probe?.steps,
        ms: probe?.ms,
        origins: origins.filter(Boolean),
      })
      const iso = todayIso()
      updateHealth(h => {
        h.conn.state = 'ok'
        h.conn.grantedAt = h.conn.grantedAt || Date.now()
        h.conn.provider = h.conn.provider || 'health-connect'
        if (!h.conn.deviceLabel) h.conn.deviceLabel = 'Huawei Watch Fit 4'
        if (probe?.steps != null || (probe?.records || 0) > 0) {
          h.days[iso] = {
            ...(h.days[iso] || {}),
            steps: probe.steps ?? h.days[iso]?.steps,
            syncedAt: Date.now(),
            src: (origins.filter(Boolean)[0] || h.days[iso]?.src || null),
          }
        }
      })
    }
  } catch (e) {
    const reason = rejectReason(e, 'timeout')
    probe = { ok: false, reason }
    note(0.15, { step: 'probe', state: 'fail', reason })
    pullBusy = false
    if (reason === 'denied') return { ok: false, reason: 'need-permission' }
    return { ok: false, reason }
  }

  try {
    const m = await loadHealthSync()
    const n = await withTimeout(
      m.syncRecentDays(days, (frac, info) => note(0.15 + frac * 0.85, info)),
      180000, 'timeout',
    )
    if (n > 0) return { ok: true, days: n }
    if (probe && (probe.steps != null || (probe.records || 0) > 0)) return { ok: true, days: 1 }
    if (probe && probe.reason === 'timeout') return { ok: false, reason: 'timeout' }
    return { ok: true, days: 0 }
  } catch (e) {
    if (probe && (probe.steps != null || (probe.records || 0) > 0)) {
      return { ok: true, days: 1 }
    }
    return { ok: false, reason: rejectReason(e, 'error') }
  } finally {
    pullBusy = false
  }
}

/**
 * A readout of every step of the link, for when it fails on a phone nobody can
 * put a cable into.
 *
 * Each field answers a question that otherwise takes a round of guessing:
 * whether Health Connect is there at all, whether the permission declarations
 * survived into the installed APK, what intent the picker actually builds on
 * this Android version, and what the platform currently holds. Every native
 * step is timed out on its own side, so this resolves even when the thing it is
 * diagnosing is the hang.
 */
export async function diagnoseHealth() {
  let p
  // healthPlugin() awaits a dynamic import, which is a chunk fetch on the mobile
  // build — bounded like everything else, because an unbounded await here is
  // what left the check itself sitting on "Checking…".
  try {
    p = await withTimeout(healthPlugin(), 5000, 'timeout')
  } catch (e) {
    return { error: 'could not get the plugin handle: ' + (e?.message || e) }
  }
  // These two used to collapse into the same 'no-plugin' code, which is why it
  // took an extra round to tell them apart: "the handle is null" and "the method
  // rejected as unimplemented" need completely different fixes.
  if (!p) return { error: `handle is null (mobile=${MOBILE}, platform=${Capacitor.getPlatform()})` }
  try {
    // 40s: diagnose now includes a timed steps probe + aggregate probe, each
    // of which can take up to ~6s after the bind/grant checks.
    return await enqueueHealth(() => withTimeout(p.diagnose(), 40000, 'timeout'))
  } catch (e) {
    // Raw, not mapped. rejectReason() exists to pick a recovery path for the
    // user, and it turned "Health.diagnose() is not implemented" into
    // 'no-plugin' — the one screen where the actual text is the whole point.
    return { error: String(e?.message || e?.code || e).slice(0, 200) }
  }
}

export async function installHealthConnect() {
  const p = await healthPlugin()
  try { await p?.openPlayStore() } catch (e) { /* nothing to fall back to */ }
}
