import { useState } from 'react';
import { LogoMark, useCoarsePixels } from '../feedback/LogoLoader';
import { cn } from './cn';

/**
 * The Cleo logo at the left end of a menu bar, as a button: the editor's opens the projects, the Creator's
 * goes home. Pointing at it runs the splash screen's pixel scan across the logo once (LogoMark); it does
 * not restart mid-pass.
 */
export function LogoButton({ src, title, onClick, className }: {
  /** The app's logo (public/brand/logo.png). */
  src: string;
  title: string;
  onClick: () => void;
  className?: string;
}) {
  const pixels = useCoarsePixels(src, 8);
  const [scanning, setScanning] = useState(false);
  return (
    <button
      type='button'
      title={title}
      aria-label={title}
      onClick={onClick}
      onMouseEnter={() => setScanning(true)}
      className={cn('flex h-[25px] w-[32px] shrink-0 items-center justify-center rounded outline-none hover:bg-control/50 focus-visible:bg-control/50', className)}
    >
      <LogoMark src={src} pixels={pixels} scanning={scanning} onScanEnd={() => setScanning(false)} className='w-[22px]' />
    </button>
  );
}

export default LogoButton;
