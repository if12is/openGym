// Who writes into Health Connect on this phone, and which writer the pull
// should trust when more than one is present.
//
// Health Connect's aggregate() deduplicates overlapping sources. Honor's
// binder never returns from that call, so we sum records instead — and then
// we MUST pick one writer, or Health Sync + Honor Health + the phone's own
// counter all get added together for the same walk.
//
// Preference, from Health Sync's own contract and Health Connect's origin
// filter:
//   1. Health Sync (`nl.appyhapps.healthsync`) — that is the app the setup
//      screen tells people to point at Health Connect, and it is the copy of
//      the watch.
//   2. Honor Health / Huawei Health, if Health Sync has not written yet.
//   3. Anything that is not the phone.
//   4. The phone, only if nothing else is there.

export const HEALTH_SYNC_PKG = 'nl.appyhapps.healthsync'
export const HONOR_HEALTH_PKG = 'com.hihonor.health'
export const HUAWEI_HEALTH_PKG = 'com.huawei.health'
export const PHONE_PKGS = ['com.android.healthconnect.phone', 'android']

const WATCH_WRITERS = [HEALTH_SYNC_PKG, HONOR_HEALTH_PKG, HUAWEI_HEALTH_PKG]

const LABELS = {
  [HEALTH_SYNC_PKG]: 'Health Sync',
  [HONOR_HEALTH_PKG]: 'Honor Health',
  [HUAWEI_HEALTH_PKG]: 'Huawei Health',
  'com.android.healthconnect.phone': 'Phone',
  android: 'Phone',
}

// Android package names have a dot. Health Connect on some Honor builds
// hands back a hex id instead, which is what "Read from" showed as
// `8eac7881e…` — not a source anyone can pick.
export function looksLikePackage(pkg) {
  if (typeof pkg !== 'string' || !pkg.includes('.')) return false
  if (pkg.length > 180) return false
  return /^[a-zA-Z][\w-]*(\.[a-zA-Z][\w-]*)+$/.test(pkg)
}

export function pkgOf(entry) {
  if (typeof entry === 'string') return entry
  return entry?.pkg || ''
}

export function cleanOrigins(pkgs) {
  return (pkgs || []).map(pkgOf).filter(looksLikePackage)
}

export function looksLikeHonorBridge(pkgs) {
  return (pkgs || []).map(pkgOf).some(p => {
    const s = String(p).toLowerCase()
    return s.includes('healthsync') || s.includes('hihonor') || s.includes('huawei.health')
  })
}

export function originLabel(pkg) {
  if (!pkg) return ''
  if (LABELS[pkg]) return LABELS[pkg]
  if (!looksLikePackage(pkg)) return 'Watch'
  return pkg
}

export function isPhoneOrigin(pkg) {
  return PHONE_PKGS.includes(pkg)
}

export function pickWatchOrigin(pkgs) {
  const list = cleanOrigins(pkgs)
  for (const p of WATCH_WRITERS) {
    if (list.includes(p)) return p
  }
  const watch = list.find(p => !isPhoneOrigin(p))
  return watch || list[0] || null
}
