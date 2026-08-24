// The health surfaces, in one place so the home card and the session sheet stay
// visually the same family.
//
// A running theme here: every reading says what it is relative to. "62 bpm" is
// noise; "6 above your week" is information. And every derived score carries how
// much of the picture it was actually built from — the same honesty the effort
// card already applies to partly-rated sets.

import { useEffect, useState } from 'react'
import { t } from '../lib/i18n.js'
import { todayISO } from '../lib/format.js'
import { MOBILE } from '../lib/mobile.js'
import { effectiveRoutineId } from '../lib/history.js'
import { useUI } from '../store/useUI.js'
import Icon from './Icon.jsx'
import SessionChart, { ZoneBar, ZONE_COLORS, ZONE_NAMES } from './SessionChart.jsx'
import { getHealth, subscribeHealth, getConn } from '../lib/health-store.js'
import { readiness, overloadFlag, trainingLoad, sleepVsVolume, suggestRest, prContext } from '../lib/health-insights.js'
import { useStore } from '../store/useStore.js'
import LineChart from './LineChart.jsx'
import { Segmented } from './ui.jsx'
import { sessionSamples, hrReserve, ZONE_EDGES } from '../lib/health-match.js'

/* ============================ small formatters ============================ */

export const hhmm = min => {
  if (min == null) return '—'
  const h = Math.floor(min / 60), m = Math.round(min % 60)
  return h ? `${h}${t('h')} ${String(m).padStart(2, '0')}` : `${m}${t('m')}`
}

// Re-render whichever surface is mounted when a sync lands. The store is outside
// React on purpose (it is written from timers and resume handlers), so views
// subscribe rather than select.
export function useHealth() {
  const [, bump] = useState(0)
  useEffect(() => subscribeHealth(() => bump(n => n + 1)), [])
  return getHealth()
}

/* ============================ readiness ============================ */

const BAND = {
  go: { color: 'var(--green)', title: 'Good to push today', icon: 'bolt' },
  normal: { color: 'var(--acc)', title: 'A normal training day', icon: 'check' },
  easy: { color: 'var(--orange)', title: 'Take it lighter today', icon: 'arrowDown' },
  rest: { color: 'var(--red)', title: 'Rest is the smart call', icon: 'moon' },
}

function Ring({ score, color }) {
  const r = 31, c = 2 * Math.PI * r
  return <div className="rdy-ring">
    <svg viewBox="0 0 74 74">
      <circle cx="37" cy="37" r={r} fill="none" stroke="var(--surface-2)" strokeWidth="7" />
      <circle cx="37" cy="37" r={r} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round"
        strokeDasharray={`${(c * score / 100).toFixed(1)} ${c.toFixed(1)}`} />
    </svg>
    <span className="v" style={{ color }}>{score}</span>
  </div>
}

