import { createContext, useContext } from 'react';
import type { Animation } from 'cleo/animation/animatedModel';
import type { BakedClip } from '../bakeMotion';
import type { BlendPreset } from '../blendCurve';
import type { CharacterDoc } from '../character';
import type { MotionDoc } from '../motionDoc';
import type { MotionRig } from '../motionRig';

// The Motion Creator's shared state, for the panels around the viewport. Dockview unmounts a panel whose
// tab is hidden, so anything that must outlive one -- the selection, the playhead -- lives here.

export type View = 'pose' | 'motion' | 'clip';

export interface MotionState {
  doc: MotionDoc;
  setDoc: (d: MotionDoc) => void;
  rig: MotionRig | null;
  poseId: string;
  setPoseId: (id: string) => void;
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
  onExport: () => void;
  exporting: boolean;
  /** The key selected on the timeline: its blend (the way into it) is the one being edited. */
  keyId: string | null;
  setKeyId: (id: string | null) => void;
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

/** Drag-and-drop type of a pose dragged from the Poses list onto the timeline. */
export const POSE_DRAG_TYPE = 'application/x-cleo-motion-pose';
