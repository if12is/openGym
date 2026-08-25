// In-app update checker for the Capacitor Android build.
// Compares the installed versionCode with app-version.json on GitHub,
// downloads the APK (resumable via HTTP Range), then opens the system installer.

import { useEffect, useState } from 'react'
import { MOBILE } from './mobile.js'
import { t } from './i18n.js'

const MANIFEST_URL = import.meta.env.VITE_UPDATE_MANIFEST ||
  'https://github.com/if12is/openGym/releases/download/android-latest/app-version.json'

const APK_PATH = 'updates/gemak-latest.apk'
const APK_META = 'updates/gemak-latest.json'
const PROGRESS_META = 'updates/gemak-latest.progress.json'
const BATCH = 256 * 1024

let plugin = null
async function appUpdatePlugin() {
  if (!MOBILE) return null
  if (plugin) return plugin
  try {
    const { registerPlugin } = await import('@capacitor/core')
    plugin = registerPlugin('AppUpdate')
    return plugin
  } catch { return null }
}

async function fs() {
  return import('@capacitor/filesystem')
}

export async function getInstalledVersion() {
  const p = await appUpdatePlugin()
  if (p?.getAppVersion) {
    try { return await p.getAppVersion() } catch { /* fall through */ }
  }
  return {
    versionName: import.meta.env.VITE_APP_VERSION || '0',
    versionCode: Number(import.meta.env.VITE_APP_VERSION_CODE || 0),
  }
}

// Native first, and not as an optimisation.
//
// GitHub release assets 302 to a storage host and send no CORS headers on either
// hop, so a fetch() from the WebView's https://localhost origin is a cross-origin
// request that never completes — it hung rather than rejecting, which is what
// left the update card sitting on "Checking…" with nothing to retry. Java has no
// same-origin policy to answer to, and takes a real timeout.
//
// The fetch path stays for `npm run dev` in a browser, where there is no plugin.
export async function fetchRemoteManifest() {
  const p = await appUpdatePlugin()
  if (p) {
    try {
      const r = await p.httpGet({ url: MANIFEST_URL })
      return JSON.parse(r.body)
    } catch (e) {
      // An older APK predates httpGet; anything else is a real network failure
      // and should be reported rather than retried over a route that cannot work.
      if (!isUnimplemented(e)) throw new Error(e?.message || 'network')
    }
  }
  const ctrl = new AbortController()
  const tm = setTimeout(() => ctrl.abort(), 20000)
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-store', signal: ctrl.signal })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return await res.json()
  } finally { clearTimeout(tm) }
}

// Capacitor's registerPlugin returns a proxy, so every method looks callable —
// a missing one only shows up as this rejection at call time.
const isUnimplemented = e =>
  /not implemented|unimplemented|no such method/i.test(e?.message || e?.code || '')

export function isNewer(remote, local) {
  return Number(remote?.versionCode) > Number(local?.versionCode)
}

export function parseContentRange(header) {
  const m = String(header || '').match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i)
  if (!m) return null
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? 0 : Number(m[3]) }
}

export function resumeOffset(partial, remote) {
  if (!partial || !remote) return 0
  if (Number(partial.versionCode) !== Number(remote.versionCode)) return 0
  if (partial.url && remote.apkUrl && partial.url !== remote.apkUrl) return 0
  const loaded = Number(partial.loaded) || 0
  const total = Number(partial.total) || 0
  if (total > 0 && loaded >= total) return loaded
  return loaded > 0 ? loaded : 0
}

export function classifyUpdate({ local, remote, pending, partial }) {
  if (pending && isNewer(pending, local) && !(remote && isNewer(remote, pending))) return 'ready'
  if (remote && isNewer(remote, local)) {
    if (partial && resumeOffset(partial, remote) > 0) return 'resume'
    return 'available'
  }
  return 'latest'
}