// `read` is the output of health-insights.readiness. Rendering is deliberately
// split from the maths so the thresholds live somewhere a test can reach them.
export function ReadinessCard({ read, day, base, overload, isRestDay, onWhy }) {
  if (!read) return null
  const band = BAND[read.band] || BAND.normal

  // Below half the inputs, the score is one reading wearing a suit. Say so
  // instead of quietly presenting it as the same number.
  const thin = read.confidence < 0.5

  return <div className="card">
    <div className="rdy">
      <Ring score={read.score} color={band.color} />
      <div className="rdy-m">
        <span className="dim small" style={{ letterSpacing: '.04em', textTransform: 'uppercase' }}>{t('Readiness')}</span>
        <span className="rdy-t">{t(band.title)}</span>
        <span className="rdy-s">
          {isRestDay && (read.band === 'easy' || read.band === 'rest')
            ? t('Rest day on the plan — and your body agrees.')
            : thin ? t('Based on part of the picture so far.')
              : t('From your sleep, resting pulse and this week’s load.')}
        </span>
      </div>
    </div>

    <div className="rdy-parts">
      {day?.sleepMin != null && (
        <span className="rdy-part"><Icon name="sleep" />{t('Slept')} <b>{hhmm(day.sleepMin)}</b>
          {base?.sleep14 ? <span>{' · '}{t('avg {0}', hhmm(base.sleep14))}</span> : null}
        </span>
      )}
      {day?.rhr != null && (
        <span className="rdy-part"><Icon name="heart" />{t('Resting')} <b>{day.rhr}</b>
          {base?.rhr7 ? <span>{' · '}{day.rhr > base.rhr7 ? '+' : ''}{day.rhr - base.rhr7}</span> : null}
        </span>
      )}
      {day?.steps != null && (
        <span className="rdy-part"><Icon name="footsteps" /><b>{Math.round(day.steps).toLocaleString()}</b> {t('steps')}</span>
      )}
    </div>

    {overload && <div className="wnote" style={{ marginTop: 12 }}>
      <Icon name="info" />
      <div>
        <div><b>{t('Two fatigue signals today.')}</b> {t('Training is still fine — just pull the top sets back a notch.')}</div>
        {onWhy && <button className="btn sm plain" style={{ paddingInline: 0 }} onClick={onWhy}>{t('What counted?')}</button>}
      </div>
    </div>}

    <p className="dim small" style={{ marginTop: 10, lineHeight: 1.45 }}>
      {t('Estimates from a consumer watch — a training suggestion, not medical advice.')}
    </p>
  </div>
}

/* ============================ zones ============================ */

export function ZoneLegend({ zones }) {
  if (!zones) return null
  return <div className="zleg">
    {zones.map((min, i) => (min <= 0 ? null : (
      <span key={i}><i style={{ background: ZONE_COLORS[i] }} />{t(ZONE_NAMES[i])} {Math.round(min)}{t('m')}</span>
    )))}
  </div>
}

/* ============================ calories ============================ */

const KCAL_COLORS = ['var(--acc)', 'var(--teal)', 'var(--grey)']

// The answer to "how much of today was the gym". Three buckets rather than one
// total, because the total is the number that tells you nothing.
export function CalorieSplit({ kcal }) {
  if (!kcal || !kcal.total) return null
  const parts = [
    { key: 'Gym', v: kcal.gym },
    { key: 'Cardio', v: kcal.cardio },
    { key: 'Rest of day', v: kcal.other },
  ]
  const sum = parts.reduce((n, p) => n + p.v, 0) || 1
  return <div>
    <div className="kbar">
      {parts.map((p, i) => (p.v <= 0 ? null :
        <span key={p.key} style={{ width: (p.v / sum * 100) + '%', background: KCAL_COLORS[i] }} />))}
    </div>
    <div className="zleg">
      {parts.map((p, i) => (p.v <= 0 ? null :
        <span key={p.key}><i style={{ background: KCAL_COLORS[i] }} />{t(p.key)} <b style={{ color: 'var(--label)' }}>{p.v}</b></span>))}
    </div>
  </div>
}

/* ============================ session block ============================ */

// Rendered inside the workout detail sheet, under the sets.
export function SessionStats({ session, base }) {
  if (!session) return null
  const restingDelta = session.sleepBefore && base?.sleep14
    ? Math.round(session.sleepBefore.min - base.sleep14) : null

  return <div className="hstats">
    {session.hrAvg != null && <div className="hstat">
      <div className="l"><Icon name="heart" />{t('Avg')}</div>
      <div className="v">{session.hrAvg}<small>{t('bpm')}</small></div>
    </div>}
    {session.hrMax != null && <div className="hstat">
      <div className="l"><Icon name="bolt" />{t('Peak')}</div>
      <div className="v">{session.hrMax}<small>{t('bpm')}</small></div>
    </div>}
    {session.trimp != null && <div className="hstat">
      <div className="l"><Icon name="flame" />{t('Load')}</div>
      <div className="v">{session.trimp}</div>
    </div>}
    {session.kcal?.gym != null && <div className="hstat">
      <div className="l"><Icon name="flame" />{t('Gym kcal')}</div>
      <div className="v">{session.kcal.gym}</div>
    </div>}
    {session.sleepBefore && <div className="hstat">
      <div className="l"><Icon name="sleep" />{t('Slept')}</div>
      <div className="v">{hhmm(session.sleepBefore.min)}
        {restingDelta != null && <small>{restingDelta >= 0 ? '+' : ''}{Math.round(restingDelta / 60 * 10) / 10}{t('h')}</small>}
      </div>
    </div>}
  </div>
}

