import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Collapsable, NumberInput, SegmentedControl, Select, Slider, Toggle } from '@cleo/app-kit/ui';
import { toast } from '@cleo/app-kit/feedback/toastStore';
import { confirmDialog, promptDialog } from '@cleo/app-kit/feedback/dialogStore';
import {
  deleteCreatorAsset, getCreatorAsset, listCreatorAssets, newCreatorAssetId, renameCreatorAsset, type CreatorAssetMeta, type CreatorFile,
} from '@cleo/app-kit/creatorLibrary';
import { useCreatorEngine } from '../../app/CreatorEngine';
import { CreatorWorkspace, ListRow, PanelBody, PanelHeader, ViewportOverlay } from '../../app/workspace';
import { downloadAll } from '../../core/download';
import { AssetBar, useCreatorAsset, writeCreatorAsset } from '../../core/useCreatorAsset';
import { useStageCapture } from '../../core/stageCapture';
import { useGeneration } from '../../core/useGeneration';
import { frameBox, installOrbitCamera } from '../../fx/ui/fxPreview';
import { bakeMotion, bakePose, gripFrom, limbTipFrame, mirrorPose, poseFromClip, solvedPoseLocals, type BakedClip } from '../bakeMotion';
import { exportCharacter, normaliseCharacter, type CharacterDoc } from '../character';
import type { ExportFile } from '../../core/generator';
import type { Animation } from 'cleo/animation/animatedModel';
import { exportMotion } from '../exportMotion';
import {
  DEFAULT_MOTION, LIMB_CHAINS, LIMB_LABELS, LIMB_MIRROR, LIMBS, motionDuration, newId, normaliseMotion, restPose,
  type IkGoal, type Limb, type MotionDoc, type MotionPose, type Vec3,
} from '../motionDoc';
import { loadSavedPresets, type BlendPreset } from '../blendCurve';
import { boneGroups, defaultParts } from '../parts';
import {
  exportPoseAsset, makePoseLocal, normalisePoseAsset, poseAssetDoc, poseFromAsset, poseLibrary, refreshPoseRefs, syncPoseAsset,
  usesPoseAsset, withAssetPose, type PoseAssetDoc, type PoseLibraryEntry,
} from '../poseAsset';
import { MotionCtx, POSE_DRAG_TYPE, libraryDrag, useMotion, type MotionState, type View } from './motionContext';
import { TimelinePanel } from './TimelinePanel';
import { PartsPanel } from './PartsPanel';
import { PoseGizmos } from './PoseGizmos';
import { modelPose, type MotionRig } from '../motionRig';
import { DEFAULT_MOTION_STAGE, MotionStage, type MotionStageSettings } from './motionStage';

// Motion Creator: a character animated from a few key POSES. Pose the mannequin bone by bone (or plant a
// hand or foot with IK and let the limb bend to it), mirror poses left to right, then lay the poses on a
// timeline with a blend curve into each -- per body PART, if the arms should swing while the legs go
// straight. The bake adds overlapping action and a little life, and the clip goes to the editor as an
// ordinary `.anim` -- retargetable onto every humanoid there. (Clip events are not made here: the editor
// sets them on the clip.)
//
// Layout (app/workspace.tsx): the character's clips and the Poses on the left; Pose, Parts and Motion
// (feel, clip) on the right; the Timeline (TimelinePanel.tsx) under the viewport, beside Assets and
// Console. The viewport plays the whole motion, holds the selected pose while it is being edited, or plays
// one of the character's own clips, with the skeleton drawn over it.
//
// Poses are the motion's own, or LIBRARY poses (poseAsset.ts: Pose assets in the shared library, per
// subject) that the motion uses live: editing one edits the asset, and every motion on the subject that
// uses it follows -- this one at once, the others re-baked and re-published as the asset is saved.
//
// The subject is the mannequin or a CHARACTER: a rigged model uploaded with Assets ▸ + Add ▸ Rigged
// character… (motion/characterImport.ts). A character keeps its file's clips -- renamed, hidden or dropped
// here, and synced to the editor as `.anim` assets -- which any frame of can start a pose (Pose from frame).

const DOC_KEY = 'cleo_creator_motion_doc_v1';
const STAGE_KEY = 'cleo_creator_motion_stage_v1';
const REBAKE_MS = 90;

function load<T>(key: string, fallback: T, read: (raw: unknown) => T): T {
  try { const raw = localStorage.getItem(key); if (raw) return read(JSON.parse(raw)); } catch { /* fall through */ }
  return fallback;
}
const save = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ } };

