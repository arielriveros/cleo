// A video reference in the Creator library (kind 'video'): what the asset's document says about the clip.
//
// The file itself is the asset's one private file, written once at import and never again: a re-publish
// without it would delete it (app-kit creatorLibrary/store.ts), so nothing attaches the publishing hook to
// this kind. Caches made later (thumbnails, analysis, tracks) are added beside it with `putCreatorFile`.
// The document stays small -- the listing reloads every document on every library message -- so the
// frame timestamps are not kept here: they are read again when the clip is opened (a metadata-only scan).

/** Rates a camera or an export writes, the NTSC ones exact (n·1000/1001). */
export const STANDARD_RATES: readonly number[] = [
  12, 15, 24000 / 1001, 24, 25, 30000 / 1001, 30, 48, 50, 60000 / 1001, 60, 90, 100, 120000 / 1001, 120, 240,
];

export interface VideoAssetDoc {
  version: 1;
  /** The private file holding the video. */
  fileName: string;
  mime: string;
  sizeBytes: number;
  /** Displayed size (after the container's rotation), pixels. */
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  /** Seconds, from the first frame's timestamp (`start`) to the end of the last. */
  duration: number;
  start: number;
  codec: string | null;
  /** The container's average frame rate, snapped to a standard rate when within 0.5%. */
  fps: number;
  frameCount: number;
  /** The frames are not evenly spaced (a phone's variable frame rate): placed by their own timestamps. */
  vfr: boolean;
  hasAudio: boolean;
}

/** A measured rate on the standard rate it is within 0.5% of, else itself (3 decimals). */
export function snapFrameRate(measured: number): number {
  if (!(measured > 0) || !Number.isFinite(measured)) return 30;
  let best = measured, err = 0.005;
  for (const r of STANDARD_RATES) {
    const e = Math.abs(measured - r) / r;
    if (e < err) { err = e; best = r; }
  }
  return best === measured ? Math.round(measured * 1000) / 1000 : best;
}

/** "29.97", "24", "23.976": a rate as it is usually written. */
export function rateLabel(fps: number): string {
  return String(+fps.toFixed(3));
}

/**
 * Whether presentation timestamps (seconds, ascending) are unevenly spaced: more than 2% of the frame
 * steps more than 25% off the median step. A single long step (a dropped frame) does not count.
 */
export function isVariableRate(timestamps: ArrayLike<number>): boolean {
  const n = timestamps.length;
  if (n < 4) return false;
  const steps: number[] = [];
  for (let i = 1; i < n; i++) steps.push(timestamps[i] - timestamps[i - 1]);
  const median = [...steps].sort((a, b) => a - b)[steps.length >> 1];
  if (!(median > 0)) return false;
  const off = steps.filter(s => Math.abs(s - median) > median * 0.25).length;
  return off > Math.max(1, steps.length * 0.02);
}

const finite = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** A stored document made safe. Null when it is not a video's. */
export function normaliseVideoDoc(raw: unknown): VideoAssetDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Partial<VideoAssetDoc>;
  if (typeof d.fileName !== 'string' || !d.fileName) return null;
  const rot = finite(d.rotation, 0);
  return {
    version: 1,
    fileName: d.fileName,
    mime: typeof d.mime === 'string' ? d.mime : 'video/mp4',
    sizeBytes: Math.max(0, finite(d.sizeBytes, 0)),
    width: Math.max(1, Math.round(finite(d.width, 1920))),
    height: Math.max(1, Math.round(finite(d.height, 1080))),
    rotation: (rot === 90 || rot === 180 || rot === 270 ? rot : 0),
    duration: Math.max(0, finite(d.duration, 0)),
    start: finite(d.start, 0),
    codec: typeof d.codec === 'string' ? d.codec : null,
    fps: Math.min(1000, Math.max(1, finite(d.fps, 30))),
    frameCount: Math.max(0, Math.round(finite(d.frameCount, 0))),
    vfr: !!d.vfr,
    hasAudio: !!d.hasAudio,
  };
}
