import { useNavigate } from 'react-router-dom'
import { MOBILE } from '../lib/mobile.js'
import { t } from '../lib/i18n.js'
import { useAppUpdate, startUpdateDownload, installPendingUpdate } from '../lib/app-update.js'
import { useUI } from '../store/useUI.js'
import Icon from './Icon.jsx'

export default function UpdateBanner() {
  const nav = useNavigate()
  const toast = useUI(s => s.toast)
  const s = useAppUpdate()
  if (!MOBILE) return null
  if (s.phase !== 'available' && s.phase !== 'downloading' && s.phase !== 'ready') return null

  const ver = s.remote?.versionName || s.pending?.versionName || ''
  const pct = Math.round((s.progress || 0) * 100)

  const onClick = async () => {
    if (s.phase === 'ready') {
      try {
        await installPendingUpdate()
        toast(t('Follow the system prompts to finish installing'))
      } catch (e) {
        toast(t('Could not start install: {0}', e.message || ''))
      }
      return
    }
    if (s.phase === 'available') {
      try { await startUpdateDownload() }
      catch (e) { toast(t('Update download failed: {0}', e.message || '')) }
      return
    }
    nav('/settings')
  }

  const title = s.phase === 'ready'
    ? t('Ready to install {0}', ver)
    : s.phase === 'downloading'
      ? t('Downloading update… {0}%', pct)
      : t('Update {0} is available', ver)
  const action = s.phase === 'ready' ? t('Install') : s.phase === 'downloading' ? t('Details') : t('Download')

  return (
    <button className="upd-banner" onClick={onClick}>
      <span className="lrow-i" style={{ '--tint': s.phase === 'ready' ? 'var(--green)' : 'var(--acc)' }}>
        <Icon name={s.phase === 'ready' ? 'checkCircle' : 'rocket'} />
      </span>
      <span className="upd-banner-m">
        <span className="upd-banner-t">{title}</span>
        {s.phase === 'downloading' && (
          <span className="upd-banner-bar"><span style={{ width: pct + '%' }} /></span>
        )}
      </span>
      <span className="upd-banner-a">{action}</span>
    </button>
  )
}
