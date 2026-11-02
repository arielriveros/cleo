// What the Motion Creator writes: the baked clip with the skeleton it was authored on (`<name>.anim.json`,
// the editor's `.anim` asset shape: clips in source-rig space plus the source skin, so it retargets onto
// any character), and the sidecar (`<name>.motion.json`) that regenerates it and tells the editor's
// Creator sync what to import.

import { sidecar, type ExportFile } from '../core/generator';
import type { BakedClip } from './bakeMotion';
import { motionDuration, type MotionDoc } from './motionDoc';
import type { SkinLike } from './motionRig';

/** A file name stem from an asset name: whitespace to `_`; nothing left: `fallback`. */
export const fileStem = (name: string, fallback = 'untitled') => name.trim().replace(/\s+/g, '_') || fallback;

/** A skin as the engine holds it: {@link SkinLike} plus the bind matrices and root a stored skin carries. */
export type ExportSkin = Omit<SkinLike, 'joints'> & {
  joints: { nodeIndex: number; inverseBindMatrix?: ArrayLike<number>; parentIndex?: number }[];
  skeleton?: number;
  name?: string;
};

/** The skin flattened for JSON: Maps as entry pairs, matrices as plain arrays (the editor's `StoredSkin`). */
export function storedSkin(skin: ExportSkin) {
  const pairs = <V,>(m: Map<number, V> | [number, V][] | undefined, f: (v: V) => unknown = v => v) =>
    (m instanceof Map ? [...m.entries()] : Array.isArray(m) ? m : []).map(([k, v]) => [Number(k), f(v)]);
  return {
    ...(skin.name ? { name: skin.name } : {}),
    joints: skin.joints.map(j => ({
      nodeIndex: j.nodeIndex, inverseBindMatrix: Array.from(j.inverseBindMatrix ?? []),
      ...(j.parentIndex !== undefined ? { parentIndex: j.parentIndex } : {}),
    })),
    ...(skin.skeleton !== undefined ? { skeleton: skin.skeleton } : {}),
    nodeParents: pairs(skin.nodeParents),
    nodeTransforms: pairs(skin.nodeTransforms as Map<number, ArrayLike<number>>, v => Array.from(v)),
    nodeNames: pairs(skin.nodeNames),
  };
}

/**
 * The files for a motion. `name` names the clip and the files: the library asset's name (a scratch motion
 * is `untitled`); by default the document's own.
 */
export function exportMotion(doc: MotionDoc, clip: BakedClip, skin: ExportSkin, rigName = 'Mannequin', name = doc.name): ExportFile[] {
  const stem = fileStem(name);
  const anim = { clips: [{ ...clip, name }], sourceSkin: storedSkin(skin), rigName };
  const out: ExportFile[] = [{ name: `${stem}.anim.json`, mime: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(anim)) }];
  const json = sidecar('motion', doc, doc.seed, {
    name,
    anim: `${stem}.anim.json`,
    rig: rigName,
    duration: clip.samplers[0]?.input.at(-1) ?? motionDuration(doc),
    fps: doc.fps,
    loop: doc.loop,
    poses: doc.poses.length,
    keys: doc.keys.length,
  });
  out.push({ ...json, name: `${stem}.motion.json` });
  return out;
}
