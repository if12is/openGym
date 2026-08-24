// Download exercise images + GIFs to the app data directory for offline use.
// Instructions and exercise names are already bundled in the app binary.

import { EXDB } from './exercises-data.js'
import { t } from './i18n.js'
import { MOBILE } from './mobile.js'

const MEDIA_PIN = '7455efae41b330c265e7cd4b78dfa848e7ce5ebd'
const REMOTE_IMG = `https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/${MEDIA_PIN}/images/`
const REMOTE_GIF = `https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/${MEDIA_PIN}/videos/`
const ROOT = 'offline-media'
const MANIFEST = `${ROOT}/manifest.json`
const CONCURRENCY = 3

const urlCache = { img: {}, gif: {} }
let ready = false

export function offlineMediaReady() { return ready }

export function offlineImgUrl(name) { return urlCache.img[name] || '' }
export function offlineGifUrl(name) { return urlCache.gif[name] || '' }

async function fs() {
  const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
  const { Capacitor } = await import('@capacitor/core')
  return { Filesystem, Directory, Encoding, Capacitor }
}

async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const rd = new FileReader()
    rd.onload = () => resolve(rd.result.split(',')[1])
    rd.onerror = reject
    rd.readAsDataURL(blob)
  })
}

async function downloadOne(url, relPath) {
  const { Filesystem, Directory } = await fs()
  const res = await fetch(url)
  if (!res.ok) throw new Error(url + ' → HTTP ' + res.status)
  const b64 = await blobToBase64(await res.blob())
  await Filesystem.writeFile({ path: relPath, directory: Directory.Data, data: b64 })
}

async function mapPool(items, worker, limit) {
  let i = 0
  const runners = Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++
      await worker(items[idx], idx)
    }
  })
  await Promise.all(runners)
}

export async function initOfflineMediaFromDisk() {
  if (!MOBILE) { ready = false; return null }
  try {
    const { Filesystem, Directory, Encoding, Capacitor } = await fs()
    const raw = await Filesystem.readFile({ path: MANIFEST, directory: Directory.Data, encoding: Encoding.UTF8 })
    const manifest = JSON.parse(raw.data)
    if (!manifest?.ready) { ready = false; return null }
    urlCache.img = {}
    urlCache.gif = {}
    for (const rel of manifest.files || []) {
      const stat = await Filesystem.stat({ path: rel, directory: Directory.Data })
      const url = Capacitor.convertFileSrc(stat.uri)
      if (rel.includes('/img/')) urlCache.img[rel.split('/').pop()] = url
      else if (rel.includes('/gif/')) urlCache.gif[rel.split('/').pop()] = url
    }
    ready = Object.keys(urlCache.img).length > 0
    return manifest
  } catch {
    ready = false
    return null
  }
}

export function offlineMediaJobCount() {
  const files = []
  for (const ex of EXDB) {
    if (ex.img) files.push({ kind: 'img', name: ex.img })
    if (ex.gif) files.push({ kind: 'gif', name: ex.gif })
  }
  return files.length
}

export async function downloadOfflineMedia(onProgress) {
  if (!MOBILE) throw new Error('mobile only')
  const { Filesystem, Directory, Encoding } = await fs()
  await Filesystem.mkdir({ path: `${ROOT}/img`, directory: Directory.Data, recursive: true }).catch(() => {})
  await Filesystem.mkdir({ path: `${ROOT}/gif`, directory: Directory.Data, recursive: true }).catch(() => {})

  const jobs = []
  for (const ex of EXDB) {
    if (ex.img) jobs.push({ kind: 'img', name: ex.img, url: REMOTE_IMG + ex.img, path: `${ROOT}/img/${ex.img}` })
    if (ex.gif) jobs.push({ kind: 'gif', name: ex.gif, url: REMOTE_GIF + ex.gif, path: `${ROOT}/gif/${ex.gif}` })
  }
  const total = jobs.length
  let done = 0
  const files = []

  await mapPool(jobs, async job => {
    await downloadOne(job.url, job.path)
    files.push(job.path)
    done++
    onProgress?.({ done, total, file: job.name })
  }, CONCURRENCY)

  const manifest = { ready: true, downloadedAt: Date.now(), files, count: files.length }
  await Filesystem.writeFile({
    path: MANIFEST, directory: Directory.Data,
    data: JSON.stringify(manifest), encoding: Encoding.UTF8,
  })
  await initOfflineMediaFromDisk()
  return manifest
}

export async function clearOfflineMedia() {
  if (!MOBILE) return
  const { Filesystem, Directory } = await fs()
  try { await Filesystem.rmdir({ path: ROOT, directory: Directory.Data, recursive: true }) } catch { /* */ }
  urlCache.img = {}
  urlCache.gif = {}
  ready = false
}

export function offlineMediaLabel(st) {
  if (!st?.offlineMedia?.ready) return t('Not downloaded')
  const n = st.offlineMedia.fileCount || 0
  return t('{0} files saved offline', n)
}
