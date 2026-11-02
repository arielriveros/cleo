// A Character: a rigged model uploaded to the Creator library (Assets ▸ + Add ▸ Rigged character…), the
// subject the Motion Creator can animate instead of the mannequin.
//
// Its uploaded files are kept as the asset's PRIVATE files (only the Creator reads them back). The document
// says what the user made of them: which of the file's clips to keep and what to call them. What the
// editor gets (the public files, followed by the Creator sync):
//
//   <name>.anim.json       every kept clip, renamed, with the skeleton they play on (an `.anim` asset each)
//   <name>.character.json  the sidecar
//
// Its poses are library Pose assets of their own (poseAsset.ts) that name the character. A character saved
// before those existed kept a pose library in its document (`poses`): opening it moves each pose into a
// Pose asset, once, and empties the list.

import { sidecar, type ExportFile } from '../core/generator';
import { newId, normaliseMotion, type MotionPose } from './motionDoc';
import type { MotionRig } from './motionRig';
import { fileStem, storedSkin, type ExportSkin } from './exportMotion';
import type { Animation } from 'cleo/animation/animatedModel';

export interface CharacterClip {
  id: string;
  /** The clip's name in the uploaded file. */
  source: string;
  /** What it is called here and in the editor. */
  name: string;
  /** Kept out of what the editor gets. */
  hidden?: boolean;
}

export interface CharacterDoc {
  name: string;
  /** The uploaded files' names (the asset's private files). */
  sourceFiles: string[];
  clips: CharacterClip[];
  /** Legacy: the pose library a character kept before Pose assets. Moved into Pose assets on open. */
  poses: MotionPose[];
}

export function newCharacter(name: string, sourceFiles: string[], animations: { name: string }[]): CharacterDoc {
  const seen = new Set<string>();
  const clips = animations.filter(a => a.name && !seen.has(a.name) && (seen.add(a.name), true))
    .map(a => ({ id: newId(), source: a.name, name: a.name }));
  return { name, sourceFiles, clips, poses: [] };
}

export function normaliseCharacter(raw: Partial<CharacterDoc> | null | undefined): CharacterDoc {
  const d = raw ?? {};
  const clips = (Array.isArray(d.clips) ? d.clips : []).filter(c => c && typeof c.source === 'string').map(c => ({
    id: typeof c.id === 'string' ? c.id : newId(), source: c.source,
    name: typeof c.name === 'string' && c.name.trim() ? c.name : c.source, ...(c.hidden ? { hidden: true } : {}),
  }));
  // Poses are motion poses: the motion normaliser cleans them (it also adds a rest pose when there are
  // none, which a character's library does not want).
  const poses = Array.isArray(d.poses) && d.poses.length ? normaliseMotion({ poses: d.poses }).poses : [];
  return {
    name: typeof d.name === 'string' && d.name.trim() ? d.name : 'Character',
    sourceFiles: Array.isArray(d.sourceFiles) ? d.sourceFiles.filter(f => typeof f === 'string') : [],
    clips, poses,
  };
}

/** The public files for the editor (see the header). */
export function exportCharacter(doc: CharacterDoc, _rig: MotionRig, skin: ExportSkin, animations: Animation[]): ExportFile[] {
  const stem = fileStem(doc.name, 'character');
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  const byName = new Map(animations.map(a => [a.name, a]));
  const clips = doc.clips.filter(c => !c.hidden && byName.has(c.source)).map(c => {
    const a = byName.get(c.source)!;
    return { name: c.name, samplers: a.samplers, channels: a.channels, ...(a.events?.length ? { events: a.events } : {}) };
  });
  const out: ExportFile[] = [
    { name: `${stem}.anim.json`, mime: 'application/json', bytes: enc({ clips, sourceSkin: storedSkin(skin), rigName: doc.name }) },
  ];
  const json = sidecar('character', { name: doc.name, clips: doc.clips }, 0, {
    name: doc.name, anim: `${stem}.anim.json`, clips: clips.map(c => c.name),
  });
  out.push({ ...json, name: `${stem}.character.json` });
  return out;
}
