// Settings → Watch & health.
//
// The card leads with the device rather than with a toggle, because pairing goes
// wrong at "which watch, which app", not at the permission grant. Three states,
// each with something to do: nothing linked, linked, and linked-but-Android-took
// -the-permission-back (which happens on its own after a month away).
//
// Everything the user is told here has to stay true: there is no account to sign
// into, nothing is uploaded, and unlinking never touches the training log.

import { useEffect, useState } from 'react'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { fmtDate, isoOf } from '../lib/format.js'
import {
  getConn, subscribeHealth, refreshLinkState, connectWatch, disconnectWatch,
  openHealthConnectSettings, installHealthConnect, updateConn, getHealth,
  diagnoseHealth,
} from '../lib/health-store.js'
import { listOrigins } from '../lib/health-connect.js'
import { confirmSheet } from '../sheets.jsx'
import { Section, Row, Button } from './ui.jsx'
import WatchDevice from './WatchDevice.jsx'
import Icon from './Icon.jsx'

// Written as a sequence because it genuinely is one — each step only works once
// the one above it has. Most pairing failures are someone doing step 4 first.
const SETUP_STEPS = [
  ['Pair the watch with Huawei Health', 'That is the app your watch actually talks to. Your readings have to land there first.'],
  ['Install Health Sync, set the destination to Health Connect', 'Huawei Health does not write to Health Connect on its own. Pick Health Connect — not Google Fit.'],
  ['Run one sync', 'Open Health Sync and let it push once, so there is something here to read.'],
  ['Allow Gemak to read it', 'The next screen is Android’s own permission picker. No Google or Huawei sign-in is involved.'],
]

/**
 * What the phone actually reports, when the link fails and nobody can plug it in.
 *
 * This exists because three rounds of fixes were shipped against a description
 * of a symptom. Every line here is a fact the device knows and the developer
 * cannot: which Android, whether Health Connect answers, whether the permission
 * declarations survived into the installed build, and what the picker intent
 * resolves to on this particular OS version.
 */
function DiagnoseSheet({ toast }) {
  const [d, setD] = useState(null)

  useEffect(() => { diagnoseHealth().then(setD) }, [])

  const rows = d && !d.error ? [
    [t('Phone'), `${d.device} · Android SDK ${d.sdkInt}`],
    [t('Health Connect'), `${d.sdkStatusText} (${d.sdkStatus})`],
    [t('Provider app installed'), d.providerInstalled ? t('Yes') : t('No — built into Android')],
    [t('Health permissions in this build'), String(d.declaredHealthPermissions)],
    [t('Permission screen'), d.pickerAction],
    [t('Resolves to an app'), d.pickerResolves ? t('Yes') : t('No — handled inside Android')],
    [t('Data connection'), d.clientBinds ? t('Works') : t('Timed out')],
    [t('Allowed right now'), d.grantedCount < 0 ? t('Could not read') : String(d.grantedCount)],
    [t('Allowed types'), (d.granted || []).join(', ') || '—'],
  ] : []

  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n')

  return <>
    <h3>{t('Connection check')}</h3>
    <p className="muted small" style={{ marginBottom: 10, lineHeight: 1.5 }}>
      {t('What this phone reports. Send a screenshot of this if the watch still won’t link.')}
    </p>

    {!d && <div className="wnote"><Icon name="reset" /><div>{t('Checking…')}</div></div>}
    {d?.error && (
      <div className="wnote"><Icon name="info" /><div>{t('The check itself failed: {0}', d.error)}</div></div>
    )}

    {rows.length > 0 && (
      <div className="sect-b">
        {rows.map(([k, v]) => (
          <div className="lrow" key={k} style={{ alignItems: 'flex-start' }}>
            <span className="lrow-m">
              <span className="lrow-t">{k}</span>
              <span className="lrow-s" style={{ wordBreak: 'break-all', whiteSpace: 'normal' }}>{v}</span>
            </span>
          </div>
        ))}
      </div>
    )}

    {rows.length > 0 && (
      <>
        <div style={{ height: 10 }} />
        <Button icon="clipboard" onClick={async () => {
          try { await navigator.clipboard.writeText(text); toast(t('Copied')) }
          catch { toast(t('Could not copy')) }
        }}>{t('Copy')}</Button>
      </>
    )}
    <div style={{ height: 8 }} />
  </>
}

