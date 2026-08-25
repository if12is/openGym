// Settings → Watch & health.
//
// Two actions, kept apart because Honor/Huawei hang if they are combined:
//   · Allow from Health Connect — opens Health Connect so the user can turn
//     Gemak on there (the in-app picker never appears on those phones)
//   · Pull watch data — only reads. No permission sheet.

import { useEffect, useState } from 'react'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { fmtDate, isoOf } from '../lib/format.js'
import {
  getConn, subscribeHealth, refreshLinkState, disconnectWatch,
  openHealthConnectPermissions, installHealthConnect,
  updateConn, getHealth, diagnoseHealth, checkAvailability, pullWatchData,
} from '../lib/health-store.js'
import { listOrigins } from '../lib/health-connect.js'
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
  ['Allow Gemak in Health Connect', 'Honor and Huawei almost never show a permission popup. Use Allow from Health Connect in Settings, turn Gemak on there, then pull the data.'],
]

function DiagnoseSheet({ toast }) {
  const [d, setD] = useState(null)

  useEffect(() => { diagnoseHealth().then(setD) }, [])

  const huawei = d && !d.error && d.provider === 'huawei'
  const rows = d && !d.error ? [
    [t('Phone'), `${d.device} · Android SDK ${d.sdkInt}`],
    [t('Health source'), huawei ? t('Huawei Health Kit') : t('Health Connect')],
    huawei
      ? [t('HMS Core'), d.hmsAvailable ? t('Works') : t('Missing')]
      : [t('Health Connect'), `${d.sdkStatusText} (${d.sdkStatus})`],
    huawei
      ? [t('Huawei Health installed'), d.huaweiHealthInstalled ? t('Yes') : t('No')]
      : [t('Provider app installed'), d.providerInstalled ? t('Yes') : t('No — built into Android')],
    huawei ? [t('App ID in this build'), d.appIdConfigured ? t('Yes') : t('No')] : null,
    huawei
      ? [t('Huawei Health authorised'), d.healthAuthorized ? t('Yes') : t('No')]
      : [t('Health permissions in this build'), String(d.declaredHealthPermissions)],
    [t('Permission screen'), d.pickerAction],
    [t('Resolves to an app'), d.pickerResolves ? t('Yes') : t('No — handled inside Android')],
    [t('Data connection'), d.clientBinds ? t('Works') : t('Timed out')],
    [t('Allowed right now'), d.grantedCount < 0 ? t('Could not read') : String(d.grantedCount)],
    [t('Allowed types'), (d.granted || []).join(', ') || '—'],
  ].filter(Boolean) : []

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

const openHC = async toast => {
  if (!(await openHealthConnectPermissions())) {
    toast(t('Couldn’t open Health Connect. Open Android Settings → Security & privacy → Health Connect.'))
  }
}

function HealthConnectPermissionRow({ toast }) {
  return (
    <Row
      icon="shield"
      iconTint="var(--blue)"
      title={t('Allow from Health Connect')}
      subtitle={t('Opens Health Connect so you can turn Gemak on. This is the reliable way on Honor and Huawei.')}
      accessory="chevron"
      onClick={async () => {
        if (await openHealthConnectPermissions()) {
          toast(t('Turn Gemak on in Health Connect, then pull the data'))
        } else {
          toast(t('Couldn’t open Health Connect. Open Android Settings → Security & privacy → Health Connect.'))
        }
      }}
    />
  )
}

function SetupSheet({ close, toast }) {
  const [busy, setBusy] = useState(false)
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
    setProblem(null)
    try {
      const res = await pullWatchData(2)
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
    <Button variant="plain" icon="shield" onClick={() => openHC(toast)}>
      {t('Allow from Health Connect')}
    </Button>
    <div style={{ height: 8 }} />
    <Button variant="primary" icon="download" disabled={busy} onClick={go}>
      {busy ? t('Pulling watch data…') : t('Pull watch data')}
    </Button>
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
    const m = await import('../lib/health-sync.js')
    return await m.syncRecentDays(days)
  } catch (e) { return 0 }
}

async function rememberOrigins() {
  const end = Date.now()
  const r = await listOrigins(end - 7 * 86400000, end)
  if (r.ok && r.origins.length) updateConn(c => { c.origins = r.origins })
}

export default function WatchCard({ toast }) {
  const [conn, setConn] = useState(getConn())
  const [syncing, setSyncing] = useState(false)
  const [fill, setFill] = useState(null)
  const [pulling, setPulling] = useState(false)
  const huawei = conn.provider === 'huawei'

  useEffect(() => {
    const off = subscribeHealth(() => setConn({ ...getConn() }))
    refreshLinkState()
    return off
  }, [])

  const open = () => useUI.getState().openSheet(close => <SetupSheet close={close} toast={toast} />)

  const pull = async () => {
    setPulling(true)
    try {
      const res = await pullWatchData(2)
      if (res.ok) {
        toast(res.days ? t('Synced') : t('Nothing new yet — Health Sync may still be catching up'))
        rememberOrigins()
        return
      }
      if (res.reason === 'need-permission' || res.reason === 'denied') {
        toast(t('Allow Gemak from Health Connect first, then pull.'))
      } else if (res.reason === 'no-bind' || res.reason === 'timeout' || res.reason === 'no-plugin') {
        toast(t('Allow Gemak from Health Connect first, then pull.'))
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
    toast(n ? t('Synced') : (huawei
      ? t('Nothing new yet — Huawei Health may still be catching up')
      : t('Nothing new yet — Health Sync may still be catching up')))
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
              {pulling ? t('Pulling watch data…') : t('Pull watch data')}
            </Button>
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
              {pulling ? t('Pulling watch data…') : t('Pull watch data')}
            </Button>
          </div>
        </div>
        <HealthConnectPermissionRow toast={toast} />
        <Row icon="trash" iconTint="var(--red)" title={t('Unlink watch')} danger onClick={unlink} />
      </Section>
    )
  }

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

      {!huawei && (
        <Row icon="shuffle" iconTint="var(--blue)" title={t('Read from')}
          value={trusted ? trusted.label : t('All sources')}
          accessory="chevron" onClick={pickSource} />
      )}

      {!huawei && (
        <Row icon="history" iconTint={conn.history ? 'var(--green)' : 'var(--label-3)'}
          title={conn.history ? t('Full history allowed') : t('Last 30 days only')}
          subtitle={conn.history ? null : t('Health Connect caps older data unless you allow history.')}
          accessory="chevron" onClick={() => openHC(toast)} />
      )}

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