/* ============================ live pulse ============================ */

// Shown on the running-workout screen. Not a live stream — reading health data
// in the background needs a permission the app deliberately does not ask for, so
// this refreshes while the app is in front and says how old the number is when
// it starts to age.
// Polls while a workout is running and the app is in front. One minute, because
// the watch writes on its own schedule and Health Sync batches on top of that —
// asking more often costs battery and returns the same number.
export function useLivePulse(active, everyMs = 60000) {
  const [pulse, setPulse] = useState(null)
  useEffect(() => {
    if (!MOBILE || !active || !isLinked()) return
    let alive = true
    const tick = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const m = await import('../lib/health-sync.js')
        const p = await m.readLivePulse()
        if (alive && p) setPulse(p)
      } catch (e) { /* nothing linked */ }
    }
    tick()
    const tm = setInterval(tick, everyMs)
    const onShow = () => { if (document.visibilityState === 'visible') tick() }
    document.addEventListener('visibilitychange', onShow)
    return () => { alive = false; clearInterval(tm); document.removeEventListener('visibilitychange', onShow) }
  }, [active, everyMs])
  return pulse
}

/**
 * The line under the rest bar that says whether you are actually ready.
 *
 * A rest timer counts a number somebody typed into settings once. What decides
 * whether the next set goes well is whether the pulse came back down, and the
 * watch is the only thing that knows.
 *
 * Deliberately silent when the reading is stale. Health Sync usually batches
 * every 15-60 minutes, so mid-workout data is often minutes old — and telling
 * someone they are recovered based on a reading from before the set would be
 * worse than saying nothing. Ninety seconds is the cutoff.
 */
export function RestPulseHint() {
  const pulse = useLivePulse(true, 20000)
  const health = useHealth()
  if (!pulse) return null

  const age = Date.now() - pulse.at
  if (age > 90000) return null

  const hrMax = health.base?.hrMaxObserved
  const rhr = health.base?.rhr28 || health.base?.rhr7
  if (!hrMax || !rhr || hrMax <= rhr) return null

  const ready = hrReserve(pulse.bpm, hrMax, rhr) < ZONE_EDGES[0]
  return <div className="restpulse" style={{ color: ready ? 'var(--green)' : 'var(--label-2)' }}>
    <Icon name="heart" />
    <b>{pulse.bpm}</b>
    <span>{ready ? t('recovered — go') : t('still coming down')}</span>
  </div>
}

export function LivePulse({ bpm, at }) {
  if (bpm == null) return null
  const ageMin = at ? Math.round((Date.now() - at) / 60000) : null
  return <span className="bpmchip">
    <Icon name="heart" />
    <b>{bpm}</b>{t('bpm')}
    {ageMin != null && ageMin > 3 && <span className="dim" style={{ fontWeight: 400 }}>{t('{0}m ago', ageMin)}</span>}
  </span>
}

export const isLinked = () => getConn().state === 'ok'

/* ============================ home briefing ============================ */

