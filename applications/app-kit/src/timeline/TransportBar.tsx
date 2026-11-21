import React, { useEffect, useRef } from 'react';
import { Button } from '../ui/Button';
import { MenuItem } from '../ui/MenuItem';
import { Popover } from '../ui/Popover';
import { cn } from '../ui/cn';
import { LoopIcon, PauseIcon, PlayIcon, StepBackIcon, StepForwardIcon, StopIcon, ToEndIcon, ToStartIcon } from '../ui/icons';
import { formatTimecode } from './timelineMath';

export interface TransportBarProps {
  playing: boolean;
  onToggle: () => void;
  onToStart: () => void;
  onToEnd: () => void;
  /** Step by whole frames (negative: back). */
  onStep: (frames: number) => void;
  /** A Stop button (to the start, and stop playing); absent: none. */
  onStop?: () => void;
  /** The loop switch; absent `onLoop`: no switch. */
  loop?: boolean;
  onLoop?: (on: boolean) => void;
  /** Playback speed and its menu; absent `onRate`: no menu. */
  rate?: number;
  rates?: readonly number[];
  onRate?: (rate: number) => void;
  /** The readout: the time now (or a clock read every frame, so the bar need not re-render), the length. */
  time?: number;
  clock?: () => number;
  duration: number;
  fps: number;
  /**
   * A second readout after the timecode, e.g. a video's own frame number, read with the time (same
   * frame as the clock).
   */
  extra?: (time: number) => string;
  extraTitle?: string;
  /** Keyboard hints in the tooltips, where the panel binds the keys. */
  keys?: Partial<Record<'toggle' | 'toStart' | 'toEnd' | 'back' | 'forward', string>>;
  children?: React.ReactNode;
  className?: string;
}

export const TRANSPORT_RATES: readonly number[] = [0.1, 0.25, 0.5, 1, 1.5, 2];

const hint = (title: string, key?: string) => (key ? `${title} (${key})` : title);
const rateLabel = (r: number) => `${+r.toFixed(2)}×`;

/**
 * A timeline's transport: to the start, back a frame, play or pause, forward a frame, to the end, an
 * optional stop and loop, a speed menu, and the timecode (mm:ss.ff at `fps`) over the length. Display
 * only -- it owns no clock: every button calls back, and the readout shows `time` or reads `clock` each
 * animation frame (the playhead's way: no re-render while playing). Shared by the editor's Sequencer and
 * the Creator's Motion timeline.
 */
export function TransportBar({
  playing, onToggle, onToStart, onToEnd, onStep, onStop, loop, onLoop, rate = 1, rates = TRANSPORT_RATES, onRate,
  time = 0, clock, duration, fps, extra, extraTitle, keys = {}, children, className,
}: TransportBarProps) {
  const readout = useRef<HTMLSpanElement>(null);
  const extraRef = useRef<HTMLSpanElement>(null);
  const text = (t: number) => `${formatTimecode(t, fps)} / ${formatTimecode(duration, fps)}`;
  useEffect(() => {
    if (!clock) return;
    let raf = 0;
    const tick = () => {
      const t = clock();
      if (readout.current) readout.current.textContent = text(t);
      if (extraRef.current && extra) extraRef.current.textContent = extra(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });
  const button = (title: string, icon: React.ReactNode, onClick: () => void, on?: boolean) => (
    <Button size='icon' variant='ghost' active={on} title={title} onClick={onClick}><span className='block h-3.5 w-3.5'>{icon}</span></Button>
  );
  const shown = clock ? clock() : time;
  return (
    <div className={cn('flex items-center gap-1', className)}>
      {button(hint('To the start', keys.toStart), <ToStartIcon />, onToStart)}
      {button(hint('Back one frame', keys.back), <StepBackIcon />, () => onStep(-1))}
      {button(hint(playing ? 'Pause' : 'Play', keys.toggle), playing ? <PauseIcon /> : <PlayIcon />, onToggle)}
      {button(hint('Forward one frame', keys.forward), <StepForwardIcon />, () => onStep(1))}
      {button(hint('To the end', keys.toEnd), <ToEndIcon />, onToEnd)}
      {onStop && button('To the start, and stop playing', <StopIcon />, onStop)}
      {onLoop && button(loop ? 'Looping: playback wraps at the end' : 'Loop the playback', <LoopIcon />, () => onLoop(!loop), loop)}
      {onRate && (
        <Popover trigger={<span className='text-ui-xs tabular-nums'>{rateLabel(rate)}</span>} title='Playback speed' triggerClassName='px-1'>
          {close => (
            <div className='w-[96px]'>
              {rates.map(r => <MenuItem key={r} active={Math.abs(r - rate) < 1e-6} onClick={() => { close(); onRate(r); }}>{rateLabel(r)}</MenuItem>)}
            </div>
          )}
        </Popover>
      )}
      <span ref={readout} className='ml-1 min-w-[132px] text-ui-xs tabular-nums text-muted' title={`Minutes:seconds.frame at ${+fps.toFixed(3)} fps`}>{text(shown)}</span>
      {extra && <span ref={extraRef} className='text-ui-xs tabular-nums text-dim' title={extraTitle}>{extra(shown)}</span>}
      {children}
    </div>
  );
}