export async function checkForUpdate() {
  if (!MOBILE) return { available: false }
  const [local, remote] = await Promise.all([getInstalledVersion(), fetchRemoteManifest()])
  return {
    available: isNewer(remote, local),
    local,
    remote,
  }
}

export async function getPendingInstall() {
  if (!MOBILE) return null
  try {
    const { Filesystem, Directory, Encoding } = await fs()
    const r = await Filesystem.readFile({ path: APK_META, directory: Directory.Cache, encoding: Encoding.UTF8 })
    const meta = JSON.parse(r.data)
    const stat = await Filesystem.stat({ path: APK_PATH, directory: Directory.Cache })
    const total = Number(meta.bytes) || 0
    if (total > 0 && Number(stat.size) < total) return null
    return { ...meta, bytes: Number(stat.size) || meta.bytes }
  } catch { return null }
}

export async function getPartialDownload() {
  if (!MOBILE) return null
  try {
    const { Filesystem, Directory, Encoding } = await fs()
    const r = await Filesystem.readFile({ path: PROGRESS_META, directory: Directory.Cache, encoding: Encoding.UTF8 })
    const meta = JSON.parse(r.data)
    const stat = await Filesystem.stat({ path: APK_PATH, directory: Directory.Cache })
    return { ...meta, loaded: Number(stat.size) || 0 }
  } catch { return null }
}