// The one card that answers "what should I do today" before the plan does.
// Renders nothing at all unless a watch is linked AND today has a reading —
// an empty health card on the home screen is worse than no card.
export function DayBriefing({ S }) {
  const health = useHealth()
  if (!MOBILE || !isLinked()) return null

  const iso = todayISO()
  const day = health.days[iso]
  if (!day || (day.sleepMin == null && day.rhr == null)) return null

  const load = trainingLoad(health.sessions, S.workouts || [], iso)
  const read = readiness(day, health.base, load)
  if (!read) return null

  const recent = (S.workouts || []).slice(-2).map(w => health.sessions[w.id]).filter(Boolean)
  const over = overloadFlag(day, health.base, load, recent)
  const isRestDay = !effectiveRoutineId(S, iso)

  const why = () => useUI.getState().openSheet(close => <>
    <h3>{t('What counted?')}</h3>
    <p className="muted small" style={{ marginBottom: 12, lineHeight: 1.5 }}>
      {t('Each part is scored against your own recent average, not against a general target.')}
    </p>
    <div className="sect-b">
      {read.parts.map(p => (
        <div className="lrow" key={p.key}>
          <span className="lrow-m">
            <span className="lrow-t">{t(PART_NAME[p.key])}</span>
            <span className="lrow-s">{PART_DETAIL(p)}</span>
          </span>
          <span className="lrow-v">{p.score}</span>
        </div>
      ))}
    </div>
    {read.confidence < 1 && <p className="dim small" style={{ marginTop: 10, lineHeight: 1.45 }}>
      {t('Some inputs are missing today, so the score leans on the rest.')}
    </p>}
    <div style={{ height: 8 }} />
  </>)

  return <ReadinessCard read={read} day={day} base={health.base} overload={over}
    isRestDay={isRestDay} onWhy={why} />
}

/* ============================ one session, in detail ============================ */

const CARDIO_NAME = {
  running: 'Running', walking: 'Walking', cycling: 'Cycling',
  swimming: 'Swimming', strength: 'Strength', hiking: 'Hiking', workout: 'Workout',
}

