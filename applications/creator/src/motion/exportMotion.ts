// What the Motion Creator writes: the baked clip with the skeleton it was authored on (`<name>.anim.json`,
// the editor's `.anim` asset shape: clips in source-rig space plus the source skin, so it retargets onto
// any character), and the sidecar (`<name>.motion.json`) that regenerates it and tells the editor's
// Creator sync what to import.

import { sidecar, type ExportFile } from '../core/generator';
import type { BakedClip } from './bakeMotion';
import { motionDuration, type MotionDoc } from './motionDoc';
import type { SkinLike } from './motionRig';

const fileStem = (name: string) => name.trim().replace(/\s+/g, '_') || 'motion';

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

export function exportMotion(doc: MotionDoc, clip: BakedClip, skin: ExportSkin, rigName = 'Mannequin'): ExportFile[] {
  const stem = fileStem(doc.name);
  const anim = { clips: [{ ...clip, name: doc.name }], sourceSkin: storedSkin(skin), rigName };
  const out: ExportFile[] = [{ name: `${stem}.anim.json`, mime: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(anim)) }];
  const json = sidecar('motion', doc, doc.seed, {
    name: doc.name,
    anim: `${stem}.anim.json`,
    rig: rigName,
    duration: clip.samplers[0]?.input.at(-1) ?? motionDuration(doc),
    fps: doc.fps,
    loop: doc.loop,
    poses: doc.poses.length,
    keys: doc.keys.length,
    events: clip.events ?? [],
  });
  out.push({ ...json, name: `${stem}.motion.json` });
  return out;
}
