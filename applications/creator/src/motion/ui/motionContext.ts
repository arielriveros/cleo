import { createContext, useContext } from 'react';
import type { Animation } from 'cleo/animation/animatedModel';
import type { BakedClip } from '../bakeMotion';
import type { BlendPreset } from '../blendCurve';
import type { CharacterDoc } from '../character';
import type { MotionDoc, MotionPose } from '../motionDoc';
import type { MotionRig } from '../motionRig';
import type { PoseLibraryEntry } from '../poseAsset';
import type { MotionTransport, TransportState } from '../reference/transport';
import type { FrameGrid, MotionReference } from '../reference/referenceDoc';
import type { MotionStageSettings } from './motionStage';
import type { ReferenceState } from './useReference';
import type { Rect } from '../reference/gate';
import type { ReferenceCamera, Vec3 } from '../reference/referenceCamera';
import type { CalibrationDoc, SolveResult } from '../reference/calibrate';
import type { AnalysisView } from '../reference/cv/analysisView';

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
  /** The playhead right now: the transport's (Pose and Motion views) or the character's own clip's. */
  stageTime: () => number;
  scrub: (t: number) => void;
  playing: boolean;
  togglePlay: () => void;
  /**
   * The Motion view's clock (reference/transport.ts): its time is the playhead in the Pose and Motion views,
   * so the reference video and the motion stay on one frame. `transportState` re-renders on its changes.
   */
  transport: MotionTransport;
  transportState: TransportState;
  /** Step `n` frames on the grid (the video's frames, else the bake rate); the clip view steps its clip. */
  stepFrames: (n: number) => void;
  toStart: () => void;
  toEnd: () => void;
  /** The frame grid keys snap to and the transport steps on. */
  grid: FrameGrid;
  /** The timeline's length: the clip, or the reference's out-point when later. */
  timelineEnd: number;
  /** The linked reference video, opened (useReference.ts). */
  reference: ReferenceState;
  /** Link a video (a new file, or a library clip by id); null: unlink. */
  linkVideo: (source: File | string | null) => Promise<void>;
  setReference: (r: MotionReference) => void;
  /** A key at the playhead with a new pose: the motion as it is at that moment, to pose against the frame. */
  keyFromFrame: () => void;
  /** The stage's settings (the reference's display among them). */
  stage: MotionStageSettings;
  setStage: (s: MotionStageSettings) => void;
  /** Where the video's frame sits in the viewport (the film gate), and the viewport's size; null without a clip. */
  gate: Rect | null;
  viewSize: { w: number; h: number } | null;
  /** The viewport framed through the reference camera, with the video's lens. */
  lookThrough: boolean;
  setLookThrough: (on: boolean) => void;
  /** The reference camera as the viewport sees it now (an orbit with the video's lens), or null. */
  viewCamera: () => ReferenceCamera | null;
  /** Write the reference's camera (an explicit act: it re-publishes the motion). */
  setCamera: (c: ReferenceCamera) => void;
  /** What Reference ▸ Calibrate draws over the video: its lines and origin, Match pose's pins, or nothing. */
  calibrating: 'off' | 'lines' | 'pins';
  setCalibrating: (c: 'off' | 'lines' | 'pins') => void;
  /** The calibration being edited (the reference's, or the defaults for this clip), and the live solve. */
  calibration: CalibrationDoc | null;
  setCalibration: (c: CalibrationDoc, done: boolean) => void;
  solve: SolveResult | null;
  /** A joint waiting for a click on the frame (Match pose). */
  placingPin: string | null;
  setPlacingPin: (joint: string | null) => void;
  /** Every joint's world position in the pose on screen. */
  jointPositions: () => Map<string, Vec3>;
  /** The character's standing height in the stage's world, metres (the default for scale by height). */
  subjectHeight: number;
  /** The clip's analysis read with the stage's sensitivity: key candidates, holds, cuts, the subject's box. */
  analysisView: AnalysisView | null;
  /** A key (and a pose from the motion there) at every key-pose candidate inside the clip. */
  addKeysAtCandidates: () => void;
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
