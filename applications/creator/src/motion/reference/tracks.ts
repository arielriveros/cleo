// Reference ▸ Tracking's data: points followed through the clip, kept with the clip (tracks.json, beside the
// video in the library: a clip's tracks belong to it, whichever motion uses it), and what they are used for.
//
//   seeds      where the animator put the point, on some frames (a first click, then corrections)
//   points     where the tracker followed it on every frame (unit square, NaN where it was lost)
//   contacts   a foot's still stretches: planted on the ground
//   turns      where a hand or the head reverses: an extreme worth a key
//
// Plant feet: in a key inside a foot's contact, the foot's IK goal goes over where the tracked point meets the
// ground -- its ray through the reference camera, down to the floor (the point on the sole is on the floor),
// raised to the height the foot's joint stands at.

import { frameIndexAt, videoTimeOf, type MotionReference } from './referenceDoc';
import { cameraBasis, pixelRay, type ReferenceCamera, type Vec3 } from './referenceCamera';
import { contacts, turns } from './cv/trajectory';
import type { TrackSeed } from './cv/trackJob';
import { newId, type Limb, type MotionDoc, type MotionPose } from '../motionDoc';

export const TRACKS_FILE = 'tracks.json';

export type TrackRole = 'footL' | 'footR' | 'handL' | 'handR' | 'head' | 'other';
export const TRACK_ROLES: { id: TrackRole; label: string; color: string }[] = [
  { id: 'footL', label: 'Left foot', color: '#4fc3f7' },
  { id: 'footR', label: 'Right foot', color: '#f06292' },
  { id: 'handL', label: 'Left hand', color: '#81c784' },
  { id: 'handR', label: 'Right hand', color: '#ffb74d' },
  { id: 'head', label: 'Head', color: '#e6e6e6' },
  { id: 'other', label: 'Other', color: '#b39ddb' },
];
export const roleOf = (id: TrackRole) => TRACK_ROLES.find(r => r.id === id) ?? TRACK_ROLES[5];

export interface TrackDoc { id: string; role: TrackRole; seeds: TrackSeed[]; }

export interface TracksState {
  tracks: TrackDoc[];
  /** The tracker's last result: per track, x, y per frame (unit square; NaN lost), and the frames' times. */
  result: { times: number[]; points: Record<string, number[]>; error: Record<string, number[]> } | null;
}

export const EMPTY_TRACKS: TracksState = { tracks: [], result: null };

const ROLES = new Set(TRACK_ROLES.map(r => r.id));
/** A stored tracks file made safe. */
export function normaliseTracks(raw: unknown): TracksState {
  if (!raw || typeof raw !== 'object') return EMPTY_TRACKS;
  const r = raw as Partial<TracksState>;
  const tracks = (Array.isArray(r.tracks) ? r.tracks : []).flatMap(t => {
    if (!t || typeof t.id !== 'string') return [];
    const seeds = (Array.isArray(t.seeds) ? t.seeds : []).filter(s => s && [s.frame, s.x, s.y].every(Number.isFinite));
    return [{ id: t.id, role: ROLES.has(t.role) ? t.role : 'other', seeds }];
  });
  const res = r.result;
  const result = res && Array.isArray(res.times) && res.points && typeof res.points === 'object' ? {
    times: res.times.map(Number),
    points: Object.fromEntries(Object.entries(res.points).map(([k, v]) => [k, (v as unknown[]).map(x => (typeof x === 'number' ? x : NaN))])),
    error: Object.fromEntries(Object.entries(res.error ?? {}).map(([k, v]) => [k, (v as unknown[]).map(x => (typeof x === 'number' ? x : NaN))])),
  } : null;
  return { tracks, result };
}

/** As a file (NaN written as null, read back as NaN). */
export const tracksBlob = (t: TracksState) => new Blob([JSON.stringify(t)], { type: 'application/json' });

