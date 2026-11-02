// Pose assets: one pose kept in the shared Creator library (kind 'pose', under /Poses in the Assets
// explorer), for the mannequin or one Character, that any motion on that subject uses LIVE.
//
// A motion that uses one holds a `MotionPose` with the asset's id (`assetId`) and a cached copy of its bones
// and IK goals, so it bakes on its own; `refreshPoseRefs` brings the copies up to date whenever the library
// changes (and drops the link of an asset that was deleted, keeping the copy). Editing a linked pose edits
// the asset; Make local detaches a copy.
//
// What the editor gets (the asset's public files, written while its subject's skeleton is loaded):
//
//   <stem>.pose.json        the pose in the editor's Pose asset convention, with the skeleton it is on
//   <stem>.pose-asset.json  the sidecar, its output naming the file above
//
// `<stem>` is the asset's name with whitespace as `_`.

import { sidecar, type ExportFile } from '../core/generator';
import { editorPoseBones, fkPose } from './bakeMotion';
import { fileStem, storedSkin, type ExportSkin } from './exportMotion';
import { newId, normalisePose, type IkGoal, type Limb, type MotionDoc, type MotionPose, type PoseBone } from './motionDoc';
import type { MotionRig } from './motionRig';

export interface PoseAssetDoc {
  name: string;
  /** The Character (Creator library id) the pose is for; absent: the mannequin. */
  characterId?: string;
  pose: { bones: Record<string, PoseBone>; ik?: Partial<Record<Limb, IkGoal>> };
}

/** A library pose as the Motion Creator reads it: the asset's id and name (the name is the asset's), and its document. */
export interface PoseLibraryEntry {
  id: string;
  name: string;
  doc: PoseAssetDoc;
}

export function normalisePoseAsset(raw: unknown): PoseAssetDoc {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Partial<PoseAssetDoc>;
  const pose = normalisePose({ id: 'pose', name: 'Pose', ...(d.pose ?? {}) });
  return {
    name: typeof d.name === 'string' && d.name.trim() ? d.name : 'Pose',
    ...(typeof d.characterId === 'string' && d.characterId ? { characterId: d.characterId } : {}),
    pose: { bones: pose.bones, ...(pose.ik ? { ik: pose.ik } : {}) },
  };
}

/** A pose as an asset's document. */
export function poseAssetDoc(pose: Pick<MotionPose, 'bones' | 'ik'>, name: string, characterId?: string): PoseAssetDoc {
  return normalisePoseAsset({ name, ...(characterId ? { characterId } : {}), pose: { bones: pose.bones, ...(pose.ik ? { ik: pose.ik } : {}) } });
}

/** The pose an asset holds, as a motion pose linked to it. */
export function poseFromAsset(entry: PoseLibraryEntry, id: string = newId()): MotionPose {
  const { bones, ik } = entry.doc.pose;
  return { id, name: entry.name, bones: structuredClone(bones), ...(ik ? { ik: structuredClone(ik) } : {}), assetId: entry.id };
}

/** Library entries by id, from the library's Pose assets (their name is the asset's: a rename shows at once). */
export function poseLibrary(metas: readonly { id: string; name: string; doc: unknown }[]): Map<string, PoseLibraryEntry> {
  return new Map(metas.map(m => [m.id, { id: m.id, name: m.name, doc: { ...normalisePoseAsset(m.doc), name: m.name } }]));
}

/** A pose's content in one canonical form (normalised, so the order fields were written in does not count). */
const canonical = (p: MotionPose) => { const n = normalisePose(p); return JSON.stringify([n.name, n.bones, n.ik ?? null]); };
const sameContent = (a: MotionPose, b: MotionPose) => canonical(a) === canonical(b);

/**
 * The motion with every linked pose matching its asset: the name, bones and IK goals copied over; a pose
 * whose asset is gone keeps its copy as a pose of its own. The same document when nothing changed.
 */
export function refreshPoseRefs(doc: MotionDoc, library: ReadonlyMap<string, PoseLibraryEntry>): MotionDoc {
  let changed = false;
  const poses = doc.poses.map(p => {
    if (!p.assetId) return p;
    const entry = library.get(p.assetId);
    if (!entry) { changed = true; const { assetId: _, ...own } = p; return own; }
    const next = poseFromAsset(entry, p.id);
    if (sameContent(p, next)) return p;
    changed = true;
    return next;
  });
  return changed ? { ...doc, poses } : doc;
}

/** The motion with the poses linked to one asset matching it (the others untouched). The same document when nothing changed. */
export function syncPoseAsset(doc: MotionDoc, entry: PoseLibraryEntry): MotionDoc {
  let changed = false;
  const poses = doc.poses.map(p => {
    if (p.assetId !== entry.id) return p;
    const next = poseFromAsset(entry, p.id);
    if (sameContent(p, next)) return p;
    changed = true;
    return next;
  });
  return changed ? { ...doc, poses } : doc;
}

/** Whether any pose of the motion is linked to the asset. */
export function usesPoseAsset(doc: MotionDoc, assetId: string): boolean {
  return doc.poses.some(p => p.assetId === assetId);
}

/** The motion with a pose's link dropped: its copy becomes the motion's own pose. */
export function makePoseLocal(doc: MotionDoc, poseId: string): MotionDoc {
  return { ...doc, poses: doc.poses.map(p => { if (p.id !== poseId || !p.assetId) return p; const { assetId: _, ...own } = p; return own; }) };
}

/** The motion's pose linked to the asset -- the one it has, or a new one added -- and the motion with it. */
export function withAssetPose(doc: MotionDoc, entry: PoseLibraryEntry): { doc: MotionDoc; poseId: string } {
  const had = doc.poses.find(p => p.assetId === entry.id);
  if (had) return { doc, poseId: had.id };
  const pose = poseFromAsset(entry);
  return { doc: { ...doc, poses: [...doc.poses, pose] }, poseId: pose.id };
}

/**
 * The public files of a Pose asset (see the header). `name` and `assetId` are the library asset's; `rig`
 * and `skin` the subject's skeleton, `rigName` its name ('Mannequin' for the mannequin). IK goals are
 * solved into the bones' rotations first: the editor's poses are rotations only.
 */
export function exportPoseAsset(doc: PoseAssetDoc, name: string, assetId: string, rig: MotionRig, skin: ExportSkin, rigName: string): ExportFile[] {
  const stem = fileStem(name);
  const file = `${stem}.pose.json`;
  const pose = fkPose(rig, { id: assetId, name, bones: doc.pose.bones, ...(doc.pose.ik ? { ik: doc.pose.ik } : {}) });
  const json = { name, rigName, sourceSkin: storedSkin(skin), poses: [{ id: assetId, name, bones: editorPoseBones(rig, pose) }] };
  const side = sidecar('pose', doc, 0, { pose: file });
  return [
    { name: file, mime: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(json)) },
    { ...side, name: `${stem}.pose-asset.json` },
  ];
}
