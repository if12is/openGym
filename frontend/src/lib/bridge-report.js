// What the Capacitor bridge itself reports — using nothing but @capacitor/core.
//
// The connection check called into the Health plugin to describe the Health
// plugin, so when that plugin was the thing failing, the check hung with it and
// reported nothing at all. This asks the bridge instead.
//
// It is worth knowing exactly what can go wrong on the native side, because two
// of the three outcomes are silent:
//
//   · the plugin is not registered      → JS throws "not implemented", fast
//   · the plugin is registered but the method lookup fails
//     (PluginLoadException / InvalidPluginMethodException) → Bridge.java logs it
//     and returns without resolving or rejecting the call. The JS promise stays
//     pending forever. There is no timeout anywhere in Capacitor for this.
//   · the method runs and never calls resolve() → same pending promise
//
// Only the first is visible from JS as an error. The other two are why every
// probe here is bounded and reports 'timeout' as a result rather than throwing:
// a diagnostic that can hang is worse than no diagnostic.

import { MOBILE } from './mobile.js'

// Resolves, never rejects — the outcome is the data.
function probe(run, ms = 6000) {
  return new Promise(resolve => {
    const id = setTimeout(() => resolve({ state: 'timeout' }), ms)
    let p
    try { p = Promise.resolve(run()) } catch (e) {
      clearTimeout(id)
      return resolve({ state: 'error', message: String(e?.message || e?.code || e) })
    }
    p.then(
      v => { clearTimeout(id); resolve({ state: 'ok', value: v }) },
      e => { clearTimeout(id); resolve({ state: 'error', message: String(e?.message || e?.code || e) }) },
    )
  })
}

async function core() {
  // Even the module load is bounded: it is a separate chunk on the mobile build,
  // so it is a fetch through the service worker, not a function call.
  const r = await probe(() => import('@capacitor/core'), 5000)
  return r.state === 'ok' ? r.value : null
}

/**
 * `window.Capacitor.PluginHeaders` is injected by the native bridge from the
 * plugins it actually managed to register (JSExport.getPluginJS). It is the
 * ground truth for "did MainActivity's registerPlugin call take", and it lists
 * every method name each plugin advertises — so a method missing from here is a
 * method that will hang if called.
 */
function headersOf(Capacitor) {
  const raw = (typeof window !== 'undefined' && window.Capacitor?.PluginHeaders) || Capacitor?.PluginHeaders
  return Array.isArray(raw) ? raw : null
}

export async function bridgeReport() {
  const out = { mobileBuild: !!MOBILE }
  const cap = await core()
  if (!cap) { out.error = 'capacitor-core-unreachable'; return out }

  const { Capacitor, registerPlugin } = cap
  out.platform = Capacitor?.getPlatform?.() || 'unknown'
  out.native = !!Capacitor?.isNativePlatform?.()

  const headers = headersOf(Capacitor)
  out.headersFound = !!headers
  out.plugins = headers ? headers.map(h => h.name).sort() : []

  const named = name => headers?.find(h => h.name === name) || null
  const health = named('Health')
  const appUpdate = named('AppUpdate')
  out.healthRegistered = !!health
  out.appUpdateRegistered = !!appUpdate
  out.healthMethods = health ? (health.methods || []).map(m => m.name).sort() : []
  out.appUpdateMethods = appUpdate ? (appUpdate.methods || []).map(m => m.name).sort() : []

  if (!out.native) return out

  // Probe each custom plugin with its cheapest method. Both are pure local
  // lookups with no I/O, so anything other than a prompt answer means the call
  // never reached the method body.
  const H = registerPlugin('Health')
  const U = registerPlugin('AppUpdate')
  const [h, u] = await Promise.all([
    probe(() => H.isAvailable(), 8000),
    probe(() => U.getAppVersion(), 8000),
  ])
  out.healthProbe = h.state === 'ok' ? 'answered' : h.state === 'timeout' ? 'never answered' : h.message
  out.appUpdateProbe = u.state === 'ok'
    ? `answered (${u.value?.versionName} ${u.value?.versionCode})`
    : u.state === 'timeout' ? 'never answered' : u.message
  return out
}
