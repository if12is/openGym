import { useEffect, useState } from 'react'
import { imgCandidates, gifCandidates } from '../lib/exercises.js'
import { useStore } from '../store/useStore.js'
import { t, exName } from '../lib/i18n.js'
import Icon from './Icon.jsx'

function useFallbackSrc(list, resetKey) {
  const [i, setI] = useState(0)
  const [failed, setFailed] = useState(false)
  useEffect(() => { setI(0); setFailed(false) }, [resetKey])
  const src = !failed && list[i] ? list[i] : ''
  const onError = () => {
    if (i + 1 < list.length) setI(i + 1)
    else setFailed(true)
  }
  return { src, onError, failed }
}

// Big autoplaying animation; tap toggles to the still frame. `compact` shrinks it (superset cards).
// Custom exercises have no media — the animation stays blank by design (issue #11).
// `minimizable` (workout view) adds a persistent minimize/expand control so the animation stops
// eating the screen; the chosen size is saved to settings and carries across exercises and
// future workouts (issue #12).
export default function Media({ ex, id, compact, minimizable }) {
  const [playing, setPlaying] = useState(true)
  const gifSize = useStore(s => s.S.gifSize)
  const update = useStore(s => s.update)
  const list = playing ? gifCandidates(ex) : imgCandidates(ex)
  const { src, onError, failed } = useFallbackSrc(list, `${ex?.id}|${playing}|${ex?.gif}|${ex?.img}`)
  if (!ex.gif) return null
  const mini = minimizable && gifSize === 'mini'
  const toggleSize = e => { e.stopPropagation(); update(s => { s.gifSize = mini ? 'full' : 'mini' }) }
  return (
    <div className={'exmedia' + (compact ? ' compact' : '') + (mini ? ' mini' : '') + (failed ? ' broken' : '')} id={id} onClick={() => !failed && setPlaying(p => !p)}>
      {failed ? (
        <div className="media-fallback">
          <Icon name="dumbbell" />
          <span>{t('Animation unavailable')}</span>
        </div>
      ) : (
        <img decoding="async" src={src} alt={exName(ex)} onError={onError} />
      )}
      {minimizable && (
        <button className="giftoggle" onClick={toggleSize}>
          <Icon name={mini ? 'expand' : 'minimize'} />{mini ? t('Expand') : t('Minimize')}
        </button>
      )}
      {!mini && !failed && (
        <span className="gifhint">
          <Icon name={playing ? 'pause' : 'play'} />{playing ? t('tap to pause') : t('tap to play')}
        </span>
      )}
    </div>
  )
}

export function Thumb({ ex }) {
  const list = imgCandidates(ex)
  const { src, onError, failed } = useFallbackSrc(list, `${ex?.id}|${ex?.img}`)
  if (!ex.img || failed) return <div className="thumb thumb-x"><Icon name="dumbbell" /></div>
  return <img className="thumb" loading="lazy" decoding="async" src={src} alt="" onError={onError} />
}