// Returns the finished meta, or null when the native side cannot do it (an older
// APK) so the caller falls through to the JS download rather than failing.
async function tryNativeDownload(remote, notify) {
  const p = await appUpdatePlugin()
  if (!p) return null
  const { Filesystem, Directory } = await fs()

  let dest
  try {
    const uri = await Filesystem.getUri({ path: APK_PATH, directory: Directory.Cache })
    dest = decodeURIComponent(String(uri.uri).replace(/^file:\/\//, ''))
  } catch { return null }

  let start = 0
  const partial = await getPartialDownload()
  const off = resumeOffset(partial, remote)
  if (off > 0) start = off
  else if (partial || await getPendingInstall()) await discardStaleDownload()

  let sub = null
  try {
    sub = await p.addListener('downloadProgress', ev => {
      const total = Number(ev?.total) || 0
      if (total > 0) notify(Math.min(1, Number(ev.loaded) / total))
    })
    const res = await p.downloadFile({ url: remote.apkUrl, path: dest, offset: start })
    const meta = {
      versionName: remote.versionName,
      versionCode: remote.versionCode,
      downloadedAt: Date.now(),
      bytes: Number(res?.bytes) || 0,
    }
    await writeJson(APK_META, meta)
    await deleteQuiet(PROGRESS_META)
    notify(1)
    return meta
  } catch (e) {
    if (isUnimplemented(e)) return null
    throw new Error(e?.message || 'download failed')
  } finally {
    try { await sub?.remove() } catch { /* listener already gone */ }
  }
}

async function writeJson(path, obj) {
  const { Filesystem, Directory, Encoding } = await fs()
  await Filesystem.writeFile({
    path, directory: Directory.Cache,
    data: JSON.stringify(obj), encoding: Encoding.UTF8,
  })
}

async function deleteQuiet(path) {
  try {
    const { Filesystem, Directory } = await fs()
    await Filesystem.deleteFile({ path, directory: Directory.Cache })
  } catch { /* missing is fine */ }
}

export async function discardStaleDownload() {
  await deleteQuiet(APK_PATH)
  await deleteQuiet(APK_META)
  await deleteQuiet(PROGRESS_META)
}

function bytesToBase64(bytes) {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

let downloadJob = null

export function isDownloading() {
  return !!downloadJob
}

async function writeProgress(remote, loaded, total) {
  await writeJson(PROGRESS_META, {
    versionName: remote.versionName,
    versionCode: remote.versionCode,
    url: remote.apkUrl,
    loaded,
    total,
    updatedAt: Date.now(),
  })
}

export async function downloadUpdate(remote, onProgress) {
  if (!MOBILE) throw new Error('mobile only')
  if (downloadJob && Number(downloadJob.versionCode) === Number(remote.versionCode)) {
    if (onProgress) downloadJob.listeners.add(onProgress)
    return downloadJob.promise
  }

  const listeners = new Set()
  if (onProgress) listeners.add(onProgress)
  const notify = p => listeners.forEach(fn => { try { fn(p) } catch { /* */ } })

  const run = (async () => {
    const url = remote.apkUrl
    if (!url) throw new Error('no apkUrl')
    const { Filesystem, Directory } = await fs()
    await Filesystem.mkdir({ path: 'updates', directory: Directory.Cache, recursive: true }).catch(() => {})

    // Same CORS wall as the manifest, and the APK is ~10 MB — so when the native
    // side can do it, the bytes go straight to disk instead of crossing the
    // bridge as base64. The JS implementation below stays as the fallback.
    const native = await tryNativeDownload(remote, notify)
    if (native) return native

    let start = 0
    const partial = await getPartialDownload()
    const off = resumeOffset(partial, remote)
    if (off > 0) start = off
    else if (partial || await getPendingInstall()) await discardStaleDownload()

    const headers = {}
    if (start > 0) headers.Range = `bytes=${start}-`
    const res = await fetch(url, { headers, cache: 'no-store' })

    if (start > 0 && res.status === 200) {
      start = 0
      await discardStaleDownload()
    }
    if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status)

    const range = parseContentRange(res.headers.get('content-range'))
    const chunkLen = Number(res.headers.get('content-length')) || 0
    const total = range?.total || (start > 0 ? start + chunkLen : chunkLen) || 0

    if (total > 0 && start >= total) {
      notify(1)
      const meta = { versionName: remote.versionName, versionCode: remote.versionCode, downloadedAt: Date.now(), bytes: start }
      await writeJson(APK_META, meta)
      await deleteQuiet(PROGRESS_META)
      return meta
    }

    const reader = res.body?.getReader()
    let loaded = start
    let leftover = new Uint8Array(0)
    let firstWrite = start === 0

    const flush = async (bytes, last) => {
      if (!bytes.length) return
      const payload = last ? bytes : bytes.subarray(0, bytes.length - (bytes.length % 3))
      const rest = last ? new Uint8Array(0) : bytes.subarray(payload.length)
      leftover = rest
      if (!payload.length) return
      const data = bytesToBase64(payload)
      if (firstWrite) {
        await Filesystem.writeFile({ path: APK_PATH, directory: Directory.Cache, data })
        firstWrite = false
      } else {
        await Filesystem.appendFile({ path: APK_PATH, directory: Directory.Cache, data })
      }
    }

    const persist = async () => {
      try {
        const stat = await Filesystem.stat({ path: APK_PATH, directory: Directory.Cache })
        loaded = Number(stat.size) || loaded
      } catch { /* still using counted loaded */ }
      await writeProgress(remote, loaded, total)
      notify(total ? Math.min(1, loaded / total) : 0)
    }

    if (!reader) {
      const buf = new Uint8Array(await (await res.blob()).arrayBuffer())
      leftover = concatBytes(leftover, buf)
      loaded = start + buf.length
      await flush(leftover, true)
      leftover = new Uint8Array(0)
      await persist()
    } else {
      let sinceFlush = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        leftover = concatBytes(leftover, value)
        loaded += value.length
        sinceFlush += value.length
        if (leftover.length >= BATCH) {
          await flush(leftover, false)
          sinceFlush = 0
          await persist()
        } else if (sinceFlush >= BATCH) {
          await persist()
          sinceFlush = 0
        } else if (total) notify(Math.min(1, loaded / total))
      }
      await flush(leftover, true)
      leftover = new Uint8Array(0)
      await persist()
    }

    notify(1)
    const meta = { versionName: remote.versionName, versionCode: remote.versionCode, downloadedAt: Date.now(), bytes: loaded }
    await writeJson(APK_META, meta)
    await deleteQuiet(PROGRESS_META)
    return meta
  })()

  downloadJob = { versionCode: remote.versionCode, listeners, promise: run }
  try {
    return await run
  } finally {
    if (downloadJob?.promise === run) downloadJob = null
  }
}

export async function installPendingUpdate() {
  if (!MOBILE) throw new Error('mobile only')
  const { Filesystem, Directory } = await fs()
  const stat = await Filesystem.stat({ path: APK_PATH, directory: Directory.Cache })
  const p = await appUpdatePlugin()
  if (!p?.installApk) throw new Error(t('Install not available'))
  await p.installApk({ uri: stat.uri })
}

/* ---- shared UI state (Home banner + Settings card) ---- */

const idleState = () => ({
  phase: 'idle', // idle | checking | available | downloading | ready | latest | error
  local: null,
  remote: null,
  pending: null,
  progress: 0,
  error: null,
})

let updateState = idleState()
const updateSubs = new Set()

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch }
  updateSubs.forEach(fn => fn(updateState))
}