// The health half of the workout detail sheet.
//
// Three states, and the middle one matters: Health Sync writes into Health
// Connect minutes after the watch hands over, so a session opened right after
// Finish legitimately has nothing yet. That is "waiting", not "the watch was
// off", and it retries rather than showing an empty chart.
export function SessionBlock({ w }) {
  const health = useHealth()
  const [busy, setBusy] = useState(false)
  const session = health.sessions[w.id]

  // Opening an older workout for the first time is also when its window gets
  // read — nothing is fetched for history the user never looks at.
  useEffect(() => {
    if (!MOBILE || !isLinked()) return
    if (session && session.state === 'ok') return
    let alive = true
    setBusy(true)
    import('../lib/health-sync.js')
      .then(m => m.ensureSession(w))
      .finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [w.id])

  if (!MOBILE || !isLinked()) return null

  if (!session || session.state === 'pending') {
    return <div className="wnote" style={{ marginTop: 4 }}>
      <Icon name="watch" />
      <div>{busy ? t('Checking your watch…') : t('Waiting on your watch — this fills in once Health Sync catches up.')}</div>
    </div>
  }

  const samples = sessionSamples(session)
  const hrMax = health.base?.hrMaxObserved || session.hrMax || 0
  const rhr = health.base?.rhr28 || health.base?.rhr7 || 0

  return <>
    <h4 className="sec" style={{ marginTop: 18 }}>{t('From your watch')}</h4>

    {session.clamped && <div className="wnote" style={{ marginTop: 0, marginBottom: 10 }}>
      <Icon name="info" />
      <div>{t('This session ran past four hours, so the window was trimmed. Readings below cover the first four hours only.')}</div>
    </div>}

    {samples.length > 1 && <div className="chart" style={{ marginTop: 4 }}>
      <SessionChart samples={samples} hrMax={hrMax} rhr={rhr} />
    </div>}

    {session.zones && <>
      <ZoneBar zones={session.zones} />
      <ZoneLegend zones={session.zones} />
    </>}

    <SessionStats session={session} base={health.base} />

    {session.kcal?.total > 0 && <>
      <h4 className="sec" style={{ marginTop: 16 }}>{t('Where the day’s energy went')}</h4>
      <CalorieSplit kcal={session.kcal} />
      <p className="dim small" style={{ marginTop: 8, lineHeight: 1.45 }}>
        {t('Watches estimate calories from heart rate, which reads low for lifting. Use “Load” above to compare sessions.')}
      </p>
    </>}

    {session.cardioOutside?.length > 0 && <>
      <h4 className="sec" style={{ marginTop: 16 }}>{t('Outside the gym today')}</h4>
      {session.cardioOutside.map((c, i) => (
        <div className="mrow" key={i}>
          <span className="nm">{t(CARDIO_NAME[c.type] || 'Workout')}</span>
          <span className="v">{c.min} {t('min')}{c.kcal ? ' · ' + c.kcal + ' ' + t('kcal') : ''}</span>
        </div>
      ))}
    </>}
  </>
}

/* ============================ right after you finish ============================ */

/**
 * The two things the watch can say the moment a workout ends.
 *
 * Neither waits on this session's own data — that is still minutes away through
 * Health Sync. Both read what is already known: last night, and the pulse traces
 * of previous sessions. That is what makes them showable here at all.
 */
export function FinishInsights({ w, prs = [] }) {
  const health = useHealth()
  const S = useStore(s => s.S)
  const [applied, setApplied] = useState(false)
  const [rest, setRest] = useState(null)

  useEffect(() => {
    if (!MOBILE || !isLinked()) return
    let alive = true
    import('../lib/health-sync.js').then(m => {
      const recs = m.recentRecoveries(S.workouts || [])
      if (alive) setRest(suggestRest(S.restSec || 90, recs))
    }).catch(() => { /* nothing linked */ })
    return () => { alive = false }
  }, [w.id])

  if (!MOBILE || !isLinked()) return null

  const day = health.days[w.d]
  const pr = prs.length ? prContext(day, health.base) : null
  if (!pr && !rest) return null

  return <div style={{ textAlign: 'start', marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
    {/* A lift that went up on a short night is worth more than the same lift on
        a full one, and the app is the only thing that knows both numbers. */}
    {pr && <div className="small accent row" style={{ gap: 6, alignItems: 'flex-start' }}>
      <Icon name="sleep" style={{ fontSize: 13, marginTop: 2 }} />
      <span>{t('And on {0} less sleep than usual — that PR was earned twice.', hhmm(pr.deficitMin))}</span>
    </div>}

    {rest && !applied && <div className="wnote" style={{ marginTop: 0 }}>
      <Icon name="timer" />
      <div>
        <div>{rest.why === 'slow'
          ? t('Your pulse was still {0} bpm above where it started when the next set began. Try {1}s rest.', rest.avg, rest.sec)
          : t('Your pulse settles fast — {0} bpm inside a minute. {1}s rest would keep the session tighter.', rest.avg, rest.sec)}</div>
        <button className="btn sm plain" style={{ paddingInline: 0 }}
          onClick={() => { useStore.getState().update(s => { s.restSec = rest.sec }); setApplied(true) }}>
          {t('Use {0}s', rest.sec)}
        </button>
      </div>
    </div>}
    {applied && <div className="small muted row" style={{ gap: 6 }}>
      <Icon name="check" style={{ fontSize: 13 }} />{t('Rest timer set to {0}s', rest.sec)}
    </div>}
  </div>
}

/* ============================ stats tab ============================ */

const avgOf = arr => (arr.length ? arr.reduce((n, v) => n + v, 0) / arr.length : null)

// The long view. Everything here needs weeks of data to say anything, which is
// why it lives in Stats and not on the home screen.
export function HealthStatsCard({ S }) {
  const health = useHealth()
  const [range, setRange] = useState(90)
  if (!MOBILE || !isLinked()) return null

  const cutoff = Date.now() - (range || 3650) * 86400000
  const rows = Object.entries(health.days)
    .filter(([iso]) => new Date(iso + 'T12:00:00').getTime() > cutoff)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  if (rows.length < 3) {
    return <div className="card">
      <h2>{t('Health')}</h2>
      <div className="muted small">{t('A few more days of watch data and the trends show up here.')}</div>
    </div>
  }

  const sleepPts = rows.filter(([, d]) => d.sleepMin)
    .map(([iso, d]) => ({ t: new Date(iso + 'T12:00:00').getTime(), y: Math.round(d.sleepMin / 6) / 10, d: iso }))
  const rhrPts = rows.filter(([, d]) => d.rhr)
    .map(([iso, d]) => ({ t: new Date(iso + 'T12:00:00').getTime(), y: d.rhr, d: iso }))

  const avgSleep = avgOf(rows.map(([, d]) => d.sleepMin).filter(Boolean))
  const avgRhr = avgOf(rows.map(([, d]) => d.rhr).filter(Boolean))
  const avgSteps = avgOf(rows.map(([, d]) => d.steps).filter(Boolean))

  const inRange = (S.workouts || []).filter(w => (w.start || 0) > cutoff)
  const corr = sleepVsVolume(health.days, inRange)

  return <div className="card">
    <div className="row between" style={{ marginBottom: 8 }}>
      <h2 style={{ margin: 0 }}>{t('Health')}</h2>
    </div>
    <Segmented className="seg-range" value={range} onChange={setRange}
      options={[{ value: 30, label: '1M' }, { value: 90, label: '3M' }, { value: 365, label: '1Y' }, { value: 0, label: t('All') }]} />

    <div className="hstats" style={{ marginTop: 12 }}>
      <div className="hstat"><div className="l"><Icon name="sleep" />{t('Avg sleep')}</div>
        <div className="v">{hhmm(avgSleep)}</div></div>
      <div className="hstat"><div className="l"><Icon name="heart" />{t('Avg resting')}</div>
        <div className="v">{avgRhr ? Math.round(avgRhr) : '—'}<small>{t('bpm')}</small></div></div>
      <div className="hstat"><div className="l"><Icon name="footsteps" />{t('Avg steps')}</div>
        <div className="v">{avgSteps ? Math.round(avgSteps).toLocaleString() : '—'}</div></div>
    </div>

    {sleepPts.length > 2 && <>
      <h4 className="sec" style={{ marginTop: 16 }}>{t('Sleep')}</h4>
      <div className="chart"><LineChart points={sleepPts} h={140} unit={t('h')} color="var(--indigo)" /></div>
    </>}

    {rhrPts.length > 2 && <>
      <h4 className="sec" style={{ marginTop: 14 }}>{t('Resting heart rate')}</h4>
      <div className="chart"><LineChart points={rhrPts} h={130} unit={t('bpm')} color="var(--red)" /></div>
      <p className="dim small" style={{ marginTop: 6, lineHeight: 1.45 }}>
        {t('A resting pulse drifting down over months is the clearest fitness signal here. Day to day it mostly reports sleep, heat and stress.')}
      </p>
    </>}

    {/* Correlation, only once there is enough of it to be worth a sentence.
        Below ~20 sessions this is reading noise, so it shows the count instead. */}
    <h4 className="sec" style={{ marginTop: 16 }}>{t('Sleep and what you lift the next day')}</h4>
    {corr.r != null && corr.n >= 20 ? (
      <p className="muted small" style={{ lineHeight: 1.5 }}>
        {corr.r >= 0.25
          ? t('Across {0} sessions, your better-slept days carried more volume. Worth protecting the night before a heavy session.', corr.n)
          : corr.r <= -0.25
            ? t('Across {0} sessions, your bigger sessions follow shorter nights — often a sign the hard days are simply scheduled early.', corr.n)
            : t('Across {0} sessions there is no clear link either way. Your training holds up regardless of the night before.', corr.n)}
      </p>
    ) : (
      <p className="muted small" style={{ lineHeight: 1.5 }}>
        {t('{0} of about 20 sessions with a night’s sleep recorded — the link needs a couple of months before it means anything.', corr.n)}
      </p>
    )}
  </div>
}

const PART_NAME = { sleep: 'Sleep', rhr: 'Resting pulse', load: 'This week’s load' }
const PART_DETAIL = p => {
  if (p.key === 'sleep') return t('{0} against your usual {1}', hhmm(p.value), hhmm(p.target))
  if (p.key === 'rhr') return t('{0} bpm · {1} vs your 7-day average', p.value, (p.delta >= 0 ? '+' : '') + p.delta)
  return t('{0}× a normal week for you', p.value)
}
