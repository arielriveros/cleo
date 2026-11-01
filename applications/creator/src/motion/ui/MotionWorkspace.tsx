import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Collapsable, NumberInput, SegmentedControl, Select, Slider, TextInput, Toggle } from '@cleo/app-kit/ui';
import { toast } from '@cleo/app-kit/feedback/toastStore';
import { promptDialog } from '@cleo/app-kit/feedback/dialogStore';
import { useCreatorEngine } from '../../app/CreatorEngine';
import { CreatorWorkspace, ListRow, PanelBody, PanelHeader, ViewportOverlay } from '../../app/workspace';
import { downloadAll } from '../../core/download';
import { AssetBar, useCreatorAsset } from '../../core/useCreatorAsset';
import { useStageCapture } from '../../core/stageCapture';
import { useGeneration } from '../../core/useGeneration';
import { frameBox, installOrbitCamera } from '../../fx/ui/fxPreview';
import { bakeMotion, bakePose, limbTip, mirrorPose, poseFromClip, type BakedClip } from '../bakeMotion';
import { exportCharacter, normaliseCharacter, type CharacterDoc } from '../character';
import type { CreatorFile } from '@cleo/app-kit/creatorLibrary';
import type { ExportFile } from '../../core/generator';
import type { Animation } from 'cleo/animation/animatedModel';
import { exportMotion } from '../exportMotion';
import {
  DEFAULT_MOTION, LIMB_LABELS, LIMBS, motionDuration, newId, normaliseMotion, restPose,
  type Limb, type MotionDoc, type MotionPose, type Vec3,
} from '../motionDoc';
import { loadSavedPresets, type BlendPreset } from '../blendCurve';
import { MotionCtx, POSE_DRAG_TYPE, useMotion, type MotionState, type View } from './motionContext';
import { TimelinePanel } from './TimelinePanel';
import { PoseGizmos } from './PoseGizmos';
import type { MotionRig } from '../motionRig';
import { DEFAULT_MOTION_STAGE, MotionStage, type MotionStageSettings } from './motionStage';

