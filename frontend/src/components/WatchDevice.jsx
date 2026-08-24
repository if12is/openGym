// The watch, drawn as itself.
//
// A settings row that just says "not connected" gives the user nothing to aim
// at — pairing fails most often because people are not sure which device or
// which app the screen even means. Showing the actual hardware answers that
// before the first tap, and gives the two states something to differ *in*:
// dormant reads as grey and flat, linked reads as lit and breathing.
//
// The artwork is a product photo with a transparent cutout, so it sits on the
// app's own background in both themes without a plate behind it. Everything
// around it — ring, glow, pip — is drawn from theme tokens, so the only thing
// that does not follow the accent is the device itself, which is the point.
//
// Presentational only: it takes a state and renders it. Whether the phone is
// actually linked is lib/watch-link.js's business.

import watchImg from '../assets/watch-fit4.png'
import Icon from './Icon.jsx'
import { t } from '../lib/i18n.js'

// state: 'off' | 'linking' | 'ok' | 'revoked'
export default function WatchDevice({ state = 'off', size = 116, bpm = null, className = '' }) {
  const live = state === 'ok'
  return (
    <div className={'wdev wdev-' + state + ' ' + className} style={{ '--wdev-w': size + 'px' }}>
      <span className="wdev-halo" aria-hidden="true" />
      <span className="wdev-ring" aria-hidden="true" />
      <img
        className="wdev-img"
        src={watchImg}
        alt={t('Huawei Watch Fit 4')}
        width="506"
        height="892"
        draggable="false"
      />
      {live && bpm != null && (
        <span className="wdev-bpm">
          <Icon name="heart" />
          <b>{bpm}</b>
        </span>
      )}
      <span className={'wdev-pip' + (live ? ' on' : '')} aria-hidden="true" />
    </div>
  )
}
