// One native Health Connect call → one line the pull log can show.
// Kept out of WatchCard so the wording can be tested without mounting React.

import { t } from './i18n.js'
import { isoOf } from './format.js'
import { originLabel } from './health-origins.js'

function dayLabel(iso) {
  if (!iso) return ''
  const today = isoOf(new Date())
  if (iso === today) return t('Today')
  const y = new Date(); y.setDate(y.getDate() - 1)
  if (iso === isoOf(y)) return t('Yesterday')
  return iso
}

function kindLabel(kind) {
  return ({
    steps: t('step count'),
    kcal: t('calories'),
    sleep: t('sleep data'),
    rhr: t('resting heart rate'),
    recovery: t('recovery readings'),
  })[kind] || kind
}

export function logLine(info) {
  if (!info?.step) return null
  if (info.step === 'checking') return t('Checking permissions…')
  if (info.step === 'granted') return t('Allowed {0} types — starting the read', info.count)
  if (info.step === 'probe' && info.state === 'start') return t('Testing a one-day steps read…')
  if (info.step === 'probe' && info.state === 'skip') return t('This build has no steps probe — continuing')
  if (info.step === 'probe' && info.state === 'fail') {
    return t('Steps probe failed: {0}', info.reason || 'error')
  }
  if (info.step === 'probe' && info.state === 'ok') {
    const who = info.origin
      ? originLabel(info.origin)
      : (info.origins || []).filter(Boolean).join(', ')
    const steps = info.steps != null ? Math.round(info.steps) : '—'
    const recs = info.records != null ? info.records : '—'
    const ms = info.ms != null ? info.ms : '—'
    return who
      ? t('Probe: {0} records, {1} steps from {2} ({3} ms)', recs, steps, who, ms)
      : t('Probe: {0} records, {1} steps ({2} ms)', recs, steps, ms)
  }
  if (info.step === 'day') {
    return t('Day {0} of {1}: {2}', (info.index || 0) + 1, info.total, dayLabel(info.iso))
  }
  if (info.step === 'read' && info.state === 'start') {
    return t('Reading {0} for {1}…', kindLabel(info.kind), dayLabel(info.iso))
  }
  if (info.step === 'read' && info.state === 'fail') {
    return t('{0} for {1} failed: {2}', kindLabel(info.kind), dayLabel(info.iso), info.reason || 'error')
  }
  if (info.step === 'read' && info.state === 'ok') {
    const r = info.result || {}
    if (info.kind === 'steps') {
      return r.steps != null
        ? t('Steps {0}: {1}', dayLabel(info.iso), Math.round(r.steps))
        : t('Steps {0}: none recorded', dayLabel(info.iso))
    }
    if (info.kind === 'kcal') {
      const n = r.activeCalories ?? r.totalCalories
      return n != null
        ? t('Calories {0}: {1}', dayLabel(info.iso), Math.round(n))
        : t('Calories {0}: none recorded', dayLabel(info.iso))
    }
    if (info.kind === 'sleep') {
      const n = (r.sessions || []).length
      return n
        ? t('Sleep {0}: {1} sessions', dayLabel(info.iso), n)
        : t('Sleep {0}: none recorded', dayLabel(info.iso))
    }
    if (info.kind === 'rhr') {
      const n = (r.samples || []).length
      if (!n) return t('Resting HR {0}: none recorded', dayLabel(info.iso))
      const bpm = Math.round(Math.min(...r.samples.map(s => s.bpm)))
      return t('Resting HR {0}: {1} bpm', dayLabel(info.iso), bpm)
    }
    if (info.kind === 'recovery') {
      return t('Recovery {0}: SpO₂ {1}, HRV {2}',
        dayLabel(info.iso), (r.spo2 || []).length, (r.hrv || []).length)
    }
  }
  if (info.step === 'stopped' && info.reason === 'empty') {
    return t('Stopped: no more days in Health Connect')
  }
  if (info.step === 'stopped') return t('Stopped: Health Connect is not answering reads')
  if (info.step === 'done') return t('Finished reading')
  if (info.step === 'skip-kcal') {
    return t('Skipping calories on this phone — they hang Health Connect. Continuing with sleep.')
  }
  if (info.step === 'skip-recovery') {
    return t('Skipping recovery readings on this phone — continuing.')
  }
  if (info.step === 'history' && info.state === 'ok') {
    return t('History access is on — reading up to a year.')
  }
  if (info.step === 'history') {
    return t('No past-data access — about 30 days only. Health Connect → App access → Additional access.')
  }
  return null
}
