import type { CSSProperties } from 'react'
import './logoLoader.css'

// The Cleo logo as a progress bar: the whole logo shows dimmed, and what has loaded lights up from the
// left with a faint glow behind it (a gradient bar in the editor's colours, cut to the logo's silhouette
// and blurred). Without `progress`, a band of light sweeps across instead. The layers are described in
// logoLoader.css.

export default function LogoLoader({ src, progress, className = '' }: {
  /** The logo's URL: each app serves its own from public/brand/ (tools/brandIcons.mjs). */
  src: string
  /** 0..1, or undefined for the indeterminate sweep. */
  progress?: number
  className?: string
}) {
  const style = { '--cleo-logo': `url("${src}")` } as Record<string, string>
  if (progress !== undefined) style['--cleo-progress'] = `${(Math.min(1, Math.max(0, progress)) * 100).toFixed(1)}%`
  return (
    <div className={`cleo-logo-loader${progress === undefined ? ' cleo-logo-sweep' : ''} ${className}`}
         style={style as CSSProperties} aria-hidden>
      <div className='cleo-logo-glow'><div className='cleo-logo-window'><i /></div></div>
      <img className='cleo-logo-dim' src={src} alt='' draggable={false} />
      <div className='cleo-logo-window'><img src={src} alt='' draggable={false} /></div>
    </div>
  )
}