const openDiagnose = toast => useUI.getState().openSheet(() => <DiagnoseSheet toast={toast} />)

// openSettings reports whether anything actually opened. Which deep link works
// depends on the Android version, and a tap that silently does nothing is the
// worst outcome here — this is the route people fall back to when the picker
// misbehaves, so it has to either work or say why not.
const openHC = async toast => {
  if (!(await openHealthConnectSettings())) {
    toast(t('Couldn’t open Health Connect. Open Android Settings → Security & privacy → Health Connect.'))
  }
}

function SetupSheet({ close, toast }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState(null)

  const go = async () => {
    setBusy(true)
    setProblem(null)
    try {
      const res = await connectWatch('Huawei Watch Fit 4')
      if (res.ok) {
        close()
        toast(t('Watch connected'))
        // Fill the card with something immediately — an empty "connected" state
        // reads like it didn't work.
        syncNowAsync()
        rememberOrigins()
        return
      }
      setProblem(res.reason)
    } catch (e) {
      setProblem('timeout')
    } finally {
      setBusy(false)
    }
  }

  return <>
    <h3>{t('Connect your watch')}</h3>
    <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 16px', '--wdev-pip-ring': 'var(--bg-el)' }}>
      <WatchDevice state={busy ? 'linking' : 'off'} size={124} />
    </div>

    <div className="wsteps">
      {SETUP_STEPS.map(([title, sub], i) => (
        <div className="wstep" key={i}>
          <span className="wstep-n">{i + 1}</span>
          <span className="wstep-m">
            <span className="wstep-t">{t(title)}</span>
            <span className="wstep-s">{t(sub)}</span>
          </span>
        </div>
      ))}
    </div>

    {problem === 'unavailable' && (
      <div className="wnote">
        <Icon name="info" />
        <div>
          <div>{t('Health Connect isn’t installed on this phone.')}</div>
          <Button size="sm" variant="plain" onClick={installHealthConnect}>{t('Get it from Play Store')}</Button>
        </div>
      </div>
    )}
    {problem === 'update' && (
      <div className="wnote"><Icon name="info" /><div>{t('Health Connect needs updating before it can share data.')}</div></div>
    )}
    {problem === 'denied' && (
      <div className="wnote"><Icon name="info" /><div>
        {t('Heart rate wasn’t granted, so there is nothing to read. You can change it in Health Connect.')}
        <Button size="sm" variant="plain" onClick={() => openHC(toast)}>{t('Open Health Connect')}</Button>
      </div></div>
    )}
    {problem === 'no-plugin' && (
      <div className="wnote"><Icon name="info" /><div>{t('This build can’t reach Health Connect. Update the app and try again.')}</div></div>
    )}
    {problem === 'timeout' && (
      <div className="wnote">
        <Icon name="info" />
        <div>
          <div>{t('Health Connect didn’t respond. Try again, or open it yourself and allow Gemak.')}</div>
          <Button size="sm" variant="plain" onClick={() => openHC(toast)}>{t('Open Health Connect')}</Button>
        </div>
      </div>
    )}
    {problem === 'no-picker' && (
      <div className="wnote">
        <Icon name="info" />
        <div>
          <div>{t('The permission screen didn’t open. Allow Gemak from Health Connect, then try again.')}</div>
          <Button size="sm" variant="plain" onClick={() => openHC(toast)}>{t('Open Health Connect')}</Button>
        </div>
      </div>
    )}

    {/* The escape hatch. Some devices grant access in the picker and never
        deliver the result back, so the app can be told nothing while Health
        Connect already says yes. This asks the platform directly. */}
    {problem && (
      <>
        <div style={{ height: 10 }} />
        <Button icon="reset" onClick={async () => {
          if (await refreshLinkState() === 'ok') {
            close()
            toast(t('Watch connected'))
            syncNowAsync()
            rememberOrigins()
          } else {
            toast(t('Still no access — allow Gemak from Health Connect'))
          }
        }}>{t('I allowed it — check again')}</Button>
      </>
    )}

    <div style={{ height: 6 }} />
    <Button variant="primary" icon="watch" disabled={busy} onClick={go}>
      {busy ? t('Waiting for Health Connect…') : t('Allow access')}
    </Button>
    <div style={{ height: 8 }} />
    <Button size="sm" variant="plain" icon="info" onClick={() => openDiagnose(toast)}>
      {t('Connection check')}
    </Button>
    <div style={{ height: 4 }} />
    <p className="dim small" style={{ textAlign: 'center', lineHeight: 1.5 }}>
      {t('Nothing leaves your phone. Gemak reads the on-device store — it never sees a Google or Huawei account.')}
    </p>
    <div style={{ height: 8 }} />
  </>
}

