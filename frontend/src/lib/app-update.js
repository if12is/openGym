// In-app update checker for the Capacitor Android build.
// Compares the installed versionCode with app-version.json on GitHub,
// downloads the APK, then opens the system installer.

import { MOBILE } from './mobile.js'
import { t } from './i18n.js'

const MANIFEST_URL = import.meta.env.VITE_UPDATE_MANIFEST ||
  'https://github.com/if12is/openGym/releases/download/android-latest/app-version.json'

const APK_PATH = 'updates/gemak-latest.apk'
const APK_META = 'updates/gemak-latest.json'

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

export async function fetchRemoteManifest() {
  const res = await fetch(MANIFEST_URL, { cache: 'no-store' })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}

export function isNewer(remote, local) {
  return Number(remote?.versionCode) > Number(local?.versionCode)
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
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
    const r = await Filesystem.readFile({ path: APK_META, directory: Directory.Cache, encoding: Encoding.UTF8 })
    const meta = JSON.parse(r.data)
    await Filesystem.stat({ path: APK_PATH, directory: Directory.Cache })
    return meta
  } catch { return null }
}

async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const rd = new FileReader()
    rd.onload = () => resolve(rd.result.split(',')[1])
    rd.onerror = reject
    rd.readAsDataURL(blob)
  })
}

export async function downloadUpdate(remote, onProgress) {
  if (!MOBILE) throw new Error('mobile only')
  const url = remote.apkUrl
  if (!url) throw new Error('no apkUrl')
  const { Filesystem, Directory } = await import('@capacitor/filesystem')
  await Filesystem.mkdir({ path: 'updates', directory: Directory.Cache, recursive: true }).catch(() => {})
  const res = await fetch(url)
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const total = Number(res.headers.get('content-length')) || 0
  const reader = res.body?.getReader()
  if (!reader) {
    const b64 = await blobToBase64(await res.blob())
    await Filesystem.writeFile({ path: APK_PATH, directory: Directory.Cache, data: b64 })
    onProgress?.(1)
  } else {
    const chunks = []
    let loaded = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      loaded += value.length
      if (total) onProgress?.(loaded / total)
      else onProgress?.(0)
    }
    const merged = new Uint8Array(loaded)
    let off = 0
    for (const c of chunks) { merged.set(c, off); off += c.length }
    let binary = ''
    const step = 0x8000
    for (let i = 0; i < merged.length; i += step) {
      binary += String.fromCharCode.apply(null, merged.subarray(i, i + step))
    }
    await Filesystem.writeFile({ path: APK_PATH, directory: Directory.Cache, data: btoa(binary) })
    onProgress?.(1)
  }
  const meta = { versionName: remote.versionName, versionCode: remote.versionCode, downloadedAt: Date.now() }
  await Filesystem.writeFile({
    path: APK_META, directory: Directory.Cache,
    data: JSON.stringify(meta), encoding: (await import('@capacitor/filesystem')).Encoding.UTF8,
  })
  return meta
}

export async function installPendingUpdate() {
  if (!MOBILE) throw new Error('mobile only')
  const { Filesystem, Directory } = await import('@capacitor/filesystem')
  const stat = await Filesystem.stat({ path: APK_PATH, directory: Directory.Cache })
  const p = await appUpdatePlugin()
  if (!p?.installApk) throw new Error(t('Install not available'))
  await p.installApk({ uri: stat.uri })
}
