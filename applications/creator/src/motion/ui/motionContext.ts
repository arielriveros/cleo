import { createContext, useContext } from 'react';
import type { Animation } from 'cleo/animation/animatedModel';
import type { BakedClip } from '../bakeMotion';
import type { BlendPreset } from '../blendCurve';
import type { CharacterDoc } from '../character';
import type { MotionDoc, MotionPose } from '../motionDoc';
import type { MotionRig } from '../motionRig';
import type { PoseLibraryEntry } from '../poseAsset';

// The Motion Creator's shared state, for the panels around the viewport. Dockview unmounts a panel whose
// tab is hidden, so anything that must outlive one -- the selection, the playhead -- lives here.

export type View = 'pose' | 'motion' | 'clip';

export interface MotionState {
  doc: MotionDoc;
  setDoc: (d: MotionDoc) => void;
  rig: MotionRig | null;
  /** The motion pose selected (keys, the Poses list). */
  poseId: string;
  /** Select a motion pose (and stop editing a library pose). */
  setPoseId: (id: string) => void;
  /** The library pose being edited while it is not one of the motion's, or null. */
  libraryPoseId: string | null;
  setLibraryPoseId: (id: string | null) => void;
  /**
   * The pose the Pose tab and the viewport edit: the selected motion pose, or the library pose. A pose
   * linked to a library asset edits the asset (every motion that uses it follows).
   */
  pose: MotionPose;
  setPose: (p: MotionPose) => void;
  /** The library's poses for this motion's subject, by name. */
  libraryPoses: PoseLibraryEntry[];
  /** Keep a motion pose in the library: it becomes a Pose asset, and the motion uses it from there. */
  saveToLibrary: (poseId: string) => void;
  bone: string | null;
  setBone: (name: string | null) => void;
  view: View;
  setView: (v: View) => void;
  clip: BakedClip | null;
  /** The playhead, seconds (polled; the timeline reads `stageTime` per frame). */
  time: number;
  /** The stage's playhead right now. */
  stageTime: () => number;
  scrub: (t: number) => void;
  playing: boolean;
  togglePlay: () => void;
  /** The key selected on the timeline: its blend (the way into it) is the one being edited. */
  keyId: string | null;
  setKeyId: (id: string | null) => void;
  /** The part selected (the Parts tab, a part's lane on the timeline, the key's Parts section). */
  partId: string | null;
  setPartId: (id: string | null) => void;
  /** Whether the Parts tab is showing: a joint clicked in the viewport then joins or leaves the selected part. */
  setPartsOpen: (open: boolean) => void;
  /** Blend presets saved by the user, shared by every motion. */
  savedPresets: BlendPreset[];
  setSavedPresets: (p: BlendPreset[]) => void;
  /** The Character being animated, or null for the mannequin. */
  character: CharacterDoc | null;
  setCharacter: (c: CharacterDoc) => void;
  /** The file's own clip shown in the `clip` view, by its name in the file. */
  sourceClip: string | null;
  showSourceClip: (source: string) => void;
  sourceAnimations: Animation[];
}

export const MotionCtx = createContext<MotionState | null>(null);
export const useMotion = () => useContext(MotionCtx)!;

/** Drag-and-drop type of a pose dragged from the Poses list onto the timeline: a motion pose's id, or `asset:<id>`. */
export const POSE_DRAG_TYPE = 'application/x-cleo-motion-pose';
/** The drag payload of a library pose. */
export const libraryDrag = (assetId: string) => `asset:${assetId}`;