// The sync layer is loaded on demand: it drags in the Capacitor bridge, and this
// card is the only thing that can be on screen before a watch exists at all.
const syncNowAsync = async (days = 2) => {
  try {
    const m = await import('../lib/health-sync.js')
    return await m.syncRecentDays(days)
  } catch (e) { return 0 }
}

// Which apps write into Health Connect. Recorded after a successful link so the
// source picker has something real to offer instead of a hardcoded guess.
async function rememberOrigins() {
  const end = Date.now()
  const r = await listOrigins(end - 7 * 86400000, end)
  if (r.ok && r.origins.length) updateConn(c => { c.origins = r.origins })
}

export default function WatchCard({ toast }) {
  const [conn, setConn] = useState(getConn())
  const [syncing, setSyncing] = useState(false)
  const [fill, setFill] = useState(null)   // percent while backfilling, null when idle

  useEffect(() => {
    const off = subscribeHealth(() => setConn({ ...getConn() }))
    // A stored 'ok' is a claim, not a fact — Health Connect withdraws access
    // silently after ~30 days without a launch.
    refreshLinkState()
    return off
  }, [])

  const open = () => useUI.getState().openSheet(close => <SetupSheet close={close} toast={toast} />)

  const unlink = () => confirmSheet({
    title: t('Unlink this watch?'),
    message: t('Removes everything read from the watch. Your workouts, plan and body weight stay exactly as they are.'),
    confirmText: t('Unlink'),
    danger: true,
    onConfirm: () => { disconnectWatch(); toast(t('Watch unlinked')) },
  })

  const backfill = () => confirmSheet({
    title: t('Fill in earlier days?'),
    // The honest version of both cases. Promising a year and delivering 30 days
    // is the kind of thing that makes people stop trusting the whole feature.
    message: conn.history
      ? t('Reads back day by day and stops where your data runs out. It can take a few minutes.')
      : t('History access isn’t granted, so Health Connect will only return about the last 30 days.'),
    confirmText: t('Start reading'),
    onConfirm: async () => {
      setFill(0)
      try {
        const m = await import('../lib/health-sync.js')
        const to = new Date()
        const from = new Date(); from.setFullYear(from.getFullYear() - 1)
        const res = await m.backfillDays(isoOf(from), isoOf(to), p => setFill(Math.round(p * 100)))
        toast(res.stoppedEarly
          ? t('Stopped where the data runs out — {0} days read', res.done)
          : t('{0} days read', res.done))
      } catch (e) {
        toast(t('Could not read earlier days'))
      } finally { setFill(null) }
    },
  })

  const syncNow = async () => {
    setSyncing(true)
    const n = await syncNowAsync(2)
    setSyncing(false)
    toast(n ? t('Synced') : t('Nothing new yet — Health Sync may still be catching up'))
  }

  const pickSource = () => {
    const origins = conn.origins || []
    if (!origins.length) { toast(t('No sources seen yet — sync once first')); return }
    useUI.getState().openSheet(close => <>
      <h3>{t('Read from')}</h3>
      <p className="muted small" style={{ marginBottom: 10, lineHeight: 1.5 }}>
        {t('Your phone counts steps too. Picking one source stops the same walk being counted twice.')}
      </p>
      <div className="sect-b">
        {[{ pkg: null, label: t('All sources') }, ...origins].map(o => (
          <button key={o.pkg || 'all'} className="lrow tap"
            onClick={() => { close(); updateConn(c => { c.trusted = o.pkg }); syncNowAsync(2) }}>
            <span className="lrow-m"><span className="lrow-t">{o.label}</span></span>
            {conn.trusted === o.pkg && <Icon name="check" className="lrow-k" />}
          </button>
        ))}
      </div>
      <div style={{ height: 8 }} />
    </>)
  }

  /* ---------- not linked ---------- */
  if (conn.state === 'off') {
    return (
      <Section title={t('Watch & health')}
        footer={t('Reads what your watch already saved on this phone. No account, no upload.')}>
        <div className="wcard">
          <WatchDevice state="off" size={92} />
          <div className="wcard-m">
            <span className="wcard-t">{t('Add a watch')}</span>
            <span className="wcard-s">{t('See heart rate, sleep and calories next to the workout that earned them.')}</span>
            <Button size="sm" variant="primary" icon="watch" onClick={open}>{t('Connect')}</Button>
          </div>
        </div>
        <Row icon="gear" iconTint="var(--grey)" title={t('Open Health Connect')} accessory="chevron"
          onClick={() => openHC(toast)} />
        <Row icon="info" iconTint="var(--label-3)" title={t('Connection check')}
          subtitle={t('What this phone reports, when linking won’t work')}
          accessory="chevron" onClick={() => openDiagnose(toast)} />
      </Section>
    )
  }

  /* ---------- linked, but Android took the permission back ---------- */
  if (conn.state === 'revoked') {
    return (
      <Section title={t('Watch & health')}
        footer={t('Android withdraws health permissions on its own after about a month without opening the app. Nothing was lost.')}>
        <div className="wcard">
          <WatchDevice state="revoked" size={92} />
          <div className="wcard-m">
            <span className="wcard-t">{t('Access expired')}</span>
            <span className="wcard-s">{t('Health Connect stopped sharing. Reconnect to pick up where you left off.')}</span>
            <Button size="sm" variant="primary" icon="reset" onClick={open}>{t('Reconnect')}</Button>
          </div>
        </div>
        <Row icon="trash" iconTint="var(--red)" title={t('Unlink watch')} danger onClick={unlink} />
      </Section>
    )
  }

  /* ---------- linked ---------- */
  const lastSync = conn.lastSyncAt ? fmtDate(isoOf(new Date(conn.lastSyncAt)), true) : null
  const today = getHealth().days[isoOf(new Date())] || {}
  const trusted = (conn.origins || []).find(o => o.pkg === conn.trusted)

  return (
    <Section title={t('Watch & health')}
      footer={t('Everything read here stays on this phone — it is never uploaded and never goes into your backup file.')}>
      <div className="wcard">
        <WatchDevice state="ok" size={92} bpm={today.rhr || null} />
        <div className="wcard-m">
          <span className="wcard-t">{conn.deviceLabel || t('Watch connected')}</span>
          <span className="wcard-s">
            {lastSync ? t('Last sync {0}', lastSync) : t('Waiting for the first reading')}
          </span>
          <span className="tag" style={{ color: 'var(--green)', background: 'color-mix(in srgb,var(--green) 16%,transparent)' }}>
            {t('Connected')}
          </span>
        </div>
      </div>

      <Row icon="footsteps" iconTint="var(--teal)" title={t('Today')}
        subtitle={today.steps != null
          ? t('{0} steps · {1} kcal active', Math.round(today.steps), Math.round(today.kcalActive || 0))
          : t('Nothing read for today yet')}
        value={syncing ? '…' : undefined}
        accessory={syncing ? 'none' : 'chevron'} onClick={syncing ? undefined : syncNow} />

      <Row icon="shuffle" iconTint="var(--blue)" title={t('Read from')}
        value={trusted ? trusted.label : t('All sources')}
        accessory="chevron" onClick={pickSource} />

      <Row icon="history" iconTint={conn.history ? 'var(--green)' : 'var(--label-3)'}
        title={conn.history ? t('Full history allowed') : t('Last 30 days only')}
        subtitle={conn.history ? null : t('Health Connect caps older data unless you allow history.')}
        accessory="chevron" onClick={() => openHC(toast)} />

      {/* Older days, on request only. Never at boot: a year is hundreds of
          round trips, and it stops on its own once the readings run out rather
          than walking months of empty days. */}
      <Row icon="download" iconTint="var(--indigo)" title={t('Fill in earlier days')}
        subtitle={fill == null ? t('Reads back through what Health Connect still has') : undefined}
        value={fill == null ? undefined : fill + '%'}
        accessory={fill == null ? 'chevron' : 'none'}
        onClick={fill == null ? backfill : undefined} />

      <Row icon="gear" iconTint="var(--grey)" title={t('Manage in Health Connect')} accessory="chevron" onClick={() => openHC(toast)} />
      <Row icon="trash" iconTint="var(--red)" title={t('Unlink watch')} danger onClick={unlink} />
    </Section>
  )
}