export function getUpdateState() { return updateState }
export function subscribeUpdate(fn) {
  updateSubs.add(fn)
  return () => updateSubs.delete(fn)
}

export function useAppUpdate() {
  const [s, setS] = useState(updateState)
  useEffect(() => subscribeUpdate(setS), [])
  return s
}

export async function bootAppUpdate() {
  if (!MOBILE) return getUpdateState()
  if (downloadJob) return getUpdateState()
  setUpdateState({ phase: 'checking', error: null })
  const local = await getInstalledVersion()
  // Publish the installed version before going near the network. It is known
  // locally and costs nothing, and without it the card had nothing to show but
  // "Checking…" — so a network problem looked identical to a hang.
  setUpdateState({ phase: 'checking', local })
  let pending = await getPendingInstall()
  let partial = await getPartialDownload()
  let remote = null
  try {
    remote = await fetchRemoteManifest()
  } catch (e) {
    if (pending && isNewer(pending, local)) {
      setUpdateState({ phase: 'ready', local, remote: pending, pending, progress: 1 })
      return getUpdateState()
    }
    setUpdateState({ phase: 'error', local, error: e.message || String(e) })
    return getUpdateState()
  }

  if (pending && remote && isNewer(remote, pending)) {
    await discardStaleDownload()
    pending = null
    partial = await getPartialDownload()
  }

  const kind = classifyUpdate({ local, remote, pending, partial })
  if (kind === 'ready') {
    setUpdateState({ phase: 'ready', local, remote, pending, progress: 1 })
    return getUpdateState()
  }
  if (kind === 'resume') {
    setUpdateState({ phase: 'downloading', local, remote, progress: resumeOffset(partial, remote) / (Number(partial.total) || 1) })
    try {
      const meta = await downloadUpdate(remote, p => setUpdateState({ phase: 'downloading', local, remote, progress: p }))
      setUpdateState({ phase: 'ready', local, remote, pending: meta, progress: 1 })
    } catch (e) {
      setUpdateState({ phase: 'available', local, remote, error: e.message || String(e), progress: resumeOffset(partial, remote) / (Number(partial.total) || 1) })
    }
    return getUpdateState()
  }
  if (kind === 'available') {
    setUpdateState({ phase: 'available', local, remote, progress: 0 })
    return getUpdateState()
  }
  setUpdateState({ phase: 'latest', local, remote, pending: null, progress: 0 })
  return getUpdateState()
}

export async function startUpdateDownload() {
  const { remote, local } = getUpdateState()
  if (!remote) throw new Error('no remote')
  setUpdateState({ phase: 'downloading', error: null })
  try {
    const meta = await downloadUpdate(remote, p => setUpdateState({ progress: p, phase: 'downloading', local, remote }))
    setUpdateState({ phase: 'ready', local, remote, pending: meta, progress: 1 })
    return meta
  } catch (e) {
    setUpdateState({ phase: 'available', error: e.message || String(e) })
    throw e
  }
}