// Motion Creator: a character animated from a few key POSES. Pose the mannequin bone by bone (or plant a
// hand or foot with IK and let the limb bend to it), mirror poses left to right, then lay the poses on a
// timeline with a blend curve into each. The bake adds overlapping action and a little life, and the clip
// goes to the editor as an ordinary `.anim` -- retargetable onto every humanoid there.
//
// Layout (app/workspace.tsx): Character and Poses on the left; Pose and Motion (feel, clip) on the right;
// the Timeline (TimelinePanel.tsx) under the viewport, beside Assets and Console. The viewport plays the
// whole motion, holds the selected pose while it is being edited, or plays one of the character's own
// clips, with the skeleton drawn over it.
//
// The subject is the mannequin or a CHARACTER: a rigged model uploaded with Assets ▸ + Add ▸ Rigged
// character… (motion/characterImport.ts). A character keeps its file's clips -- renamed, hidden or dropped
// here, and synced to the editor as `.anim` assets -- and a pose library of its own, which any frame of
// those clips can start (Pose from frame) and every motion on the character can draw from.

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
  const [stageSettings, setStageSettings] = useState<MotionStageSettings>(() => load(STAGE_KEY, DEFAULT_MOTION_STAGE, raw => ({ ...DEFAULT_MOTION_STAGE, ...(raw as object) })));
  const [rig, setRig] = useState<MotionRig | null>(null);
  const [poseId, setPoseId] = useState(doc.poses[0].id);
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
  const [savedPresets, setSavedPresets] = useState<BlendPreset[]>(loadSavedPresets);

  const setDoc = (d: MotionDoc) => setDocState(normaliseMotion(d));
  useEffect(() => { const t = setTimeout(() => save(DOC_KEY, doc), 250); return () => clearTimeout(t); }, [doc]);
  useEffect(() => { save(STAGE_KEY, stageSettings); stageRef.current?.apply(stageSettings); }, [stageSettings]);
  // The bone picked in the Pose tab is the one highlighted on the skeleton.
  useEffect(() => { stageRef.current?.setSelectedBone(view === 'pose' ? bone : null); }, [bone, view, rig]);
  // The selected pose survives edits; a deleted one falls back to the first.
  useEffect(() => { if (!doc.poses.some(p => p.id === poseId)) setPoseId(doc.poses[0].id); }, [doc, poseId]);

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
    setRig(null);
    s.load(charFiles ?? undefined).then(r => {
      if (!alive) return;
      setSourceAnimations(s.sourceAnimations());
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

  // Rebake on every edit: the selected pose held, or the whole motion playing.
  const pose = doc.poses.find(p => p.id === poseId) ?? doc.poses[0];
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
  }, [rig, doc, view, poseId, sourceClip]);

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

  // --- The saved asset ---
  const capture = useStageCapture();
  const asset = useCreatorAsset<MotionDoc>('motion', doc, d => setDoc(normaliseMotion(d)), () => {}, capture);
  const rigName = character?.name ?? 'Mannequin';
  function publish(motion: BakedClip, from: MotionDoc) {
    const skin = stageRef.current?.skin;
    if (!asset.active || !skin) return;
    asset.publish({ from, files: exportMotion(from, motion, skin as any, rigName) });
  }

  // --- The Character: a second saved asset, whose private files are the uploaded model ---
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
    setSourceClip(null);
    if (view === 'clip') setView('pose');
    if (!id) { setCharacterState(null); setCharFiles(null); void charAsset.open(null); setDoc({ ...doc, characterId: undefined }); return; }
    setCharFiles(null);
    setDoc({ ...doc, characterId: id });
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
  // Its clips and poses follow every edit to the editor.
  useEffect(() => {
    const s = stageRef.current;
    if (!character || !charAsset.active || !rig || !s?.skin || !charFiles) return;
    charAsset.publish({ from: character, files: exportCharacter(character, rig, s.skin as any, sourceAnimations), privateFiles: charBytes.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [character, rig]);
  const onExport = async () => {
    const skin = stageRef.current?.skin;
    if (!rig || !skin) return;
    const files = await exportJob.run(async () => exportMotion(doc, bakeMotion(rig, doc), skin as any, rigName));
    if (!files) return;
    await downloadAll(files);
    toast.success(`Exported ${files.map(f => f.name).join(', ')}.`);
  };

  const duration = clip?.samplers[0]?.input.at(-1) ?? motionDuration(doc);
  const value = useMemo<MotionState>(() => ({
    doc, setDoc, rig, poseId, setPoseId, bone, setBone, view, setView, clip, time, scrub, playing, togglePlay,
    stageTime: () => stageRef.current?.time() ?? 0,
    onExport, exporting: exportJob.status.running, keyId, setKeyId, savedPresets, setSavedPresets,
    character, setCharacter, sourceClip, showSourceClip, sourceAnimations,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [doc, rig, poseId, bone, view, clip, time, playing, exportJob.status.running, keyId, savedPresets, character, sourceClip, sourceAnimations]);

  const setPose = (next: MotionPose) => setDoc({ ...doc, poses: doc.poses.map(p => (p.id === next.id ? next : p)) });
  const overlay = (<>
    <ViewportOverlay
      readout={rig && <>
        {rigName} · {view === 'pose' ? `Pose “${pose.name}”`
          : view === 'clip' ? `Clip “${character?.clips.find(c => c.source === sourceClip)?.name ?? sourceClip}” ${time.toFixed(2)} s`
          : `Motion ${time.toFixed(2)} / ${duration.toFixed(2)} s`} · {doc.poses.length} poses · {doc.keys.length} keys
        {clip ? ` · ${clip.channels.length} channels` : ''}
      </>}
      visibility={[
        { key: 'grid', label: 'Grid', checked: stageSettings.grid },
        { key: 'ground', label: 'Floor', checked: stageSettings.ground },
        { key: 'skeleton', label: 'Skeleton', checked: stageSettings.skeleton },
      ].map(item => ({ ...item, onChange: (v: boolean) => setStageSettings({ ...stageSettings, [item.key]: v }) }))}
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
                options={{ chain: stageSettings.chain, keepLengths: stageSettings.keepLengths }} />
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
                                            { value: 'motion', label: 'Motion', title: 'Play the whole motion' }]} />
          <Button size='sm' onClick={togglePlay} title='Play or pause the motion (Space)'>{view !== 'pose' && playing ? 'Pause' : 'Play'}</Button>
        </>}
        toolbarStatus={!rig ? `Loading ${doc.characterId ? 'the character' : 'the mannequin'}…` : undefined}
        primaryAction={{ label: 'Download .anim', disabled: !rig || exportJob.status.running, onClick: onExport,
                         title: 'The baked clip with its skeleton (.anim.json) and a .motion.json sidecar' }}
        left={{ id: 'poses', title: 'Poses', render: () => <PosesPanel /> }}
        right={[
          { id: 'pose', title: 'Pose', render: () => <PosePanel /> },
          { id: 'motion', title: 'Motion', render: () => <MotionPanel /> },
        ]}
        bottom={[{ id: 'motionTimeline', title: 'Timeline', render: () => <TimelinePanel /> }]}
        viewport={overlay} viewportRef={viewportRef} onFrame={frame}
        hotkeys={{ ' ': togglePlay }}
        generation={{ status: exportJob.status, onCancel: exportJob.cancel,
                      idle: `Motion “${doc.name}”: ${doc.poses.length} poses, ${doc.keys.length} keys, ${duration.toFixed(2)} s at ${doc.fps} fps` }} />
    </MotionCtx.Provider>
  );
}

// --- Poses (left) -----------------------------------------------------------------------------------

function PosesPanel() {
  const { doc, setDoc, rig, poseId, setPoseId, setView } = useMotion();
  const pose = doc.poses.find(p => p.id === poseId) ?? doc.poses[0];
  const add = (p: MotionPose) => { setDoc({ ...doc, poses: [...doc.poses, p] }); setPoseId(p.id); setView('pose'); };
  const rename = async () => {
    const name = await promptDialog({ title: 'Rename pose', defaultValue: pose.name });
    if (name?.trim()) setDoc({ ...doc, poses: doc.poses.map(p => (p.id === pose.id ? { ...p, name: name.trim() } : p)) });
  };
  const remove = () => {
    if (doc.poses.length <= 1) return;
    setDoc({ ...doc, poses: doc.poses.filter(p => p.id !== pose.id), keys: doc.keys.filter(k => k.poseId !== pose.id) });
  };
  const usedBy = (id: string) => doc.keys.filter(k => k.poseId === id).length;
  return (
    <PanelBody>
      <PanelHeader kind='Motion' name={doc.name} onReset={() => { setDoc({ ...DEFAULT_MOTION, characterId: doc.characterId }); }} />
      <CharacterSection />
      <Collapsable title='Poses' persistKey='cleo_creator_motion_poses'>
        <div className='flex flex-col'>
          {doc.poses.map(p => (
            <div key={p.id} draggable onDragStart={e => { e.dataTransfer.setData(POSE_DRAG_TYPE, p.id); e.dataTransfer.effectAllowed = 'copy'; }}>
              <ListRow selected={p.id === pose.id} onClick={() => { setPoseId(p.id); setView('pose'); }}
                       title='Drag onto the Timeline to add a key with this pose'
                       caption={`${Object.keys(p.bones).length} bones${p.ik ? ` · IK ${Object.keys(p.ik).length}` : ''} · ${usedBy(p.id)} keys`}>
                {p.name}
              </ListRow>
            </div>
          ))}
        </div>
        <div className='flex flex-wrap gap-1 pt-2'>
          <Button size='sm' title='A copy of the selected pose to change' onClick={() => add({ ...structuredClone(pose), id: newId(), name: `${pose.name} copy` })}>Duplicate</Button>
          <Button size='sm' title='The selected pose, left and right swapped' disabled={!rig} onClick={() => rig && add(mirrorPose(rig, pose))}>Mirror</Button>
          <Button size='sm' title='A new pose at rest' onClick={() => add(restPose(`Pose ${doc.poses.length + 1}`))}>New</Button>
          <Button size='sm' onClick={rename}>Rename</Button>
          <Button size='sm' variant='remove' disabled={doc.poses.length <= 1} title='Delete the pose and the keys that use it' onClick={remove}>Delete</Button>
        </div>
      </Collapsable>
    </PanelBody>
  );
}

// --- Pose (right) -----------------------------------------------------------------------------------

/** The bones offered first, by humanoid slot, in body order. */
const BONE_GROUPS: { title: string; slots: string[] }[] = [
  { title: 'Body', slots: ['hips', 'spine', 'chest', 'neck', 'head'] },
  { title: 'Left arm', slots: ['shoulder.L', 'upperArm.L', 'foreArm.L', 'hand.L'] },
  { title: 'Right arm', slots: ['shoulder.R', 'upperArm.R', 'foreArm.R', 'hand.R'] },
  { title: 'Left leg', slots: ['upLeg.L', 'leg.L', 'foot.L', 'toe.L'] },
  { title: 'Right leg', slots: ['upLeg.R', 'leg.R', 'foot.R', 'toe.R'] },
];

function PosePanel() {
  const { doc, setDoc, rig, poseId, bone, setBone } = useMotion();
  const [allBones, setAllBones] = useState(false);
  const pose = doc.poses.find(p => p.id === poseId) ?? doc.poses[0];
  if (!rig) return <PanelBody><span className='text-muted text-ui-sm'>Loading the mannequin…</span></PanelBody>;
  const setPose = (next: MotionPose) => setDoc({ ...doc, poses: doc.poses.map(p => (p.id === next.id ? next : p)) });

  // Spine bones: every humanoid "spine"/"chest" in the chain, not only the first.
  const groups = BONE_GROUPS.map(g => ({
    title: g.title,
    bones: g.slots.flatMap(slot => (slot === 'spine' || slot === 'chest')
      ? rig.bones.filter(b => b.slot === slot).map(b => b.name)
      : rig.bySlot.has(slot) ? [rig.bones[rig.bySlot.get(slot)!].name] : []),
  })).filter(g => g.bones.length);
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
  const setIk = (limb: Limb, pos: Vec3 | null) => {
    const ik = { ...(pose.ik ?? {}) };
    if (pos) ik[limb] = { pos }; else delete ik[limb];
    setPose({ ...pose, ik: Object.keys(ik).length ? ik : undefined });
  };

  const boneButton = (n: string) => (
    <ListRow key={n} selected={n === selected} onClick={() => setBone(n)} caption={posed(n) ? 'posed' : undefined}>{short(n)}</ListRow>
  );
  return (
    <PanelBody>
      <PanelHeader kind='Pose' name={pose.name} onReset={() => setPose({ ...pose, bones: {}, ik: undefined })} />
      <Collapsable title='Bones' persistKey='cleo_creator_motion_bones'>
        <div className='pb-1 text-ui-xs text-dim'>Or in the viewport: drag a joint to pose it; the rings turn the selected bone.</div>
        {groups.map(g => (
          <div key={g.title} className='pb-1'>
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
        </>) : <span className='text-muted text-ui-sm'>Pick a bone above.</span>}
      </Collapsable>
      <Collapsable title='IK' persistKey='cleo_creator_motion_ik'>
        <span className='text-ui-xs text-dim'>Plant a hand or foot: the limb bends to reach its goal, and stays there while the body moves.</span>
        {LIMBS.map(limb => {
          const goal = pose.ik?.[limb];
          return (
            <div key={limb} className='pt-1'>
              <div className='flex items-center gap-2'>
                <span className='flex-1 text-ui-sm'>{LIMB_LABELS[limb]}</span>
                {goal
                  ? <Button size='sm' onClick={() => setIk(limb, null)}>Release</Button>
                  : <Button size='sm' title='Plant the goal where the limb is now' onClick={() => { const p = limbTip(rig, pose, limb); if (p) setIk(limb, p); }}>Plant</Button>}
              </div>
              {goal && (['X', 'Y', 'Z'] as const).map((axis, i) => (
                <Slider key={axis} label={`${axis} (m)`} min={-rig.height} max={rig.height} step={0.005} readout value={goal.pos[i]}
                        onChange={v => { const p: Vec3 = [...goal.pos]; p[i] = v; setIk(limb, p); }} />
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
  const { doc, setDoc, onExport, exporting } = useMotion();
  return (
    <PanelBody>
      <PanelHeader kind='Motion' name={doc.name} />
      <span className='text-ui-xs text-dim'>Keys and their blends are on the Timeline, under the viewport.</span>
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
        <div className='flex items-center gap-2'>
          <span className='text-ui-sm text-muted w-20'>Name</span>
          <TextInput className='flex-1' value={doc.name} onChange={v => setDoc({ ...doc, name: v })} />
        </div>
        <Slider label='Frames per second' min={10} max={60} step={1} readout value={doc.fps} onChange={v => setDoc({ ...doc, fps: Math.round(v) })} />
        <Toggle label='Loop' checked={doc.loop} onChange={v => setDoc({ ...doc, loop: v })} />
        <Button size='sm' className='mt-1' disabled={exporting} onClick={onExport}>Download .anim</Button>
      </Collapsable>
    </PanelBody>
  );
}

// --- Character (left) ---------------------------------------------------------------------------------

/** The Character's own clips (preview, rename, hide, delete, pose from frame) and its pose library. */
function CharacterSection() {
  const { doc, setDoc, rig, poseId, setPoseId, setView, view, character, setCharacter, sourceClip, showSourceClip,
          sourceAnimations, time, scrub } = useMotion();
  if (!character) return null;
  const pose = doc.poses.find(p => p.id === poseId) ?? doc.poses[0];
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
  const usePose = (p: CharacterDoc['poses'][number]) => {
    const copy = { ...structuredClone(p), id: newId() };
    setDoc({ ...doc, poses: [...doc.poses, copy] });
    setPoseId(copy.id);
    setView('pose');
  };
  const renamePose = async (id: string, current: string) => {
    const name = await promptDialog({ title: 'Rename pose', defaultValue: current });
    if (name?.trim()) setCharacter({ ...character, poses: character.poses.map(p => (p.id === id ? { ...p, name: name.trim() } : p)) });
  };
  const length = sourceClip ? clipLength(sourceClip) : 0;
  return (<>
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
    <Collapsable title='Character poses' persistKey='cleo_creator_motion_character_poses'>
      {character.poses.length === 0 && <span className='text-ui-xs text-dim'>Save poses here to use them in every motion on this character.</span>}
      {character.poses.map(p => (
        <ListRow key={p.id} onClick={() => usePose(p)} title='Add a copy to this motion' caption={`${Object.keys(p.bones).length} bones`}
                 actions={<>
                   <Button size='icon' variant='ghost' title='Rename' onClick={() => void renamePose(p.id, p.name)}>✎</Button>
                   <Button size='icon' variant='remove' title='Delete from the character'
                           onClick={() => setCharacter({ ...character, poses: character.poses.filter(x => x.id !== p.id) })}>✕</Button>
                 </>}>
          {p.name}
        </ListRow>
      ))}
      <Button size='sm' className='mt-1' title='Keep the selected pose in the character, for every motion on it'
              onClick={() => setCharacter({ ...character, poses: [...character.poses, { ...structuredClone(pose), id: newId() }] })}>
        Save “{pose.name}” to character
      </Button>
    </Collapsable>
  </>);
}
