import { useEffect, useState } from 'react'
import { MUSCLES, INERT, MUSCLE_NAME, levelsOf } from '../lib/muscles.js'
import { t } from '../lib/i18n.js'

// Front and back views of a body, each muscle shaded by how hard it was worked.
//
// The five shade steps are the same ones the activity heatmap uses (.hm-c.l0…l4), so
// "more accent = more training" means one thing everywhere in the app rather than two.
//
// The geometry is ~90 KB and only some screens show a map, so it is fetched on first
// render instead of riding along in the main bundle. Until it lands the component
// renders nothing but keeps its height, so nothing below it jumps on arrival.

let CACHE = null                                  // shared across every mounted map
let PENDING = null

function useBodyPaths() {
  const [paths, setPaths] = useState(CACHE)
  useEffect(() => {
    if (CACHE) return
    let alive = true
    PENDING = PENDING || import('../lib/body-paths.js').then(m => (CACHE = m.default))
    PENDING.then(p => { if (alive) setPaths(p) }).catch(() => {})
    return () => { alive = false }
  }, [])
  return paths
}

function View({ view, levels, onMuscle, selected }) {
  return (
    <svg className="bm-v" viewBox={view.vb} role="img">
      {INERT.map(slug => (view.p[slug] || []).map((d, i) =>
        <path key={slug + i} className="bm-sil" d={d} />))}
      {MUSCLES.map(slug => (view.p[slug] || []).map((d, i) =>
        <path
          key={slug + i}
          className={'bm-m l' + (levels[slug] || 0) + (selected === slug ? ' sel' : '')}
          d={d}
          onClick={onMuscle ? () => onMuscle(slug) : undefined}
        >
          <title>{t(MUSCLE_NAME[slug])}</title>
        </path>))}
    </svg>
  )
}

/**
 * <BodyMap load={{ chest: 12, … }} body="male" />
 * `load` is effective sets per muscle (see lib/muscles.js); shading is relative to
 * the hardest-worked muscle in that same load, so it always reads as a balance.
 */
// `levels` overrides the shading when a caller has already worked out its own
// 0–4 per muscle — recovery does, because "how recovered" is not a rescaling of
// "how much work", it is a different question over the same anatomy.
// `tone` switches the colour ramp with it: accent means training, warm means
// still recovering. Two ramps rather than one, because a red chest and a gold
// chest have to be readable as different claims at a glance.
export default function BodyMap({ load = {}, levels: levelsIn, tone = 'load', body = 'male', onMuscle, selected, className = '' }) {
  const paths = useBodyPaths()
  const levels = levelsIn || levelsOf(load)
  const g = paths && (paths[body] || paths.male)
  return (
    <div className={'bodymap' + (tone === 'recovery' ? ' bm-rec' : '') + ' ' + className}>
      {g ? <>
        <View view={g.front} levels={levels} onMuscle={onMuscle} selected={selected} />
        <View view={g.back} levels={levels} onMuscle={onMuscle} selected={selected} />
      </> : <div className="bm-ph" aria-hidden="true" />}
    </div>
  )
}

export function BodyMapLegend() {
  return <div className="hm-legend">
    {t('Less')} <div className="hm-c l0" /><div className="hm-c l1" /><div className="hm-c l2" />
    <div className="hm-c l3" /><div className="hm-c l4" /> {t('More')}
  </div>
}
