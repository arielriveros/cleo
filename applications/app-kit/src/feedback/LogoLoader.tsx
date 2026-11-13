import type { CSSProperties } from 'react'
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
