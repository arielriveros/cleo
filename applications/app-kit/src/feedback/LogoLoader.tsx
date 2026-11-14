import { useEffect, useState, type CSSProperties } from 'react'
import './logoLoader.css'

// The Cleo logo as a progress bar: the whole logo shows dimmed and pixelated, and what has loaded turns
// sharp and lights up from the left, with a faint glow behind it (a gradient bar in the editor's colours,
// cut to the logo's silhouette and blurred). Without `progress`, a pixelated band of light sweeps across
// the dimmed logo instead. The layers are described in logoLoader.css.

export default function LogoLoader({ src, pixels = src, progress, className = '' }: {
  /** The logo's URL: each app serves its own from public/brand/ (tools/brandIcons.mjs). */
  src: string
  /** The same logo a few dozen pixels across (brand/logo-pixel.png), drawn pixelated. Without it, nothing is. */
  pixels?: string
  /** 0..1, or undefined for the indeterminate sweep. */
  progress?: number
  className?: string
}) {
  const sweep = progress === undefined
  const style = { '--cleo-logo': `url("${src}")` } as Record<string, string>
  if (!sweep) style['--cleo-progress'] = `${(Math.min(1, Math.max(0, progress)) * 100).toFixed(1)}%`
  // Nearest-neighbour scaling only for the small copy: on the full logo it would just alias the downscale.
  const sharp = <img src={src} alt='' draggable={false} />
  const blocky = <img className={pixels !== src ? 'cleo-logo-px' : undefined} src={pixels} alt='' draggable={false} />
  return (
    <div className={`cleo-logo-loader${sweep ? ' cleo-logo-sweep' : ''} ${className}`}
         style={style as CSSProperties} aria-hidden>
      <div className='cleo-logo-glow'><div className='cleo-logo-window'><i /></div></div>
      <img className='cleo-logo-size' src={src} alt='' draggable={false} />
      {/* The progress bar leaves the pixels to what is still loading; the sweep's band of light is them. */}
      <div className='cleo-logo-rest'>{sweep ? sharp : blocky}</div>
      <div className='cleo-logo-window'>{sweep ? blocky : sharp}</div>
    </div>
  )
}

/**
 * The Cleo logo as a mark (a menu bar's logo button): the sharp logo, at full brightness. Each time
 * `scanning` turns on, the splash screen's pixelated band of light crosses it once -- the same layers and
 * the same sweep as LogoLoader's indeterminate mode, run a single time -- and `onScanEnd` reports the pass
 * done. `pixels` is a coarse copy of the logo (useCoarsePixels): the splash's 30-column one has less
 * than a pixel per block at button size.
 */
export function LogoMark({ src, pixels = src, scanning, onScanEnd, className = '' }: {
  src: string
  pixels?: string
  scanning: boolean
  onScanEnd?: () => void
  className?: string
}) {
  const style = { '--cleo-logo': `url("${src}")` } as Record<string, string>
  return (
    <div className={`cleo-logo-loader cleo-logo-sweep cleo-logo-mark${scanning ? ' cleo-logo-scanning' : ''} ${className}`}
         style={style as CSSProperties} aria-hidden
         onAnimationEnd={e => { if (e.animationName === 'cleo-logo-sweep') onScanEnd?.() }}>
      <div className='cleo-logo-glow'><div className='cleo-logo-window'><i /></div></div>
      <img className='cleo-logo-size' src={src} alt='' draggable={false} />
      <div className='cleo-logo-rest'><img src={src} alt='' draggable={false} /></div>
      <div className='cleo-logo-window'><img className='cleo-logo-px' src={pixels} alt='' draggable={false} /></div>
    </div>
  )
}

const coarseCache = new Map<string, Promise<string>>()

/** `src` drawn `columns` pixels across (halving down to it, so each pixel averages what it covers). */
function coarsen(src: string, columns: number): Promise<string> {
  const key = `${columns}|${src}`
  let promise = coarseCache.get(key)
  if (!promise) {
    promise = new Promise<string>((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        let source: CanvasImageSource = img
        let w = img.naturalWidth, h = img.naturalHeight
        while (w / 2 >= columns * 2) {
          const half = document.createElement('canvas')
          half.width = Math.round(w / 2); half.height = Math.round(h / 2)
          half.getContext('2d')!.drawImage(source, 0, 0, half.width, half.height)
          source = half; w = half.width; h = half.height
        }
        const out = document.createElement('canvas')
        out.width = columns
        out.height = Math.max(1, Math.round(columns * img.naturalHeight / img.naturalWidth))
        out.getContext('2d')!.drawImage(source, 0, 0, out.width, out.height)
        resolve(out.toDataURL('image/png'))
      }
      img.onerror = () => reject(new Error(`Could not load ${src}`))
      img.src = src
    })
    coarseCache.set(key, promise)
  }
  return promise
}

/**
 * A copy of the logo at `src` a few pixels across, for LogoMark's band: drawn pixelated over a small
 * logo, it reads as the splash's blocks do over a large one. The logo itself until the copy is ready.
 */
export function useCoarsePixels(src: string, columns = 8): string {
  const [url, setUrl] = useState(src)
  useEffect(() => {
    let live = true
    coarsen(src, columns).then(u => { if (live) setUrl(u) }, () => { /* the sharp logo stands in */ })
    return () => { live = false }
  }, [src, columns])
  return url
}
