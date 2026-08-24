// Heart rate across one session.
//
// A separate component from LineChart on purpose. LineChart's x axis is built
// from calendar months and its tooltip prints a date — correct for body weight
// over a year, useless for seventy minutes, where every tick would read "25 Aug"
// and the label would never change. This one thinks in clock time, and it draws
// the zone bands behind the trace, which is the part that turns a squiggle into
// something you can read: where the line sits matters more than its shape.

import { useLayoutEffect, useRef, useState } from 'react'
import { zoneOf, ZONE_EDGES, ZONE_COUNT } from '../lib/health-match.js'
import { t } from '../lib/i18n.js'

const W = 340

// Bands from calm to maximal. Deliberately low-contrast: they are a backdrop the
// trace is read against, not five things competing with it.
export const ZONE_COLORS = ['var(--grey)', 'var(--blue)', 'var(--teal)', 'var(--orange)', 'var(--red)']
export const ZONE_NAMES = ['Recovery', 'Warm-up', 'Fat burn', 'Cardio', 'Peak']

const clock = ms => {
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

// samples: [{ t: ms, bpm }] sorted ascending
export default function SessionChart({ samples, hrMax, rhr, h = 168, showZones = true }) {
  const svgRef = useRef(null)
  const wrapRef = useRef(null)
  const tipRef = useRef(null)
  const [hover, setHover] = useState(null)

  useLayoutEffect(() => {
    const tip = tipRef.current, wrap = wrapRef.current
    if (!hover || !tip || !wrap) return
    const cw = wrap.clientWidth, ch = wrap.clientHeight
    const tw = tip.offsetWidth, th = tip.offsetHeight
    const M = 4
    const cx = hover.x / W * cw, cy = hover.y / h * ch
    tip.style.left = Math.max(M, Math.min(cw - tw - M, cx - tw / 2)) + 'px'
    tip.style.top = (cy < th + 14 ? Math.min(ch - th - M, cy + 14) : M) + 'px'
  })

  if (!samples || samples.length < 2) return <div className="empty small">{t('No heart-rate data for this session')}</div>

  const H = h
  const P = { l: 32, r: 10, t: 10, b: 20 }
  const bpms = samples.map(s => s.bpm)
  // The scale is padded to whole tens so the gridline labels are round numbers —
  // a y axis reading 63 / 97 / 131 is technically correct and unreadable.
  let ymin = Math.floor((Math.min(...bpms) - 8) / 10) * 10
  let ymax = Math.ceil((Math.max(...bpms) + 8) / 10) * 10
  if (ymax - ymin < 30) ymax = ymin + 30

  const t0 = samples[0].t
  const t1 = samples[samples.length - 1].t
  const span = Math.max(1, t1 - t0)
  const X = ms => P.l + (ms - t0) / span * (W - P.l - P.r)
  const Y = v => P.t + (1 - (v - ymin) / (ymax - ymin)) * (H - P.t - P.b)

  // Zone bands, drawn only where the reserve maths is meaningful. Without a
  // measured max the edges would be guesses, and a guessed band is worse than
  // none — it invites the user to train to a number we made up.
  const bands = []
  if (showZones && hrMax > rhr) {
    const bpmAt = f => rhr + f * (hrMax - rhr)
    const edges = [ymin, ...ZONE_EDGES.map(bpmAt), ymax]
    for (let i = 0; i < ZONE_COUNT; i++) {
      const lo = Math.max(ymin, edges[i]), hi = Math.min(ymax, edges[i + 1])
      if (hi <= lo) continue
      bands.push(
        <rect key={'z' + i} x={P.l} y={Y(hi)} width={W - P.l - P.r} height={Math.max(0, Y(lo) - Y(hi))}
          fill={ZONE_COLORS[i]} opacity=".10" />
      )
    }
  }

  const grid = []
  const step = ymax - ymin > 80 ? 40 : 20
  for (let v = ymin; v <= ymax; v += step) {
    grid.push(<g key={'g' + v}>
      <line x1={P.l} y1={Y(v)} x2={W - P.r} y2={Y(v)} stroke="var(--sep-op)" strokeWidth="1" strokeDasharray="2 4" />
      <text x={P.l - 5} y={Y(v) + 3.5} textAnchor="end" fontSize="9.5" fill="var(--label-3)">{v}</text>
    </g>)
  }

  // Time ticks on the clock, not on the sample index: a five-minute grid that
  // starts at 19:00 rather than at 19:03 is what makes the axis scannable.
  const ticks = []
  const stepMin = span > 90 * 60000 ? 30 : span > 40 * 60000 ? 15 : 10
  const first = new Date(t0)
  first.setSeconds(0, 0)
  first.setMinutes(Math.ceil(first.getMinutes() / stepMin) * stepMin)
  for (let ms = +first; ms <= t1; ms += stepMin * 60000) {
    ticks.push(<g key={'t' + ms}>
      <line x1={X(ms)} y1={P.t} x2={X(ms)} y2={H - P.b} stroke="var(--sep-op)" strokeWidth="1" strokeDasharray="2 4" />
      <text x={X(ms)} y={H - 6} textAnchor="middle" fontSize="9.5" fill="var(--label-3)">{clock(ms)}</text>
    </g>)
  }

  const poly = samples.map(s => X(s.t).toFixed(1) + ',' + Y(s.bpm).toFixed(1)).join(' ')
  const gid = 'hr' + Math.round(t0 % 1e7)
  const pts = samples.map(s => ({ x: X(s.t), y: Y(s.bpm), t: s.t, bpm: s.bpm }))

  const onMove = e => {
    const c = e.touches ? e.touches[0] : e
    if (!c || c.clientX === undefined) return
    const r = svgRef.current.getBoundingClientRect()
    const vx = (c.clientX - r.left) / (r.width || W) * W
    let best = pts[0]
    pts.forEach(p => { if (Math.abs(p.x - vx) < Math.abs(best.x - vx)) best = p })
    setHover(best)
  }

  const hoverZone = hover && hrMax > rhr ? zoneOf(hover.bpm, hrMax, rhr) : null

  return (
    <div className="chart-i" ref={wrapRef}
      onMouseMove={onMove} onMouseDown={onMove}
      onMouseLeave={() => setHover(null)}
      onTouchStart={onMove} onTouchMove={onMove}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ aspectRatio: `${W}/${H}` }}>
        <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--red)" stopOpacity=".26" />
          <stop offset="1" stopColor="var(--red)" stopOpacity="0" />
        </linearGradient></defs>
        {bands}
        {grid}
        {ticks}
        <polygon points={`${P.l},${H - P.b} ${poly} ${X(t1).toFixed(1)},${H - P.b}`} fill={`url(#${gid})`} />
        <polyline points={poly} fill="none" stroke="var(--red)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {hover && <g>
          <line x1={hover.x} y1={P.t} x2={hover.x} y2={H - P.b} stroke="var(--label-3)" strokeWidth="1" strokeDasharray="3 3" />
          <circle cx={hover.x} cy={hover.y} r="4.5" fill="var(--red)" stroke="var(--bg)" strokeWidth="2" />
        </g>}
      </svg>
      {hover && <div className="ctip" ref={tipRef}>
        {clock(hover.t)} · {hover.bpm} {t('bpm')}{hoverZone != null ? ' · ' + t(ZONE_NAMES[hoverZone]) : ''}
      </div>}
    </div>
  )
}

// The bar under the chart: where the time actually went. Reads at a glance in a
// way the curve cannot — two sessions with the same average can have completely
// different shapes here.
export function ZoneBar({ zones }) {
  if (!zones) return null
  const total = zones.reduce((a, b) => a + b, 0)
  if (total <= 0) return null
  return <div className="zbar">
    {zones.map((min, i) => (min <= 0 ? null : (
      <span key={i} style={{ width: (min / total * 100) + '%', background: ZONE_COLORS[i] }}
        title={t(ZONE_NAMES[i]) + ' · ' + Math.round(min) + ' ' + t('min')} />
    )))}
  </div>
}