/** A new track at a frame. */
export const newTrack = (role: TrackRole, frame: number, x: number, y: number): TrackDoc => ({ id: newId(), role, seeds: [{ frame, x, y }] });

/** A seed set (added, or moved when the track already has one on that frame). */
export function withSeed(t: TrackDoc, frame: number, x: number, y: number): TrackDoc {
  return { ...t, seeds: [...t.seeds.filter(s => s.frame !== frame), { frame, x, y }].sort((a, b) => a.frame - b.frame) };
}

/** Thresholds for a clip at `fps`: a foot still within ~0.35% of the frame per frame for a tenth of a second. */
export const contactParams = (fps: number) => ({ maxSpeed: 0.0035 * (30 / Math.max(1, fps)), minFrames: Math.max(2, Math.round(fps * 0.1)) });

/** A foot track's contacts, as frame spans. */
export function footContacts(points: ArrayLike<number>, fps: number): [number, number][] {
  const { maxSpeed, minFrames } = contactParams(fps);
  return contacts(points, maxSpeed, minFrames);
}

/** A hand's or the head's turns: frames where it reverses. */
export const trackTurns = (points: ArrayLike<number>, fps: number) => turns(points, 0.0015 * (30 / Math.max(1, fps)));

const LIMB_OF: Partial<Record<TrackRole, Limb>> = { footL: 'footL', footR: 'footR' };

/**
 * Plant the feet: each key whose frame is inside a foot track's contact gets that foot's IK goal over where
 * the tracked point meets the floor through the reference camera, at `footHeight` (world: the foot joint's
 * standing height), in model space (`toModel`).
 * A pose used by other keys too is copied for this key. Returns the new document and how many goals were set.
 */
export function plantFeet(doc: MotionDoc, ref: MotionReference, camera: ReferenceCamera, video: { width: number; height: number; fps: number },
                          state: TracksState, footHeight: number, toModel: (world: Vec3) => Vec3): { doc: MotionDoc; planted: number; inContact: number } {
  const res = state.result;
  if (!res) return { doc, planted: 0, inContact: 0 };
  const basis = cameraBasis(camera);
  let poses = [...doc.poses];
  const keys = doc.keys.map(k => ({ ...k }));
  let planted = 0, inContact = 0;
  for (const t of state.tracks) {
    const limb = LIMB_OF[t.role];
    const pts = res.points[t.id];
    if (!limb || !pts) continue;
    const spans = footContacts(pts, video.fps);
    for (const k of keys) {
      const i = frameIndexAt(res.times, videoTimeOf(ref, k.time));
      if (i < 0 || !spans.some(([a, b]) => i >= a && i <= b)) continue;
      inContact++;
      const x = pts[i * 2], y = pts[i * 2 + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const d = pixelRay(basis, camera.vfov, video.width, video.height, [x * video.width, y * video.height]);
      const o = basis.position;
      if (Math.abs(d[1]) < 1e-9) continue;
      const s = -o[1] / d[1];
      if (!(s > 0)) continue;
      const world: Vec3 = [o[0] + d[0] * s, footHeight, o[2] + d[2] * s];
      // The key's own pose: copied when another key shares it, or it follows a library pose.
      let pose = poses.find(p => p.id === k.poseId);
      if (!pose) continue;
      if (pose.assetId || keys.some(o2 => o2 !== k && o2.poseId === pose!.id)) {
        const copy: MotionPose = { ...structuredClone(pose), id: newId(), name: `${pose.name} (planted)` };
        delete (copy as { assetId?: string }).assetId;
        poses = [...poses, copy];
        k.poseId = copy.id;
        pose = copy;
      }
      const goal = pose.ik?.[limb];
      const next: MotionPose = { ...pose, ik: { ...pose.ik, [limb]: { ...(goal ?? {}), pos: toModel(world) } } };
      poses = poses.map(p => (p.id === pose!.id ? next : p));
      planted++;
    }
  }
  return { doc: { ...doc, poses, keys }, planted, inContact };
}
