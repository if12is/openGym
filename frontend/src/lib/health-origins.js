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

export function originLabel(pkg) {
  return LABELS[pkg] || pkg
}

export function isPhoneOrigin(pkg) {
  return PHONE_PKGS.includes(pkg)
}

export function pickWatchOrigin(pkgs) {
  const list = (pkgs || []).map(p => (typeof p === 'string' ? p : p?.pkg)).filter(Boolean)
  for (const p of WATCH_WRITERS) {
    if (list.includes(p)) return p
  }
  const watch = list.find(p => !isPhoneOrigin(p))
  return watch || list[0] || null
}
