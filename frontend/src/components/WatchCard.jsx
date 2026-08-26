// Settings → Watch & health.
//
// Two actions, kept apart because Honor/Huawei hang if they are combined:
//   · Allow from Health Connect — opens Health Connect so the user can turn
//     Gemak on there (the in-app picker never appears on those phones)
//   · Pull watch data — only reads. No permission sheet.

import { useEffect, useState, useRef } from 'react'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { fmtDate, isoOf } from '../lib/format.js'
import {
  refreshLinkState, disconnectWatch,
  openHealthConnectPermissions, installHealthConnect, connectWatch,
  updateConn, diagnoseHealth, checkAvailability, pullWatchData, loadHealthSync,
} from '../lib/health-store.js'
import { useHealth } from './HealthCards.jsx'
import { bridgeReport } from '../lib/bridge-report.js'
import { listOrigins } from '../lib/health-connect.js'
import { logLine } from '../lib/health-pull-log.js'
import { pickWatchOrigin, originLabel, looksLikePackage, cleanOrigins } from '../lib/health-origins.js'
import { confirmSheet } from '../sheets.jsx'
import { Section, Row, Button } from './ui.jsx'
import WatchDevice from './WatchDevice.jsx'
import Icon from './Icon.jsx'

const SETUP_HUAWEI = [
  ['Pair the watch with Huawei Health', 'That is the app your watch actually talks to. Your readings have to land there first.'],
  ['Open Huawei Health and let it sync once', 'Wait until today’s steps or last night’s sleep show up in Huawei Health.'],
  ['Sign in with your Huawei ID', 'Gemak will ask Huawei Health for permission to read heart rate, sleep, steps and calories from your account.'],
]

const SETUP_HC = [
  ['Pair the watch with Huawei Health', 'That is the app your watch actually talks to. Your readings have to land there first.'],
  ['Install Health Sync, set the destination to Health Connect', 'Huawei Health does not write to Health Connect on its own. Pick Health Connect — not Google Fit.'],
  ['Run one sync', 'Open Health Sync and let it push once, so there is something here to read.'],
  ['Allow Gemak in Health Connect', 'Tap Allow access. Android shows its own permission screen — at minimum turn on heart rate. If it doesn’t appear, Health Connect opens so you can turn Gemak on there.'],
]

