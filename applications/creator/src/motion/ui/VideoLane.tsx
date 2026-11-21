import { useMemo } from 'react';
import type { MotionReference } from '../reference/referenceDoc';
import { referenceSpan, videoTimeOf } from '../reference/referenceDoc';
import type { AudioPeaks } from '../reference/referenceCache';
import type { VideoAssetDoc } from '../reference/videoDoc';

// The Timeline's Video lane: the reference clip laid along the motion's time -- a strip of its frames and,
// under them, its sound's loudness (footsteps and impacts show as spikes, which is often the quickest way to
// time a contact). Drag the strip to slide the clip along the motion (its offset); drag either end to trim
// it (the in and out points). Times follow the clip's speed, so a slow-motion clip lies stretched out.

export const VIDEO_LANE_H = 46;
const EDGE = 6;

export interface VideoLaneProps {
  reference: MotionReference;
  video: VideoAssetDoc;
  thumbs: { strip: { times: number[] }; urls: string[] } | null;
  peaks: AudioPeaks | null;
  /** Timeline seconds to content x. */
  x: (t: number) => number;
  pxPerSec: number;
  width: number;
  /** A change made by a drag (applied at once; the motion re-publishes after a quiet spell). */
  onChange: (next: MotionReference) => void;
}

export function VideoLane({ reference, video, thumbs, peaks, x, pxPerSec, width, onChange }: VideoLaneProps) {
  const span = referenceSpan(reference);
  const x0 = x(span.start), x1 = x(span.end);
  const tileH = VIDEO_LANE_H - 14;
  const tileW = Math.max(8, tileH * (video.width / Math.max(1, video.height)));

  // The strip, tile after tile with no gaps: each tile the thumbnail nearest the time at its middle.
  const tiles = useMemo(() => {
    const times = thumbs?.strip.times;
    if (!thumbs || !times?.length || x1 - x0 < 1) return [];
    const out: { left: number; url: string }[] = [];
    let j = 0;
    for (let left = x0; left < x1; left += tileW) {
      const v = videoTimeOf(reference, span.start + (left + tileW / 2 - x0) / pxPerSec);
      while (j + 1 < times.length && Math.abs(times[j + 1] - v) <= Math.abs(times[j] - v)) j++;
      out.push({ left, url: thumbs.urls[j] });
      if (out.length > 2000) break;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thumbs, x0, x1, reference.offset, reference.speed, pxPerSec, tileW]);

  // The sound, a column per pixel: the loudest bucket under it.
  const wave = useMemo(() => {
    if (!peaks || x1 - x0 < 2) return '';
    const h = 12, base = VIDEO_LANE_H - 1;
    let d = '';
    for (let px = Math.max(0, Math.floor(x0)); px <= Math.min(width, Math.ceil(x1)); px++) {
      const t0 = (px - x0) / pxPerSec + span.start, t1 = t0 + 1 / pxPerSec;
      const b0 = Math.floor((videoTimeOf(reference, t0) - peaks.start) * peaks.perSecond);
      const b1 = Math.max(b0 + 1, Math.ceil((videoTimeOf(reference, t1) - peaks.start) * peaks.perSecond));
      let m = 0;
      for (let b = Math.max(0, b0); b < Math.min(peaks.peaks.length, b1); b++) m = Math.max(m, peaks.peaks[b]);
      if (m > 0.01) d += `M${px} ${base}v${-Math.max(1, Math.min(1, m) * h).toFixed(1)}`;
    }
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peaks, x0, x1, pxPerSec, width, reference.in, reference.out, reference.offset, reference.speed]);

  const drag = (e: React.PointerEvent, what: 'slip' | 'in' | 'out') => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX, from = { ...reference };
    const move = (ev: PointerEvent) => {
      const dt = (ev.clientX - startX) / pxPerSec;           // timeline seconds
      const dv = dt * from.speed;                             // video seconds
      const lo = video.start, hi = video.start + video.duration;
      if (what === 'slip') onChange({ ...from, offset: from.offset - dv });
      else if (what === 'in') onChange({ ...from, in: Math.min(from.out - 0.05, Math.max(lo, from.in + dv)) });
      else onChange({ ...from, out: Math.max(from.in + 0.05, Math.min(hi, from.out + dv)) });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className='absolute inset-x-0' style={{ height: VIDEO_LANE_H }}>
      <div className='absolute top-1 cursor-grab overflow-hidden rounded border border-highlight/60 bg-black/40'
           style={{ left: x0, width: Math.max(2, x1 - x0), height: VIDEO_LANE_H - 2 }}
           onPointerDown={e => drag(e, 'slip')}
           title={`The reference: drag to slide it along the motion, drag an end to trim it${reference.speed !== 1 ? ` · ${+reference.speed.toFixed(3)}× (filmed faster than it plays)` : ''}`}>
        {tiles.map(t => (
          <img key={t.left} src={t.url} alt='' draggable={false} className='pointer-events-none absolute top-0 object-cover'
               style={{ left: t.left - x0, width: tileW, height: tileH }} />
        ))}
        <div className='pointer-events-none absolute inset-x-0 bottom-0 h-[13px] bg-black/50' />
        <div className='absolute inset-y-0 left-0 cursor-ew-resize bg-highlight/40 hover:bg-highlight/70' style={{ width: EDGE }}
             onPointerDown={e => drag(e, 'in')} title='Trim the start (the in point)' />
        <div className='absolute inset-y-0 right-0 cursor-ew-resize bg-highlight/40 hover:bg-highlight/70' style={{ width: EDGE }}
             onPointerDown={e => drag(e, 'out')} title='Trim the end (the out point)' />
      </div>
      {wave && (
        <svg className='pointer-events-none absolute left-0 top-0' width={width} height={VIDEO_LANE_H}>
          <path d={wave} className='stroke-current text-highlight' strokeWidth={1} fill='none' />
        </svg>
      )}
    </div>
  );
}
