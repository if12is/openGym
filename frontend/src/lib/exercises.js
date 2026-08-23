import { EXDB } from './exercises-data.js'
import { t } from './i18n.js'

export { EXDB }
export const EXIDX = {}
EXDB.forEach(e => { EXIDX[e.id] = e })
export const BODYPARTS = [...new Set(EXDB.map(e => e.bp))].sort()

// Equipment options present in a given list of exercises, most common first (issue #6).
// Deriving them from the *already filtered* list keeps the chip row short and means
// every body-part × equipment combination on screen has results behind it.
export function equipmentOf(list) {
  const c = {}
  list.forEach(e => { if (e.eq) c[e.eq] = (c[e.eq] || 0) + 1 })
  return Object.keys(c).sort((a, b) => c[b] - c[a] || (a < b ? -1 : 1))
}

// Custom (user-created) exercises live in synced state S.customEx (issue #11) and are
// merged into the id index here so every EXIDX[id] lookup keeps working unchanged.
let customIds = []
export function registerCustom(list) {
  customIds.forEach(id => delete EXIDX[id])
  customIds = (list || []).map(e => e.id)
  ;(list || []).forEach(e => { EXIDX[e.id] = e })
}
// Full searchable catalogue — customs first so your own exercises are easy to find.
export const allExercises = st => [...(st.customEx || []), ...EXDB]

// Media normally sits next to the app (img/ and gif/, mounted into the web container).
// Mobile / demo builds point at a CDN. jsDelivr is flaky in some regions, so every
// lookup has GitHub raw + jsDelivr fallbacks — Media.jsx walks the list on error.
const MEDIA_PIN = '7455efae41b330c265e7cd4b78dfa848e7ce5ebd'
const GH = `https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/${MEDIA_PIN}/`
const JD = `https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@${MEDIA_PIN}/`

function bases(env, local, remoteDirs) {
  const out = []
  const add = b => { if (b && !out.includes(b)) out.push(b.endsWith('/') ? b : b + '/') }
  add(env)
  add(local)
  remoteDirs.forEach(add)
  return out
}

const IMG_BASES = bases(import.meta.env.VITE_IMG_BASE, 'img/', [GH + 'images/', JD + 'images/'])
const GIF_BASES = bases(import.meta.env.VITE_GIF_BASE, 'gif/', [GH + 'videos/', JD + 'videos/'])

export const imgCandidates = ex => (ex && ex.img) ? IMG_BASES.map(b => b + ex.img) : []
export const gifCandidates = ex => (ex && ex.gif) ? GIF_BASES.map(b => b + ex.gif) : []
export const imgSrc = ex => imgCandidates(ex)[0] || ''
export const gifSrc = ex => gifCandidates(ex)[0] || ''

// Cardio exercises log time + speed instead of weight × reps.
export const isCardio = idOrEx => (typeof idOrEx === 'string' ? EXIDX[idOrEx] : idOrEx)?.bp === 'cardio'

// Exercises the dataset already knows carry no external load (issue #32) — a quarter of the
// catalogue. This seeds the `bw` flag on a fresh config so a push-up never asks for a weight
// nobody was going to enter. It is only the default: the flag lives on the config, so a dip
// done with a belt can turn it off and a custom exercise can turn it on.
export const isBodyweightEq = idOrEx =>
  (typeof idOrEx === 'string' ? EXIDX[idOrEx] : idOrEx)?.eq === 'body weight'

// An id that resolves to nothing — a plan file built against a different exercise dataset,
// a custom exercise deleted on another device before the sync arrived — still has to
// render. A placeholder keeps it visible (and removable) instead of taking the whole view
// down on the first `ex.n`.
export const exOr = id => EXIDX[id] ||
  { id, n: t('Unknown exercise'), bp: '', tg: '', eq: '', sm: [], st: [], missing: true }