function DiagnoseSheet({ toast }) {
  const [d, setD] = useState(null)
  const [b, setB] = useState(null)

  // Two independent readouts, started together and rendered as each arrives.
  // The bridge one needs nothing but @capacitor/core, so it answers even when
  // the Health plugin is exactly what is broken — which is the case this screen
  // exists for.
  useEffect(() => {
    bridgeReport().then(setB, () => setB({ error: 'failed' }))
    diagnoseHealth().then(setD, () => setD({ error: 'failed' }))
  }, [])

  const bridgeRows = b ? [
    [t('Platform'), `${b.platform || '—'}${b.native ? '' : ' · ' + t('not native')}`],
    [t('Mobile build'), b.mobileBuild ? t('Yes') : t('No')],
    [t('Plugins the bridge exposes'), (b.plugins || []).join(', ') || t('none')],
    [t('Health plugin registered'), b.healthRegistered ? t('Yes') : t('No')],
    // The method list is what decides whether a call is even attempted: anything
    // missing from here rejects as "not implemented" before it reaches native.
    [t('Health plugin methods'), (b.healthMethods || []).join(', ') || t('none')],
    [t('Update plugin methods'), (b.appUpdateMethods || []).join(', ') || t('none')],
    [t('Health plugin answers'), b.healthProbe || '—'],
    [t('Update plugin answers'), b.appUpdateProbe || '—'],
    [t('Full check answers'), b.diagnoseProbe || '—'],
  ] : []

  // Prefer the store's readout, fall back to the one the bridge report took
  // directly off the plugin — so this section fills in even when the store
  // cannot produce a handle.
  const data = d && !d.error ? d : (b?.diagnose || null)

  const routeRow = data?.settingsRoutes?.length
    ? [[t('Settings routes'), data.settingsRoutes.join(' · ')]]
    : []
  const huawei = data?.provider === 'huawei'
  const rows = data ? [
    [t('Phone'), `${data.device} · Android SDK ${data.sdkInt}`],
    [t('Health source'), huawei ? t('Huawei Health Kit') : t('Health Connect')],
    huawei
      ? [t('HMS Core'), data.hmsAvailable ? t('Works') : t('Missing')]
      : [t('Health Connect'), `${data.sdkStatusText} (${data.sdkStatus})`],
    huawei
      ? [t('Huawei Health installed'), data.huaweiHealthInstalled ? t('Yes') : t('No')]
      : [t('Provider app installed'), data.providerInstalled ? t('Yes') : t('No — built into Android')],
    huawei ? [t('App ID in this build'), data.appIdConfigured ? t('Yes') : t('No')] : null,
    huawei
      ? [t('Huawei Health authorised'), data.healthAuthorized ? t('Yes') : t('No')]
      : [t('Health permissions in this build'), String(data.declaredHealthPermissions)],
    [t('Permission screen'), data.pickerAction],
    [t('Resolves to an app'), data.pickerResolves ? t('Yes') : t('No — handled inside Android')],
    [t('Data connection'), data.clientBinds ? t('Works') : t('Timed out')],
    [t('Allowed right now'), data.grantedCount < 0 ? t('Could not read') : String(data.grantedCount)],
    [t('Allowed types'), (data.granted || []).join(', ') || '—'],
    data.probeOk === false
      ? [t('Steps probe'), `${data.probeReason || 'failed'} (${data.probeMs} ms)`]
      : data.probeOk
        ? [t('Steps probe'), `${data.probeRecords} ${t('records')} · ${data.probeSteps} ${t('steps')} · ${data.probeMs} ms`]
        : null,
    data.probeOrigins
      ? [t('Steps written by'), (Array.isArray(data.probeOrigins) ? data.probeOrigins : []).join(', ') || '—']
      : null,
    data.probeAggregate != null
      ? [t('Steps aggregate'), `${data.probeAggregate} (${data.probeAggregateMs} ms)`]
      : null,
    ...routeRow,
  ].filter(Boolean) : []

  const all = [...bridgeRows, ...rows]
  const text = all.map(([k, v]) => `${k}: ${v}`).join('\n')

  const List = ({ items }) => (
    <div className="sect-b">
      {items.map(([k, v]) => (
        <div className="lrow" key={k} style={{ alignItems: 'flex-start' }}>
          <span className="lrow-m">
            <span className="lrow-t">{k}</span>
            <span className="lrow-s" style={{ wordBreak: 'break-all', whiteSpace: 'normal' }}>{v}</span>
          </span>
        </div>
      ))}
    </div>
  )

  return <>
    <h3>{t('Connection check')}</h3>
    <p className="muted small" style={{ marginBottom: 10, lineHeight: 1.5 }}>
      {t('What this phone reports. Send a screenshot of this if the watch still won’t link.')}
    </p>

    {/* The bridge section first, and on its own clock. It is the half that
        still answers when the native plugin is the thing at fault. */}
    <p className="muted small" style={{ margin: '4px 0 6px' }}>{t('App bridge')}</p>
    {!b && <div className="wnote"><Icon name="reset" /><div>{t('Checking…')}</div></div>}
    {b?.error && (
      <div className="wnote"><Icon name="info" /><div>{t('The check itself failed: {0}', b.error)}</div></div>
    )}
    {bridgeRows.length > 0 && <List items={bridgeRows} />}

    <div style={{ height: 12 }} />
    <p className="muted small" style={{ margin: '4px 0 6px' }}>{t('Health Connect')}</p>
    {!d && !data && <div className="wnote"><Icon name="reset" /><div>{t('Checking…')}</div></div>}
    {/* Shown even when the rows below filled in from the direct probe: that
        combination — store failed, plugin answered — is itself the finding. */}
    {d?.error && (
      <div className="wnote"><Icon name="info" /><div>{t('The check itself failed: {0}', d.error)}</div></div>
    )}
    {rows.length > 0 && <List items={rows} />}

    {all.length > 0 && (
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

function PullLog({ pulling, pct, lines }) {
  const box = useRef(null)
  useEffect(() => {
    const el = box.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])
  if (!lines.length) return null
  return (
    <div className="wlog" ref={box}>
      <div className="wlog-h">{pulling ? t('Pulling watch data… {0}%', pct) : t('Last pull')}</div>
      {lines.map((line, i) => (
        <div key={i} className="wlog-l">{line}</div>
      ))}
    </div>
  )
}

const openHC = async toast => {
  if (!(await openHealthConnectPermissions())) {
    toast(t('Couldn’t open Health Connect. Open Android Settings → Security & privacy → Health Connect.'))
  }
}

/**
 * Ask for access — properly, then as a fallback.
 *
 * The in-app request goes first. From Android 14 health permissions are ordinary
 * runtime permissions, so this is the mechanism the OS actually supports, and on
 * this phone it had never once run: the plugin handle was null until the static
 * import landed, so no request was ever sent. "Honor never shows the popup" was
 * a conclusion drawn from that, not from a request that was refused.
 *
 * If it still doesn't land, Health Connect's own screen is the fallback — and it
 * only reports failure once neither route worked.
 */
const grantAccess = async (toast, onLinked) => {
  const res = await connectWatch('Huawei Watch Fit 4')
  if (res.ok) {
    toast(t('Watch connected'))
    onLinked?.()
    return true
  }
  if (await openHealthConnectPermissions()) {
    toast(t('Turn Gemak on in Health Connect, then pull the data'))
  } else {
    toast(t('Couldn’t open Health Connect. Open Android Settings → Security & privacy → Health Connect.'))
  }
  return false
}

function HealthConnectPermissionRow({ toast }) {
  return (
    <Row
      icon="shield"
      iconTint="var(--blue)"
      title={t('Allow access')}
      subtitle={t('Asks for permission here. If Android doesn’t show it, Health Connect opens instead.')}
      accessory="chevron"
      onClick={() => grantAccess(toast, () => pullWatchData())}
    />
  )
}

function SetupSheet({ close, toast }) {
  const [busy, setBusy] = useState(false)
  const [pct, setPct] = useState(0)
  const [pullLog, setPullLog] = useState([])
  const [problem, setProblem] = useState(null)
  const [provider, setProvider] = useState('health-connect')

  useEffect(() => {
    checkAvailability().then(r => {
      if (r.ok && r.provider === 'huawei') setProvider('huawei')
      else setProvider(r.provider || 'health-connect')
    })
  }, [])

  const huawei = provider === 'huawei'
  const steps = huawei ? SETUP_HUAWEI : SETUP_HC

  const go = async () => {
    setBusy(true)
    setPct(5)
    const startLine = logLine({ step: 'probe', state: 'start' })
    setPullLog(startLine ? [startLine] : [])
    setProblem(null)
    try {
      const res = await pullWatchData(undefined, (p, info) => {
        setPct(Math.max(1, Math.round(p * 100)))
        const line = logLine(info)
        if (line) setPullLog(l => [...l.slice(-20), line])
      })
      if (res.ok) {
        close()
        toast(res.days ? t('Synced') : t('Allowed — nothing new yet. Health Sync may still be catching up.'))
        rememberOrigins()
        return
      }
      setProblem(res.reason)
      if (res.reason === 'need-permission' || res.reason === 'no-picker' || res.reason === 'timeout') {
        await openHealthConnectPermissions()
      }
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
      {steps.map(([title, sub], i) => (
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
    {problem === 'no-hms' && (
      <div className="wnote"><Icon name="info" /><div>{t('HMS Core isn’t available on this phone, so Huawei Health Kit can’t run.')}</div></div>
    )}
    {problem === 'no-health-app' && (
      <div className="wnote">
        <Icon name="info" />
        <div>
          <div>{t('Install Huawei Health and sync the watch once, then try again.')}</div>
          <Button size="sm" variant="plain" onClick={installHealthConnect}>{t('Get Huawei Health')}</Button>
        </div>
      </div>
    )}
    {problem === 'not-configured' && (
      <div className="wnote"><Icon name="info" /><div>{t('This build has no Huawei App ID. Drop agconnect-services.json into the Android app and rebuild — see docs/HUAWEI_HEALTH.md.')}</div></div>
    )}
    {(problem === 'denied' || problem === 'need-permission') && (
      <div className="wnote"><Icon name="info" /><div>
        {t('Gemak isn’t allowed in Health Connect yet. Data from Health Sync stays invisible until you turn Gemak on there.')}
        <Button size="sm" variant="plain" onClick={() => openHC(toast)}>
          {t('Allow from Health Connect')}
        </Button>
      </div></div>
    )}
    {problem === 'no-bind' && (
      <div className="wnote"><Icon name="info" /><div>
        {t('This phone can open Health Connect, but Gemak can’t read the store. Allow Gemak inside Health Connect, then pull again.')}
        <Button size="sm" variant="plain" onClick={() => openHC(toast)}>
          {t('Allow from Health Connect')}
        </Button>
      </div></div>
    )}
    {problem === 'no-plugin' && (
      <div className="wnote"><Icon name="info" /><div>{t('This build can’t reach Health Connect. Update the app and try again.')}</div></div>
    )}
    {problem === 'timeout' && (
      <div className="wnote">
        <Icon name="info" />
        <div>
          <div>{t('Health Connect didn’t respond. Allow Gemak from Health Connect itself, then pull.')}</div>
          <Button size="sm" variant="plain" onClick={() => openHC(toast)}>
            {t('Allow from Health Connect')}
          </Button>
        </div>
      </div>
    )}
    {problem === 'no-picker' && (
      <div className="wnote">
        <Icon name="info" />
        <div>
          <div>{t('The permission screen didn’t open. Allow Gemak from Health Connect, then pull.')}</div>
          <Button size="sm" variant="plain" onClick={() => openHC(toast)}>
            {t('Allow from Health Connect')}
          </Button>
        </div>
      </div>
    )}

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
    <Button variant="plain" icon="shield" onClick={() => grantAccess(toast, () => { close(); syncNowAsync() })}>
      {t('Allow access')}
    </Button>
    <div style={{ height: 8 }} />
    <Button variant="primary" icon="download" disabled={busy} onClick={go}>
      {busy ? t('Pulling watch data… {0}%', pct) : t('Pull watch data')}
    </Button>
    <PullLog pulling={busy} pct={pct} lines={pullLog} />
    <div style={{ height: 8 }} />
    <Button size="sm" variant="plain" icon="info" onClick={() => openDiagnose(toast)}>
      {t('Connection check')}
    </Button>
    <div style={{ height: 4 }} />
    <p className="dim small" style={{ textAlign: 'center', lineHeight: 1.5 }}>
      {huawei
        ? t('You sign in with your Huawei ID. Readings stay on this phone after they are fetched — they are never uploaded and never go into your backup file.')
        : t('Nothing leaves your phone. Gemak reads the on-device store — it never sees a Google or Huawei account.')}
    </p>
    <div style={{ height: 8 }} />
  </>
}

const syncNowAsync = async (days = 2) => {
  try {
    const m = await loadHealthSync()
    return await m.syncRecentDays(days)
  } catch (e) { return 0 }
}

async function rememberOrigins() {
  const end = Date.now()
  const r = await listOrigins(end - 7 * 86400000, end)
  if (!r.ok || !r.origins.length) return
  const pkgs = cleanOrigins(r.origins)
  if (!pkgs.length) return
  updateConn(c => {
    c.origins = pkgs.map(pkg => ({ pkg, label: originLabel(pkg) }))
    if (c.trusted && !looksLikePackage(c.trusted)) c.trusted = null
    if (!c.trusted) c.trusted = pickWatchOrigin(pkgs)
  })
}

export default function WatchCard({ toast }) {
  const health = useHealth()
  const conn = health.conn
  const [syncing, setSyncing] = useState(false)
  const [fill, setFill] = useState(null)
  const [pulling, setPulling] = useState(false)
  const [pullPct, setPullPct] = useState(0)
  const [pullLog, setPullLog] = useState([])
  const huawei = conn.provider === 'huawei'

  const open = () => useUI.getState().openSheet(close => <SetupSheet close={close} toast={toast} />)

  const pull = async () => {
    setPulling(true)
    setPullPct(5)
    const startLine = logLine({ step: 'probe', state: 'start' })
    setPullLog(startLine ? [startLine] : [])
    try {
      const res = await pullWatchData(undefined, (p, info) => {
        setPullPct(Math.max(1, Math.round(p * 100)))
        const line = logLine(info)
        if (line) setPullLog(l => [...l.slice(-20), line])
      })
      if (res.ok) {
        toast(res.days ? t('Synced') : t('Nothing new yet — Health Sync may still be catching up'))
        rememberOrigins()
        return
      }
      if (res.reason === 'need-permission' || res.reason === 'denied') {
        toast(t('Allow Gemak from Health Connect first, then pull.'))
      } else if (res.reason === 'no-plugin') {
        toast(t('This build can’t reach Health Connect. Update the app and try again.'))
      } else if (res.reason === 'timeout' || res.reason === 'chunk-timeout' || res.reason === 'no-bind') {
        // Not a permission problem. Every type can be granted and the reads
        // still not answer — telling the user to go and allow it again sends
        // them back to a screen that is already correct.
        toast(t('Health Connect didn’t answer. The log below shows which read stopped.'))
      } else {
        toast(t('Could not read earlier days'))
      }
    } finally {
      setPulling(false)
    }
  }

  const unlink = () => confirmSheet({
    title: t('Unlink this watch?'),
    message: t('Removes everything read from the watch. Your workouts, plan and body weight stay exactly as they are.'),
    confirmText: t('Unlink'),
    danger: true,
    onConfirm: () => { disconnectWatch(); toast(t('Watch unlinked')) },
  })

  const backfill = () => confirmSheet({
    title: t('Fill in earlier days?'),
    message: (huawei || conn.history)
      ? t('Reads back day by day and stops where your data runs out. It can take a few minutes.')
      : t('History access isn’t granted, so Health Connect will only return about the last 30 days.'),
    confirmText: t('Start reading'),
    onConfirm: async () => {
      setFill(0)
      try {
        const m = await loadHealthSync()
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
    toast(n ? t('Synced') : (huawei
      ? t('Nothing new yet — Huawei Health may still be catching up')
      : t('Nothing new yet — Health Sync may still be catching up')))
  }

  const pickSource = () => {
    const origins = (conn.origins || []).filter(o => looksLikePackage(o.pkg))
    if (!origins.length) { toast(t('No sources seen yet — sync once first')); return }
    useUI.getState().openSheet(close => <>
      <h3>{t('Read from')}</h3>
      <p className="muted small" style={{ marginBottom: 10, lineHeight: 1.5 }}>
        {t('Your phone counts steps too. Picking one source stops the same walk being counted twice.')}
      </p>
      <div className="sect-b">
        {[{ pkg: null, label: t('All sources') }, ...origins.map(o => ({
          pkg: o.pkg,
          label: originLabel(o.pkg) || o.label,
        }))].map(o => (
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

  if (conn.state === 'off') {
    return (
      <Section title={t('Watch & health')}
        footer={t('Reads what your watch already saved on this phone. No account, no upload.')}>
        <div className="wcard">
          <WatchDevice state="off" size={92} />
          <div className="wcard-m">
            <span className="wcard-t">{t('Add a watch')}</span>
            <span className="wcard-s">{t('See heart rate, sleep and calories next to the workout that earned them.')}</span>
            <Button size="sm" variant="primary" icon="download" disabled={pulling} onClick={pull}>
              {pulling ? t('Pulling watch data… {0}%', pullPct) : t('Pull watch data')}
            </Button>
            <PullLog pulling={pulling} pct={pullPct} lines={pullLog} />
          </div>
        </div>
        <HealthConnectPermissionRow toast={toast} />
        <Row icon="watch" iconTint="var(--label-3)" title={t('Health Sync setup')}
          subtitle={t('Pair the watch, run Health Sync, then allow Gemak in Health Connect')}
          accessory="chevron" onClick={open} />
        <Row icon="info" iconTint="var(--label-3)" title={t('Connection check')}
          subtitle={t('What this phone reports, when linking won’t work')}
          accessory="chevron" onClick={() => openDiagnose(toast)} />
      </Section>
    )
  }

  if (conn.state === 'revoked') {
    return (
      <Section title={t('Watch & health')}
        footer={t('Access was withdrawn. Reconnect and nothing already logged is lost.')}>
        <div className="wcard">
          <WatchDevice state="revoked" size={92} />
          <div className="wcard-m">
            <span className="wcard-t">{t('Access expired')}</span>
            <span className="wcard-s">{t('Health Connect stopped sharing. Reconnect to pick up where you left off.')}</span>
            <Button size="sm" variant="primary" icon="download" disabled={pulling} onClick={pull}>
              {pulling ? t('Pulling watch data… {0}%', pullPct) : t('Pull watch data')}
            </Button>
          </div>
        </div>
        <PullLog pulling={pulling} pct={pullPct} lines={pullLog} />
        <HealthConnectPermissionRow toast={toast} />
        <Row icon="trash" iconTint="var(--red)" title={t('Unlink watch')} danger onClick={unlink} />
      </Section>
    )
  }

  const lastSync = conn.lastSyncAt ? fmtDate(isoOf(new Date(conn.lastSyncAt)), true) : null
  const today = health.days[isoOf(new Date())] || {}
  const trustedPkg = looksLikePackage(conn.trusted) ? conn.trusted : pickWatchOrigin(conn.origins)
  const readFrom = trustedPkg ? originLabel(trustedPkg) : t('All sources')

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
      <PullLog pulling={pulling} pct={pullPct} lines={pullLog} />

      <Row icon="footsteps" iconTint="var(--teal)" title={t('Today')}
        subtitle={today.steps != null
          ? t('{0} steps · {1} kcal active', Math.round(today.steps), Math.round(today.kcalActive || 0))
          : t('Nothing read for today yet')}
        value={syncing ? '…' : undefined}
        accessory={syncing ? 'none' : 'chevron'} onClick={syncing ? undefined : syncNow} />

      {!huawei && (
        <Row icon="shuffle" iconTint="var(--blue)" title={t('Read from')}
          value={readFrom}
          accessory="chevron" onClick={pickSource} />
      )}

      {!huawei && (
        <Row icon="history" iconTint={conn.history ? 'var(--green)' : 'var(--label-3)'}
          title={conn.history ? t('Full history allowed') : t('Last 30 days only')}
          subtitle={conn.history ? null : t('Health Connect → App access → Additional access → Access past data. Without that, only about 30 days come through.')}
          accessory="chevron" onClick={() => openHC(toast)} />
      )}

      <Row icon="download" iconTint="var(--blue)"
        title={pulling ? t('Pulling watch data… {0}%', pullPct) : t('Pull watch data')}
        subtitle={t('Reads everything Health Sync already saved — not just a week')}
        accessory={pulling ? 'none' : 'chevron'}
        onClick={pulling ? undefined : pull} />

      <Row icon="download" iconTint="var(--indigo)" title={t('Fill in earlier days')}
        subtitle={fill == null
          ? t(huawei ? 'Reads back through what Huawei Health still has' : 'Reads back through what Health Connect still has')
          : undefined}
        value={fill == null ? undefined : fill + '%'}
        accessory={fill == null ? 'chevron' : 'none'}
        onClick={fill == null ? backfill : undefined} />

      {huawei ? (
        <Row icon="gear" iconTint="var(--grey)"
          title={t('Open Huawei Health')}
          accessory="chevron" onClick={() => openHC(toast)} />
      ) : (
        <HealthConnectPermissionRow toast={toast} />
      )}
      <Row icon="trash" iconTint="var(--red)" title={t('Unlink watch')} danger onClick={unlink} />
    </Section>
  )
}