export function MotionWorkspace() {
  const { instance, scene, camera, sun, bus } = useCreatorEngine();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [doc, setDocState] = useState<MotionDoc>(() => load(DOC_KEY, DEFAULT_MOTION, raw => normaliseMotion(raw as MotionDoc)));
  const docRef = useRef(doc);
  docRef.current = doc;
  const [stageSettings, setStageSettings] = useState<MotionStageSettings>(() => load(STAGE_KEY, DEFAULT_MOTION_STAGE, raw => ({ ...DEFAULT_MOTION_STAGE, ...(raw as object) })));
  const [rig, setRig] = useState<MotionRig | null>(null);
  /** The subject the loaded rig is of (null: the mannequin): nothing is written on another subject's skeleton. */
  const [rigSubject, setRigSubject] = useState<string | null | undefined>(undefined);
  const [poseId, setPoseIdState] = useState(doc.poses[0].id);
  const [libraryPoseId, setLibraryPoseId] = useState<string | null>(null);
  const [bone, setBone] = useState<string | null>(null);
  const [view, setView] = useState<View>('pose');
  const [clip, setClip] = useState<BakedClip | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(true);
  const stageRef = useRef<MotionStage | null>(null);
  const orbit = useRef<ReturnType<typeof installOrbitCamera> | null>(null);
  const exportJob = useGeneration();
  /** The Character's document and its uploaded files (null: the mannequin). */
  const [character, setCharacterState] = useState<CharacterDoc | null>(null);
  const [charFiles, setCharFiles] = useState<File[] | null>(null);
  const [sourceClip, setSourceClip] = useState<string | null>(null);
  const [sourceAnimations, setSourceAnimations] = useState<Animation[]>([]);
  const [keyId, setKeyId] = useState<string | null>(null);
  const [partId, setPartId] = useState<string | null>(null);
  const [partsOpen, setPartsOpen] = useState(false);
  const [savedPresets, setSavedPresets] = useState<BlendPreset[]>(loadSavedPresets);

  const setDoc = (d: MotionDoc) => { const n = normaliseMotion(d); docRef.current = n; setDocState(n); };
  const subject = doc.characterId ?? null;
  const ready = !!rig && rigSubject === subject;
  useEffect(() => { const t = setTimeout(() => save(DOC_KEY, doc), 250); return () => clearTimeout(t); }, [doc]);
  useEffect(() => { save(STAGE_KEY, stageSettings); stageRef.current?.apply(stageSettings); }, [stageSettings]);
  // The bone picked in the Pose tab is the one highlighted on the skeleton.
  useEffect(() => { stageRef.current?.setSelectedBone(view === 'pose' ? bone : null); }, [bone, view, rig]);
  // The selected pose survives edits; a deleted one falls back to the first.
  useEffect(() => { if (!doc.poses.some(p => p.id === poseId)) setPoseIdState(doc.poses[0].id); }, [doc, poseId]);
  const setPoseId = (id: string) => { setLibraryPoseId(null); setPoseIdState(id); };

  // The stage, the character and the camera.
  useEffect(() => {
    if (!instance || !scene) return;
    const s = new MotionStage(instance, scene, sun);
    stageRef.current = s;
    s.apply(stageSettings);
    return () => { s.dispose(); stageRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance, scene, sun]);
  // The subject: the mannequin, or the opened Character's files. Waits for a remembered character's files
  // rather than flashing the mannequin first.
  const wantsCharacter = !!doc.characterId;
  useEffect(() => {
    const s = stageRef.current;
    if (!s || (wantsCharacter && !charFiles)) return;
    let alive = true;
    const forSubject = charFiles ? docRef.current.characterId ?? null : null;
    setRig(null);
    s.load(charFiles ?? undefined).then(r => {
      if (!alive) return;
      setSourceAnimations(s.sourceAnimations());
      setRigSubject(forSubject);
      setRig(r);
    }).catch(e => toast.error(String((e as Error)?.message ?? e), { title: charFiles ? 'Could not load the character' : 'Could not load the mannequin' }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance, scene, sun, charFiles, wantsCharacter]);
  const frame = () => {
    if (!orbit.current) return;
    const b = stageRef.current?.bounds;
    orbit.current.frame(b ? frameBox(b.size, orbit.current.current().yaw, b.floor) : frameBox([1.26, 1.8, 1.26], orbit.current.current().yaw));
  };
  useEffect(() => {
    if (!camera) return;
    // From the front: the mannequin faces +Z.
    orbit.current = installOrbitCamera(camera, frameBox([1.2, 1.8, 1.2], 200));
    return () => { orbit.current?.restore(); orbit.current = null; };
  }, [camera]);
  useEffect(() => { if (rig) frame(); }, [rig]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- The saved assets: the motion, its subject (a Character), and the library's poses ---
  const capture = useStageCapture();
  const asset = useCreatorAsset<MotionDoc>('motion', doc, d => setDoc(normaliseMotion(d)), () => {}, capture);
  const rigName = character?.name ?? 'Mannequin';

  const charBytes = useRef<ExportFile[]>([]);
  const restoreCharacter = (files: CreatorFile[]) => {
    charBytes.current = [];
    void Promise.all(files.map(async f => {
      const bytes = new Uint8Array(await f.blob.arrayBuffer());
      charBytes.current.push({ name: f.name, mime: f.mime, bytes });
      return new File([bytes as BlobPart], f.name, { type: f.mime });
    })).then(list => setCharFiles(list));
  };
  const charAsset = useCreatorAsset<CharacterDoc | null>('character', character, d => setCharacterState(normaliseCharacter(d)), restoreCharacter, capture);
  const setCharacter = (c: CharacterDoc) => setCharacterState(normaliseCharacter(c));
  /** Animate the mannequin (null) or a library Character. */
  const chooseSubject = (id: string | null) => {
    const d = docRef.current;
    setSourceClip(null);
    setLibraryPoseId(null);
    if (view === 'clip') setView('pose');
    if (!id) { setCharacterState(null); setCharFiles(null); void charAsset.open(null); setDoc({ ...d, characterId: undefined }); return; }
    setCharFiles(null);
    setDoc({ ...d, characterId: id });
    void charAsset.open(id);
  };
  // A remembered character is re-opened (its files are not kept across reloads, only in the library).
  useEffect(() => { if (doc.characterId) void charAsset.open(doc.characterId); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // A character opened from the Assets explorer becomes this motion's subject.
  useEffect(() => {
    const id = charAsset.active?.id;
    if (id && id !== doc.characterId) { setCharFiles(null); setDoc({ ...doc, characterId: id }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charAsset.active?.id]);
  // A motion made for a character that is no longer in the library plays on the mannequin.
  useEffect(() => {
    const id = doc.characterId;
    if (!id) return;
    let alive = true;
    void getCreatorAsset(id).then(m => {
      if (!alive || (m && !m.deleted) || docRef.current.characterId !== id) return;
      toast.info('The character this motion was made for is not in the library: it plays on the mannequin.');
      chooseSubject(null);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.characterId]);
  // Its clips follow every edit to the editor.
  useEffect(() => {
    const s = stageRef.current;
    if (!character || !charAsset.active || !rig || !s?.skin || !charFiles || !ready) return;
    charAsset.publish({ from: character, files: exportCharacter(character, rig, s.skin as any, sourceAnimations), privateFiles: charBytes.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [character, rig, ready]);

  // --- Library poses ---
  /** The pose asset being edited, as last changed here (ahead of the library until it is written). */
  const [poseEdit, setPoseEdit] = useState<{ id: string; doc: PoseAssetDoc } | null>(null);
  /** Assets written here that the library listing has not caught up with yet. */
  const justMade = useRef(new Map<string, PoseLibraryEntry>());
  const poseLib = useCreatorAsset<PoseAssetDoc | null>('pose', poseEdit?.doc ?? null, () => {}, undefined, capture, {
    onExternalOpen: id => void openPoseAsset(id),
    onPublished: meta => void republishDependents(meta),
  });
  const library = useMemo(() => {
    const lib = poseLibrary(poseLib.assets);
    for (const [id, e] of justMade.current) { if (lib.has(id)) justMade.current.delete(id); else lib.set(id, e); }
    return lib;
  }, [poseLib.assets]);
  const libraryPoses = useMemo(() => [...library.values()].filter(e => (e.doc.characterId ?? null) === subject), [library, subject]);
  const motionPose = doc.poses.find(p => p.id === poseId) ?? doc.poses[0];
  /** The library asset the Pose tab edits: the library pose picked, or the one the selected motion pose uses. */
  const editAssetId = libraryPoseId ?? motionPose.assetId ?? null;
  const editEntry: PoseLibraryEntry | undefined = editAssetId
    ? (poseEdit?.id === editAssetId ? { id: editAssetId, name: library.get(editAssetId)?.name ?? poseEdit.doc.name, doc: poseEdit.doc } : library.get(editAssetId))
    : undefined;
  const pose = useMemo<MotionPose>(() => (editEntry ? poseFromAsset(editEntry, libraryPoseId ? `asset:${editEntry.id}` : motionPose.id) : motionPose),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editEntry?.id, editEntry?.name, editEntry?.doc, libraryPoseId, motionPose]);
  // The asset being edited is the pose hook's active one, so its edits publish (and nothing else's do).
  const openedPose = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (editAssetId && poseEdit?.id !== editAssetId) { const e = library.get(editAssetId); if (e) setPoseEdit({ id: editAssetId, doc: e.doc }); }
    if (!editAssetId && poseEdit) setPoseEdit(null);
    if (openedPose.current !== editAssetId) { openedPose.current = editAssetId; void poseLib.open(editAssetId); }
    // A library pose deleted while it was being edited: back to the motion's.
    if (libraryPoseId && poseLib.loaded && !library.has(libraryPoseId)) setLibraryPoseId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editAssetId, library, poseLib.loaded]);
  // The motion's linked poses follow the library (on open, and whenever it changes); a deleted asset's
  // copy stays, as the motion's own pose.
  useEffect(() => {
    if (!poseLib.loaded) return;
    const lib = new Map(library);
    for (const [id, e] of justMade.current) if (!lib.has(id)) lib.set(id, e);
    if (poseEdit && lib.has(poseEdit.id)) lib.set(poseEdit.id, { ...lib.get(poseEdit.id)!, doc: poseEdit.doc });
    const next = refreshPoseRefs(doc, lib);
    if (next !== doc) setDoc(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library, poseLib.loaded, doc]);
  // The pose asset being edited is written (with its files, on its subject's skeleton) as it changes.
  useEffect(() => {
    const skin = stageRef.current?.skin;
    const active = poseLib.active;
    if (!poseEdit || !rig || !skin || !ready || active?.id !== poseEdit.id || (poseEdit.doc.characterId ?? null) !== subject) return;
    const d = { ...poseEdit.doc, name: active.name };
    if (d.name !== poseEdit.doc.name) { setPoseEdit({ id: poseEdit.id, doc: d }); return; }
    poseLib.publish({ from: poseEdit.doc, files: exportPoseAsset(poseEdit.doc, active.name, active.id, rig, skin as any, rigName) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poseEdit, rig, ready, poseLib.active?.id, poseLib.active?.name]);

  /** The pose the Pose tab and the viewport edit (see `pose`): a linked one edits its asset. */
  const setPose = (next: MotionPose) => {
    const d = docRef.current;
    if (editAssetId && editEntry) {
      const asDoc = normalisePoseAsset({ ...editEntry.doc, pose: { bones: next.bones, ...(next.ik ? { ik: next.ik } : {}) } });
      setPoseEdit({ id: editAssetId, doc: asDoc });
      // The motion's copies follow now, for the preview and the bake, not after the library round trip.
      const synced = syncPoseAsset(d, { ...editEntry, doc: asDoc });
      if (synced !== d) setDoc(synced);
      return;
    }
    setDoc({ ...d, poses: d.poses.map(p => (p.id === next.id ? next : p)) });
  };

  /** A motion pose becomes a library Pose asset (for this subject), and the motion uses it from there. */
  const saveToLibrary = async (id: string) => {
    const p = docRef.current.poses.find(x => x.id === id);
    if (!p || p.assetId) return;
    const name = await promptDialog({
      title: 'Save to the library', defaultValue: p.name, confirmLabel: 'Save',
      message: 'Every motion on this character can use it; editing it changes them all.',
      validate: v => (v.trim() ? null : 'Give the pose a name.'),
    });
    if (!name?.trim()) return;
    const assetId = newCreatorAssetId('pose');
    const pd = poseAssetDoc(p, name.trim(), docRef.current.characterId);
    const skin = stageRef.current?.skin;
    const files = rig && skin && ready ? exportPoseAsset(pd, name.trim(), assetId, rig, skin as any, rigName) : [];
    let thumbnail: string | undefined;
    try { if (view === 'pose' && pose.id === id) thumbnail = await capture() || undefined; } catch { /* fine */ }
    await writeCreatorAsset({ id: assetId, kind: 'pose', name: name.trim(), doc: pd, files, thumbnail });
    justMade.current.set(assetId, { id: assetId, name: name.trim(), doc: pd });
    const d = docRef.current;
    setDoc({ ...d, poses: d.poses.map(x => (x.id === id ? { ...x, name: name.trim(), assetId } : x)) });
    toast.success(`${name.trim()} is in the library (Assets ▸ /Poses).`);
  };

  /** The Assets explorer opened a Pose asset: its subject, and the Pose view on it. */
  const openPoseAsset = async (id: string) => {
    const meta = await getCreatorAsset(id);
    if (!meta || meta.deleted) return;
    const pd = { ...normalisePoseAsset(meta.doc), name: meta.name };
    if ((pd.characterId ?? null) !== (docRef.current.characterId ?? null)) chooseSubject(pd.characterId ?? null);
    const linked = docRef.current.poses.find(p => p.assetId === id);
    if (linked) setPoseId(linked.id); else setLibraryPoseId(id);
    setPoseEdit({ id, doc: pd });
    setView('pose');
  };

  /**
   * A pose asset was written: the other motions on this subject that use it are re-baked and re-published
   * now (on the skeleton loaded here); motions on other subjects catch up when they are next opened.
   */
  const republishDependents = async (meta: CreatorAssetMeta) => {
    const skin = stageRef.current?.skin;
    if (!rig || !skin || !ready) return;
    const all = await listCreatorAssets();
    const lib = poseLibrary(all.filter(a => a.kind === 'pose' && !a.deleted));
    if ((lib.get(meta.id)?.doc.characterId ?? null) !== subject) return;
    for (const m of all) {
      if (m.kind !== 'motion' || m.deleted || m.id === asset.active?.id) continue;
      const md = normaliseMotion(m.doc as MotionDoc);
      if ((md.characterId ?? null) !== subject || !usesPoseAsset(md, meta.id)) continue;
      const next = refreshPoseRefs(md, lib);
      if (next === md) continue;
      try {
        await writeCreatorAsset({ id: m.id, kind: 'motion', name: m.name, doc: next, files: exportMotion(next, bakeMotion(rig, next), skin as any, rigName, m.name) });
      } catch (e) { console.error(e); }
    }
  };

  // A character's old pose library (kept in its document) becomes Pose assets, once, on open.
  const migrated = useRef(new Set<string>());
  useEffect(() => {
    const id = charAsset.active?.id, skin = stageRef.current?.skin;
    if (!character?.poses.length || !id || !rig || !skin || !ready || subject !== id || migrated.current.has(id)) return;
    migrated.current.add(id);
    const { poses, name: charName } = character;
    void (async () => {
      for (const p of poses) {
        const assetId = newCreatorAssetId('pose');
        const pd = poseAssetDoc(p, p.name, id);
        await writeCreatorAsset({ id: assetId, kind: 'pose', name: p.name, doc: pd, files: exportPoseAsset(pd, p.name, assetId, rig, skin as any, charName) });
      }
      setCharacterState(c => (c ? normaliseCharacter({ ...c, poses: [] }) : c));
      toast.success(`${charName}’s ${poses.length} saved pose${poses.length === 1 ? ' is a Pose asset' : 's are Pose assets'} now, in Assets ▸ /Poses.`);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [character, charAsset.active?.id, rig, ready]);

  // A motion with no parts gets the body, arms and legs when it is opened (they change nothing until edited).
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    const key = asset.active?.id ?? 'scratch';
    if (!rig || !ready || seededFor.current === key) return;
    seededFor.current = key;
    if (!docRef.current.parts.length) setDoc({ ...docRef.current, parts: defaultParts(rig) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rig, ready, asset.active?.id]);
  /** With the Parts tab showing, a joint clicked in the viewport joins the selected part, or leaves it. */
  const toggleBoneInPart = (name: string) => {
    const d = docRef.current;
    const part = d.parts.find(p => p.id === partId) ?? d.parts[0];
    if (!part) return;
    const has = part.bones.includes(name);
    setDoc({ ...d, parts: d.parts.map(p => (p.id === part.id
      ? { ...p, bones: has ? p.bones.filter(b => b !== name) : [...p.bones, name] }
      : has ? p : { ...p, bones: p.bones.filter(b => b !== name) })) });
    setBone(name);
  };

  // Rebake on every edit: the selected pose held, or the whole motion playing.
  useEffect(() => {
    if (!rig) return;
    const t = setTimeout(() => {
      const stage = stageRef.current;
      if (!stage) return;
      try {
        const motion = bakeMotion(rig, doc);
        setClip(motion);
        if (view === 'pose') stage.show(bakePose(rig, pose), false, 0);
        else if (view === 'clip') { if (sourceClip) stage.playSource(sourceClip); }
        // The preview always loops, so a one-shot can be watched again and again.
        else { stage.show(motion, true); if (!playing) stage.seek(Math.min(time, motion.samplers[0]?.input.at(-1) ?? 0)); }
        publish(motion, doc);
      } catch (e) {
        console.error(e);
        toast.error(String((e as Error)?.message ?? e), { title: 'Bake failed' });
      }
    }, REBAKE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rig, doc, view, pose, sourceClip, asset.name]);
  function publish(motion: BakedClip, from: MotionDoc) {
    const skin = stageRef.current?.skin;
    if (!asset.active || !skin || !ready) return;
    asset.publish({ from, files: exportMotion(from, motion, skin as any, rigName, asset.name) });
  }

  // The playhead, for the scrubber.
  useEffect(() => {
    const id = setInterval(() => { const s = stageRef.current; if (s && view !== 'pose') setTime(s.time()); }, 100);
    return () => clearInterval(id);
  }, [view]);
  const scrub = (t: number) => { if (view === 'pose') setView('motion'); setPlaying(false); stageRef.current?.seek(t); setTime(t); };
  const showSourceClip = (source: string) => { setSourceClip(source); setView('clip'); setPlaying(true); stageRef.current?.playSource(source); };
  const togglePlay = () => {
    if (view === 'pose') { setView('motion'); setPlaying(true); return; }
    if (playing) stageRef.current?.pause(); else stageRef.current?.play();
    setPlaying(!playing);
  };

  const onExport = async () => {
    const skin = stageRef.current?.skin;
    if (!rig || !skin) return;
    const files = await exportJob.run(async () => exportMotion(doc, bakeMotion(rig, doc), skin as any, rigName, asset.name));
    if (!files) return;
    await downloadAll(files);
    toast.success(`Exported ${files.map(f => f.name).join(', ')}.`);
  };

  // The context's callbacks read the latest state through this, so they can stay in a memoised value.
  const live = useRef({ setPose, saveToLibrary, setPoseId });
  live.current = { setPose, saveToLibrary, setPoseId };
  const value = useMemo<MotionState>(() => ({
    doc, setDoc, rig, poseId, setPoseId: id => live.current.setPoseId(id), libraryPoseId, setLibraryPoseId,
    pose, setPose: p => live.current.setPose(p), libraryPoses, saveToLibrary: id => void live.current.saveToLibrary(id),
    bone, setBone, view, setView, clip, time, scrub, playing, togglePlay,
    stageTime: () => stageRef.current?.time() ?? 0,
    keyId, setKeyId, partId, setPartId, setPartsOpen, savedPresets, setSavedPresets,
    character, setCharacter, sourceClip, showSourceClip, sourceAnimations,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [doc, rig, poseId, libraryPoseId, pose, libraryPoses, bone, view, clip, time, playing, keyId, partId, savedPresets, character, sourceClip, sourceAnimations]);

  const duration = clip?.samplers[0]?.input.at(-1) ?? motionDuration(doc);
  const overlay = (<>
    <ViewportOverlay
      readout={rig && <>
        {rigName} · {view === 'pose' ? `Pose “${pose.name}”`
          : view === 'clip' ? `Clip “${character?.clips.find(c => c.source === sourceClip)?.name ?? sourceClip}” ${time.toFixed(2)} s`
          : `Motion ${time.toFixed(2)} / ${duration.toFixed(2)} s`} · {doc.poses.length} poses · {doc.keys.length} keys · {doc.fps} fps
        {clip ? ` · ${clip.channels.length} channels` : ''}
      </>}
      stage={{
        toggles: [
          { key: 'grid', label: 'Grid', checked: stageSettings.grid },
          { key: 'ground', label: 'Floor', checked: stageSettings.ground },
          { key: 'skeleton', label: 'Skeleton', checked: stageSettings.skeleton },
        ].map(item => ({ ...item, onChange: (v: boolean) => setStageSettings({ ...stageSettings, [item.key]: v }) })),
        sun: { yaw: stageSettings.sunYaw, elevation: stageSettings.sunElevation,
               onChange: (sunYaw, sunElevation) => setStageSettings({ ...stageSettings, sunYaw, sunElevation }) },
      }}
      controls={view === 'pose' && <div className='flex items-center gap-2'>
        <Toggle label='Keep lengths' checked={stageSettings.keepLengths} onChange={v => setStageSettings({ ...stageSettings, keepLengths: v })} />
        <Select className='w-24' value={String(stageSettings.chain)} title='How many bones above a dragged joint bend to follow it'
                onChange={e => setStageSettings({ ...stageSettings, chain: Number(e.target.value) })}>
          <option value='0'>Chain: auto</option>
          {[1, 2, 3, 4].map(n => <option key={n} value={n}>Chain: {n}</option>)}
        </Select>
      </div>}
      onFrame={frame} />
    <PoseGizmos instance={instance} scene={scene} bus={bus} viewportRef={viewportRef} stage={stageRef} rig={rig}
                pose={pose} setPose={setPose} bone={bone} setBone={setBone}
                posing={view === 'pose'} startPosing={() => setView('pose')} skeleton={stageSettings.skeleton}
                options={{ chain: stageSettings.chain, keepLengths: stageSettings.keepLengths }}
                onJointPick={partsOpen && doc.parts.length ? toggleBoneInPart : undefined} />
  </>);

  return (
    <MotionCtx.Provider value={value}>
      <CreatorWorkspace
        id='motion' page='creator/motion'
        asset={<AssetBar state={asset} />}
        toolbar={<>
          <Select className='w-40' value={doc.characterId ?? ''} title='The character to animate: the mannequin, or one added with Assets ▸ + Add ▸ Rigged character…'
                  onChange={e => chooseSubject(e.target.value || null)}>
            <option value=''>Mannequin</option>
            {charAsset.assets.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
          <SegmentedControl<View> size='sm' value={view === 'clip' ? 'motion' : view} onChange={v => { setView(v); setPlaying(true); }}
                                  options={[{ value: 'pose', label: 'Pose', title: 'Hold the selected pose while you edit it' },
                                            { value: 'motion', label: 'Motion', title: 'Play the whole motion (Space plays and pauses)' }]} />
        </>}
        toolbarStatus={!rig ? `Loading ${doc.characterId ? 'the character' : 'the mannequin'}…` : undefined}
        primaryAction={{ label: 'Download .anim', disabled: !rig || exportJob.status.running, onClick: onExport,
                         title: 'The baked clip with its skeleton (.anim.json) and a .motion.json sidecar, named after the asset' }}
        left={{ id: 'poses', title: 'Poses', render: () => <PosesPanel /> }}
        right={[
          { id: 'pose', title: 'Pose', render: () => <PosePanel /> },
          { id: 'parts', title: 'Parts', render: () => <PartsPanel /> },
          { id: 'motion', title: 'Motion', render: () => <MotionPanel /> },
        ]}
        bottom={[{ id: 'motionTimeline', title: 'Timeline', render: () => <TimelinePanel /> }]}
        viewport={overlay} viewportRef={viewportRef} onFrame={frame}
        hotkeys={{ ' ': togglePlay }}
        generation={{ status: exportJob.status, onCancel: exportJob.cancel }} />
    </MotionCtx.Provider>
  );
}

// --- Poses (left) -----------------------------------------------------------------------------------

function PosesPanel() {
  const { doc, setDoc, rig, poseId, setPoseId, libraryPoseId, setLibraryPoseId, setView, libraryPoses, saveToLibrary } = useMotion();
  const selected = libraryPoseId ? null : doc.poses.find(p => p.id === poseId) ?? doc.poses[0];
  const libSel = libraryPoseId ? libraryPoses.find(e => e.id === libraryPoseId) ?? null : null;
  const add = (p: MotionPose) => { setDoc({ ...doc, poses: [...doc.poses, p] }); setPoseId(p.id); setView('pose'); };
  const ask = (title: string, defaultValue: string) => promptDialog({ title, defaultValue, validate: v => (v.trim() ? null : 'Give it a name.') });
  const rename = async () => {
    if (!selected) return;
    const name = await ask('Rename pose', selected.name);
    if (!name?.trim()) return;
    // A library pose is renamed in the library: every motion using it follows.
    if (selected.assetId) { await renameCreatorAsset(selected.assetId, name.trim()); return; }
    setDoc({ ...doc, poses: doc.poses.map(p => (p.id === selected.id ? { ...p, name: name.trim() } : p)) });
  };
  const remove = () => {
    if (!selected || doc.poses.length <= 1) return;
    setDoc({ ...doc, poses: doc.poses.filter(p => p.id !== selected.id), keys: doc.keys.filter(k => k.poseId !== selected.id) });
  };
  const usedBy = (id: string) => doc.keys.filter(k => k.poseId === id).length;
  /** A copy of a pose that is the motion's own (a library pose's copy is detached). */
  const ownCopy = (p: MotionPose, name: string): MotionPose => { const { assetId: _, ...rest } = structuredClone(p); return { ...rest, id: newId(), name }; };

  const use = (e: PoseLibraryEntry) => { const r = withAssetPose(doc, e); setDoc(r.doc); setPoseId(r.poseId); setView('pose'); };
  const renameLib = async (e: PoseLibraryEntry) => { const name = await ask('Rename library pose', e.name); if (name?.trim()) await renameCreatorAsset(e.id, name.trim()); };
  const deleteLib = async (e: PoseLibraryEntry) => {
    const ok = await confirmDialog({
      title: `Delete ${e.name}?`, tone: 'danger', confirmLabel: 'Delete',
      message: 'It leaves the library. Motions that use it keep their copy of it, as a pose of their own.',
    });
    if (ok) { await deleteCreatorAsset(e.id); setLibraryPoseId(null); }
  };
  const caption = (p: { bones: Record<string, unknown>; ik?: object }) => `${Object.keys(p.bones).length} bones${p.ik ? ` · IK ${Object.keys(p.ik).length}` : ''}`;

  return (
    <PanelBody>
      <CharacterSection />
      <Collapsable title='This motion' persistKey='cleo_creator_motion_poses'>
        <div className='flex flex-col'>
          {doc.poses.map(p => (
            <div key={p.id} draggable onDragStart={e => { e.dataTransfer.setData(POSE_DRAG_TYPE, p.id); e.dataTransfer.effectAllowed = 'copy'; }}>
              <ListRow selected={p.id === selected?.id} onClick={() => { setPoseId(p.id); setView('pose'); }}
                       title={p.assetId ? 'From the library: editing it changes it in every motion that uses it · drag onto the Timeline' : 'Drag onto the Timeline to add a key with this pose'}
                       caption={`${caption(p)} · ${usedBy(p.id)} keys${p.assetId ? ' · library' : ''}`}>
                {p.assetId ? `⛓ ${p.name}` : p.name}
              </ListRow>
            </div>
          ))}
        </div>
        <div className='flex flex-wrap gap-1 pt-2'>
          <Button size='sm' title='A new pose at rest' onClick={() => add(restPose(`Pose ${doc.poses.length + 1}`))}>New</Button>
          <Button size='sm' disabled={!selected} title='A copy of the selected pose, the motion’s own' onClick={() => selected && add(ownCopy(selected, `${selected.name} copy`))}>Duplicate</Button>
          <Button size='sm' disabled={!selected || !rig} title='The selected pose, left and right swapped' onClick={() => rig && selected && add(mirrorPose(rig, selected))}>Mirror</Button>
          <Button size='sm' disabled={!selected} onClick={() => void rename()}>Rename</Button>
          <Button size='sm' variant='remove' disabled={!selected || doc.poses.length <= 1} title='Delete the pose from the motion, and the keys that use it' onClick={remove}>Delete</Button>
          {selected && !selected.assetId && (
            <Button size='sm' title='Keep the pose in the library: every motion on this character can use it' onClick={() => saveToLibrary(selected.id)}>Save to library</Button>
          )}
          {selected?.assetId && (
            <Button size='sm' title='Stop following the library: the motion keeps this copy as its own' onClick={() => setDoc(makePoseLocal(doc, selected.id))}>Make local</Button>
          )}
        </div>
      </Collapsable>
      <Collapsable title='Library' persistKey='cleo_creator_motion_library_poses'>
        <div className='flex flex-col'>
          {libraryPoses.map(e => (
            <div key={e.id} draggable onDragStart={ev => { ev.dataTransfer.setData(POSE_DRAG_TYPE, libraryDrag(e.id)); ev.dataTransfer.effectAllowed = 'copy'; }}>
              <ListRow selected={e.id === libSel?.id} onClick={() => { setLibraryPoseId(e.id); setView('pose'); }}
                       title='Edit it here · drag onto the Timeline to use it in this motion'
                       caption={`${caption(e.doc.pose)}${doc.poses.some(p => p.assetId === e.id) ? ' · in this motion' : ''}`}>
                {e.name}
              </ListRow>
            </div>
          ))}
        </div>
        {libSel && (
          <div className='flex flex-wrap gap-1 pt-2'>
            <Button size='sm' title='Add it to this motion’s poses (linked: it follows the library)' onClick={() => use(libSel)}>Use in motion</Button>
            <Button size='sm' onClick={() => void renameLib(libSel)}>Rename</Button>
            <Button size='sm' variant='remove' onClick={() => void deleteLib(libSel)}>Delete</Button>
          </div>
        )}
      </Collapsable>
    </PanelBody>
  );
}

// --- Pose (right) -----------------------------------------------------------------------------------

function PosePanel() {
  const { rig, pose, setPose, bone, setBone } = useMotion();
  const [allBones, setAllBones] = useState(false);
  if (!rig) return <PanelBody><span className='text-muted text-ui-sm'>Loading the skeleton…</span></PanelBody>;

  const groups = boneGroups(rig);
  const others = rig.bones.filter(b => b.joint && !groups.some(g => g.bones.includes(b.name))).map(b => b.name);
  const short = (n: string) => n.replace(/^.*[:|]/, '');
  const posed = (n: string) => !!pose.bones[n];
  const selected = bone && rig.byName.has(bone) ? bone : null;
  const entry = selected ? pose.bones[selected] ?? {} : {};
  const rot = entry.rot ?? [0, 0, 0];
  const isHips = selected !== null && rig.byName.get(selected) === rig.hips;
  const move = entry.move ?? [0, 0, 0];
  const range = rig.height * 0.5;
  const setEntry = (next: { rot?: Vec3; move?: Vec3 }) => {
    if (!selected) return;
    const merged = { ...entry, ...next };
    const zero = (v?: Vec3) => !v || v.every(x => Math.abs(x) < 1e-6);
    const bones = { ...pose.bones };
    if (zero(merged.rot) && zero(merged.move)) delete bones[selected];
    else bones[selected] = { ...(zero(merged.rot) ? {} : { rot: merged.rot }), ...(zero(merged.move) ? {} : { move: merged.move }) };
    setPose({ ...pose, bones });
  };
  const setIk = (limb: Limb, goal: IkGoal | null) => {
    const ik = { ...(pose.ik ?? {}) };
    if (goal) ik[limb] = goal; else delete ik[limb];
    // Released: whatever gripped it lets go too.
    if (!goal) for (const l of LIMBS) if (ik[l]?.grip?.follow === limb) { const { grip: _, ...rest } = ik[l]!; ik[l] = rest; }
    setPose({ ...pose, ik: Object.keys(ik).length ? ik : undefined });
  };
  const plant = (limb: Limb) => { const f = limbTipFrame(rig, pose, limb); if (f) setIk(limb, { pos: f.pos }); };

  const boneButton = (n: string) => (
    <ListRow key={n} selected={n === selected} onClick={() => setBone(n)} caption={posed(n) ? 'posed' : undefined}>{short(n)}</ListRow>
  );
  return (
    <PanelBody>
      <PanelHeader kind={pose.assetId ? 'Library pose' : 'Pose'} name={pose.name} onReset={() => setPose({ ...pose, bones: {}, ik: undefined })} />
      <Collapsable title='Bones' persistKey='cleo_creator_motion_bones'>
        {groups.map(g => (
          <div key={g.id} className='pb-1'>
            <div className='text-ui-xs text-dim pt-1'>{g.title}</div>
            {g.bones.map(boneButton)}
          </div>
        ))}
        <Toggle label='Every bone' checked={allBones} onChange={setAllBones} />
        {allBones && others.map(boneButton)}
      </Collapsable>
      <Collapsable title='Rotation' persistKey='cleo_creator_motion_rotation'>
        {selected ? (<>
          <div className='text-ui-sm pb-1'>{short(selected)}</div>
          {(['X', 'Y', 'Z'] as const).map((axis, i) => (
            <Slider key={axis} label={`${axis} (°)`} min={-180} max={180} step={0.5} readout value={rot[i]}
                    onChange={v => { const r: Vec3 = [...rot]; r[i] = v; setEntry({ rot: r }); }} />
          ))}
          {isHips && (['X', 'Y', 'Z'] as const).map((axis, i) => (
            <Slider key={`m${axis}`} label={`Move ${axis} (m)`} min={-range} max={range} step={0.005} readout value={move[i]}
                    onChange={v => { const m: Vec3 = [...move]; m[i] = v; setEntry({ move: m }); }} />
          ))}
          <div className='flex gap-1 pt-1'>
            <Button size='sm' onClick={() => setEntry({ rot: [0, 0, 0], move: [0, 0, 0] })}>Reset bone</Button>
          </div>
        </>) : <span className='text-muted text-ui-sm'>Pick a bone above, or a joint in the viewport.</span>}
      </Collapsable>
      <Collapsable title='IK' persistKey='cleo_creator_motion_ik'>
        {LIMBS.map(limb => {
          const goal = pose.ik?.[limb];
          const other = LIMB_MIRROR[limb];
          const isHand = limb === 'handL' || limb === 'handR';
          const holdRot = (on: boolean) => {
            if (!goal) return;
            const { rot: _, ...rest } = goal;
            setIk(limb, on ? { ...rest, rot: limbTipFrame(rig, pose, limb)?.rot ?? [0, 0, 0] } : rest);
          };
          const aim = (on: boolean) => {
            if (!goal) return;
            const { pole: _, ...rest } = goal;
            if (!on) { setIk(limb, rest); return; }
            // Start where the joint already points: out from the line between the limb's root and tip.
            const [r, m, t] = LIMB_CHAINS[limb].map(slot => rig.bySlot.get(slot));
            if (r === undefined || m === undefined || t === undefined) return;
            const p = modelPose(rig.bones, solvedPoseLocals(rig, pose)).pos;
            const out = [0, 1, 2].map(i => p[m][i] - (p[r][i] + p[t][i]) / 2);
            const len = Math.hypot(out[0], out[1], out[2]) || 1;
            const r3 = (v: number) => Math.round(v * 1000) / 1000;
            setIk(limb, { ...rest, pole: [0, 1, 2].map(i => r3(p[m][i] + out[i] / len * 0.3)) as Vec3 });
          };
          const grip = (on: boolean) => {
            if (!goal) return;
            const { grip: _, ...rest } = goal;
            if (!on) { setIk(limb, rest); return; }
            // The other hand leads: planted where it is (with its turn held) if it was free.
            let next = pose;
            if (!pose.ik?.[other]) { const f = limbTipFrame(rig, pose, other); if (f) next = { ...pose, ik: { ...pose.ik, [other]: { pos: f.pos, rot: f.rot } } }; }
            const g = gripFrom(rig, next, limb, other);
            if (g) setPose({ ...next, ik: { ...next.ik, [limb]: { ...rest, grip: g } } });
          };
          return (
            <div key={limb} className='pt-1'>
              <div className='flex items-center gap-2'>
                <span className='flex-1 text-ui-sm'>{LIMB_LABELS[limb]}</span>
                {goal
                  ? <Button size='sm' onClick={() => setIk(limb, null)}>Release</Button>
                  : <Button size='sm' title='Plant the goal where the limb is now' onClick={() => plant(limb)}>Plant</Button>}
              </div>
              {goal && !goal.grip && (['X', 'Y', 'Z'] as const).map((axis, i) => (
                <Slider key={axis} label={`${axis} (m)`} min={-rig.height} max={rig.height} step={0.005} readout value={goal.pos[i]}
                        onChange={v => { const p: Vec3 = [...goal.pos]; p[i] = v; setIk(limb, { ...goal, pos: p }); }} />
              ))}
              {goal && !goal.grip && <Toggle label='Hold rotation' checked={!!goal.rot} onChange={holdRot} />}
              {goal?.rot && !goal.grip && (['X', 'Y', 'Z'] as const).map((axis, i) => (
                <Slider key={`r${axis}`} label={`Turn ${axis} (°)`} min={-180} max={180} step={0.5} readout value={goal.rot![i]}
                        onChange={v => { const r: Vec3 = [...goal.rot!]; r[i] = v; setIk(limb, { ...goal, rot: r }); }} />
              ))}
              {goal && <Toggle label={isHand ? 'Point the elbow' : 'Point the knee'} checked={!!goal.pole} onChange={aim} />}
              {goal?.pole && (['X', 'Y', 'Z'] as const).map((axis, i) => (
                <Slider key={`p${axis}`} label={`${isHand ? 'Elbow' : 'Knee'} toward ${axis} (m)`} min={-rig.height} max={rig.height} step={0.005} readout value={goal.pole![i]}
                        onChange={v => { const q: Vec3 = [...goal.pole!]; q[i] = v; setIk(limb, { ...goal, pole: q }); }} />
              ))}
              {goal && isHand && !pose.ik?.[other]?.grip && (
                <Toggle label={`Grip with the ${LIMB_LABELS[other].toLowerCase()}`} checked={!!goal.grip} onChange={grip} />
              )}
              {goal?.grip && (['X', 'Y', 'Z'] as const).map((axis, i) => (
                <Slider key={`g${axis}`} label={`Grip ${axis} (m)`} min={-0.4} max={0.4} step={0.0025} readout value={goal.grip!.offset[i]}
                        onChange={v => { const o: Vec3 = [...goal.grip!.offset]; o[i] = v; setIk(limb, { ...goal, grip: { ...goal.grip!, offset: o } }); }} />
              ))}
            </div>
          );
        })}
      </Collapsable>
    </PanelBody>
  );
}

// --- Motion (right) ---------------------------------------------------------------------------------

function MotionPanel() {
  const { doc, setDoc } = useMotion();
  return (
    <PanelBody>
      <Collapsable title='Feel' persistKey='cleo_creator_motion_feel'>
        <Slider label='Overlap (s / joint)' min={0} max={0.12} step={0.005} readout value={doc.overlap} onChange={v => setDoc({ ...doc, overlap: v })} />
        <Slider label='Variation (°)' min={0} max={10} step={0.1} readout value={doc.variation} onChange={v => setDoc({ ...doc, variation: v })} />
        <Slider label='Variation rate (Hz)' min={0.05} max={3} step={0.05} readout value={doc.variationRate} onChange={v => setDoc({ ...doc, variationRate: v })} />
        <div className='flex items-center gap-2 pt-1'>
          <span className='text-ui-sm text-muted'>Seed</span>
          <NumberInput className='w-24' value={doc.seed} onChange={v => setDoc({ ...doc, seed: Math.max(0, Math.floor(v)) })} />
        </div>
      </Collapsable>
      <Collapsable title='Clip' persistKey='cleo_creator_motion_clip'>
        <Slider label='Frames per second' min={10} max={60} step={1} readout value={doc.fps} onChange={v => setDoc({ ...doc, fps: Math.round(v) })} />
      </Collapsable>
    </PanelBody>
  );
}

// --- Character (left) ---------------------------------------------------------------------------------

/** The Character's own clips: preview, rename, hide, delete, and a pose from any frame. */
function CharacterSection() {
  const { doc, setDoc, rig, setPoseId, setView, view, character, setCharacter, sourceClip, showSourceClip,
          sourceAnimations, time, scrub } = useMotion();
  if (!character) return null;
  const clipLength = (source: string) => sourceAnimations.find(a => a.name === source)?.samplers.reduce((m, s) => Math.max(m, s.input[s.input.length - 1] ?? 0), 0) ?? 0;
  const setClip = (id: string, patch: Partial<CharacterDoc['clips'][number]>) =>
    setCharacter({ ...character, clips: character.clips.map(c => (c.id === id ? { ...c, ...patch } : c)) });
  const rename = async (id: string, current: string) => {
    const name = await promptDialog({ title: 'Rename clip', defaultValue: current });
    if (name?.trim()) setClip(id, { name: name.trim() });
  };
  const fromFrame = () => {
    const a = sourceAnimations.find(x => x.name === sourceClip);
    if (!rig || !a) return;
    const clipName = character.clips.find(c => c.source === sourceClip)?.name ?? sourceClip;
    const p = poseFromClip(rig, a, time, `${clipName} @ ${time.toFixed(2)}s`);
    setDoc({ ...doc, poses: [...doc.poses, p] });
    setPoseId(p.id);
    setView('pose');
  };
  const length = sourceClip ? clipLength(sourceClip) : 0;
  return (
    <Collapsable title='Clips' persistKey='cleo_creator_motion_character_clips'>
      {character.clips.length === 0 && <span className='text-ui-xs text-dim'>The file has no clips.</span>}
      {character.clips.map(c => (
        <ListRow key={c.id} selected={view === 'clip' && sourceClip === c.source} onClick={() => showSourceClip(c.source)}
                 caption={`${clipLength(c.source).toFixed(2)} s${c.hidden ? ' · hidden' : ''}${c.name !== c.source ? ` · ${c.source}` : ''}`}
                 actions={<>
                   <Button size='icon' variant='ghost' title={c.hidden ? 'Send this clip to the editor again' : 'Keep this clip out of the editor'}
                           onClick={() => setClip(c.id, { hidden: !c.hidden })}>{c.hidden ? '◌' : '●'}</Button>
                   <Button size='icon' variant='ghost' title='Rename' onClick={() => void rename(c.id, c.name)}>✎</Button>
                   <Button size='icon' variant='remove' title='Delete the clip (the uploaded file keeps it)'
                           onClick={() => setCharacter({ ...character, clips: character.clips.filter(x => x.id !== c.id) })}>✕</Button>
                 </>}>
          <span className={c.hidden ? 'text-dim' : undefined}>{c.name}</span>
        </ListRow>
      ))}
      {view === 'clip' && sourceClip && (<>
        <Slider label='Frame (s)' min={0} max={Math.max(0.01, length)} step={1 / 60} readout value={Math.min(time, length)} onChange={scrub} />
        <Button size='sm' className='mt-1' disabled={!rig} title='The clip at this frame, as a new pose of the motion' onClick={fromFrame}>Pose from frame</Button>
      </>)}
    </Collapsable>
  );
}
