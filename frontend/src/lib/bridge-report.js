// What the Capacitor bridge itself reports — using nothing but @capacitor/core.
//
// The connection check called into the Health plugin to describe the Health
// plugin, so when that plugin was the thing failing, the check hung with it and
// reported nothing at all. This asks the bridge instead.
//
// What it found, the first time it ran on the affected phone: both plugins
// registered, both answering, the bridge entirely healthy. The failures were on
// the JS side of it — a plugin handle that was never obtained, so no native call
// was ever made. Keeping this report is worth it precisely because it ruled the
// native side out in one screenshot instead of another round of guesses.
//
// Every probe is still bounded and reports 'timeout' as a result rather than
// throwing. Bridge.java's callPluginMethod catches PluginLoadException and
// InvalidPluginMethodException, logs them, and returns without resolving or
// rejecting — so a plugin whose method lookup fails leaves a JS promise pending
// for the life of the process, with no timeout anywhere in Capacitor to catch
// it. A diagnostic that can hang is worse than no diagnostic.

import { Capacitor, registerPlugin } from '@capacitor/core'
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

/**
 * `window.Capacitor.PluginHeaders` is injected by the native bridge from the
 * plugins it actually managed to register (JSExport.getPluginJS). It is the
 * ground truth for "did MainActivity's registerPlugin call take", and it lists
 * every method name each plugin advertises — so a method missing from here is a
 * method that will hang if called.
 */
function headersOf() {
  const raw = (typeof window !== 'undefined' && window.Capacitor?.PluginHeaders) || Capacitor?.PluginHeaders
  return Array.isArray(raw) ? raw : null
}

export async function bridgeReport() {
  const out = { mobileBuild: !!MOBILE }
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

  // The full Health Connect readout, taken straight off the plugin instead of
  // through health-store. That module is the layer that kept failing to produce
  // a handle, and a diagnostic routed through the thing it is diagnosing is how
  // this went several rounds without saying anything useful. If this answers
  // while the store reports an error, the fault is above the bridge.
  const dg = await probe(() => H.diagnose(), 20000)
  out.diagnoseProbe = dg.state === 'ok' ? 'answered' : dg.state === 'timeout' ? 'never answered' : dg.message
  if (dg.state === 'ok') out.diagnose = dg.value
  return out
}
