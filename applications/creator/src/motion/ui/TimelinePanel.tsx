import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Collapsable, NumberInput, Select, Toggle } from '@cleo/app-kit/ui';
import { clampZoom, fitZoom, formatTick, rulerTicks, snapToFps, timeToX, xToTime, zoomStep } from '@cleo/app-kit/timeline';
import { promptDialog } from '@cleo/app-kit/feedback/dialogStore';
import {
  BUILTIN_PRESETS, cloneCurve, evalBlend, presetOf, storeSavedPresets, toKeys, type BlendCurve, type BlendPreset,
} from '../blendCurve';
import { motionDuration, newId, presetBlend, type MotionDoc, type MotionKey, type PartBlend } from '../motionDoc';
import { resolvePartBlend } from '../parts';
import { withAssetPose } from '../poseAsset';
import { BlendCurveEditor, blendPath } from './BlendCurveEditor';
import { POSE_DRAG_TYPE, useMotion } from './motionContext';
import { PartBlendFields } from './PartsPanel';

// The Motion Creator's timeline, docked under the viewport: the motion as a row of POSES on a time ruler,
// and under it the BLEND into each one -- the curve the Creator follows from the previous pose to the
// arriving one, drawn across the gap, so the motion's whole shape reads at a glance (a step is a hold, a
// bump over the top line an overshoot, a wobble a spring).
//
//   keys       a key: a pose at a time. Click to select (the stage holds that pose), drag to retime,
//              double-click empty track or drop a pose from the Poses list to add one, Delete to remove.
//   base       the keys' own blends. Click one to edit it on the right: pick a preset, then shape it
//              (bezier handles, spring swings and damping, or free-form keys); save it as a preset.
//   parts      one lane per body part (parts.ts): the curve each part follows into each key, moved by its
//              offset. A key's override draws solid, an inherited blend faded; click one to edit it.

const GUTTER = 14;
const LABEL_W = 76;
const RULER_H = 22, TRACK_H = 34, LANE_H = 76, PART_H = 18;
const ZOOM_KEY = 'cleo_creator_motion_zoom';
// The blend lane's band: the previous pose at the bottom line, the arriving one at the top line, room above
// and below for overshoot and anticipation.
const laneY = (v: number) => LANE_H - 22 - v * (LANE_H - 44);
/** A part lane's band, the same way, smaller. */
const partY = (v: number) => PART_H - 4 - v * (PART_H - 8);

const poseColor = (i: number) => `hsl(${(i * 67 + 200) % 360} 55% 58%)`;
const allPresets = (saved: BlendPreset[]) => [...BUILTIN_PRESETS, ...saved];
const editable = (t: EventTarget) => /^(INPUT|TEXTAREA|SELECT)$/.test((t as HTMLElement).tagName);

export function TimelinePanel() {
  const {
    doc, setDoc, poseId, setPoseId, libraryPoseId, libraryPoses, view, setView, keyId, setKeyId, partId, setPartId,
    playing, togglePlay, scrub, stageTime, clip, savedPresets,
  } = useMotion();
  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<SVGCircleElement>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const [pxPerSec, setPxPerSec] = useState(() => Number(localStorage.getItem(ZOOM_KEY)) || 180);
  useEffect(() => { try { localStorage.setItem(ZOOM_KEY, String(pxPerSec)); } catch { /* quota */ } }, [pxPerSec]);

  const keys = doc.keys;
  const parts = doc.parts;
  const duration = motionDuration(doc);
  const end = Math.max(duration, clip?.samplers[0]?.input.at(-1) ?? 0, 0.5);
  const fps = doc.fps;
  const snap = (t: number) => snapToFps(t, fps);
  const x = (t: number) => timeToX(t, pxPerSec, GUTTER);
  const tAt = (clientX: number) => {
    const el = scrollRef.current!;
    return xToTime(clientX, el.getBoundingClientRect().left, el.scrollLeft, pxPerSec, GUTTER);
  };
  const width = x(end) + 120;
  const height = RULER_H + TRACK_H + LANE_H + parts.length * PART_H;
  const sel = keys.find(k => k.id === keyId) ?? keys[Math.min(1, keys.length - 1)];

  const fit = () => {
    const w = scrollRef.current?.clientWidth ?? 600;
    setPxPerSec(fitZoom(w, end, GUTTER, 40));
  };
  // The first time the panel opens on a motion that does not fit, fit it.
  useLayoutEffect(() => { if (x(end) > (scrollRef.current?.clientWidth ?? Infinity)) fit(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The playhead (and its dot on the blend lane) follow the stage every frame, without re-rendering.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const t = view === 'motion' ? stageTime() : view === 'pose' ? (sel?.time ?? 0) : null;
      const ph = playheadRef.current, dot = dotRef.current;
      if (ph) { ph.style.display = t === null ? 'none' : ''; if (t !== null) ph.style.left = `${x(t)}px`; }
      if (dot) {
        const ks = docRef.current.keys;
        const k = t === null ? -1 : ks.findIndex((key, i) => i > 0 && t <= key.time && t >= ks[i - 1].time);
        if (k > 0 && t !== null) {
          const span = ks[k].time - ks[k - 1].time;
          dot.style.display = '';
          dot.setAttribute('cx', String(x(t)));
          dot.setAttribute('cy', String(laneY(evalBlend(ks[k].blend, span > 1e-9 ? (t - ks[k - 1].time) / span : 1))));
        } else dot.style.display = 'none';
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }); // every render: it reads the latest zoom and selection

  // --- Editing keys ---
  const setKeys = (next: MotionKey[], base: MotionDoc = docRef.current) => setDoc({ ...base, keys: next });
  const patchKey = (id: string, patch: Partial<MotionKey>) => setKeys(docRef.current.keys.map(k => (k.id === id ? { ...k, ...patch } : k)));
  const select = (k: MotionKey) => { setKeyId(k.id); setPoseId(k.poseId); setView('pose'); };
  /** A key at `t` with a motion pose, or with a library pose (`asset:<id>`: the motion links it first). */
  const addKey = (t: number, pose: string) => {
    let base = docRef.current, id = pose;
    if (pose.startsWith('asset:')) {
      const entry = libraryPoses.find(e => e.id === pose.slice(6));
      if (!entry) return;
      ({ doc: base, poseId: id } = withAssetPose(base, entry));
    }
    const time = snap(t);
    if (base.keys.some(k => Math.abs(k.time - time) < 0.5 / fps)) return;
    const key: MotionKey = { id: newId(), poseId: id, time, ...presetBlend() };
    setKeys([...base.keys, key], base);
    setKeyId(key.id);
    setPoseId(id);
  };
  /** The pose a new key takes: the library pose being edited, else the selected motion pose. */
  const currentPose = libraryPoseId ? `asset:${libraryPoseId}` : poseId;
  const removeKey = (id: string) => {
    if (docRef.current.keys.length <= 1) return;
    setKeys(docRef.current.keys.filter(k => k.id !== id));
    if (keyId === id) setKeyId(null);
  };
  const dragChip = (e: React.PointerEvent, k: MotionKey, index: number) => {
    e.stopPropagation();
    select(k);
    // The first key starts the motion: it stays at 0.
    if (index === 0) return;
    const startX = e.clientX, t0 = k.time;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < 3) return;
      moved = true;
      const time = Math.max(1 / fps, snap(t0 + (ev.clientX - startX) / pxPerSec));
      patchKey(k.id, { time });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const scrubFrom = (e: React.PointerEvent) => {
    const go = (clientX: number) => scrub(Math.min(end, snap(tAt(clientX))));
    go(e.clientX);
    const move = (ev: PointerEvent) => go(ev.clientX);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editable(e.target)) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); removeKey(sel.id); }
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setPxPerSec(p => zoomStep(p, e.deltaY));
  };

  // --- The ruler's ticks ---
  const ticks = rulerTicks(0, end, pxPerSec);

  const poseIndex = (id: string) => doc.poses.findIndex(p => p.id === id);
  const poseName = (id: string) => doc.poses.find(p => p.id === id)?.name ?? '?';
  const presetName = (k: MotionKey) => presetOf(k.blend, allPresets(savedPresets))?.name ?? 'Custom';
  const selPart = parts.find(p => p.id === partId) ?? null;

  const label = (text: string, h: number, color?: string, onClick?: () => void, selected?: boolean) => (
    <div className={`flex items-center gap-1 truncate border-b border-border/40 px-1.5 text-ui-xs ${selected ? 'text-fg' : 'text-dim'} ${onClick ? 'cursor-pointer hover:text-fg' : ''}`}
         style={{ height: h }} onClick={onClick} title={text}>
      {color && <span className='inline-block h-2 w-2 shrink-0 rounded-full' style={{ background: color }} />}
      <span className='truncate'>{text}</span>
    </div>
  );

  return (
    <div className='flex h-full min-h-0 flex-col outline-none' tabIndex={0} onKeyDown={onKeyDown}>
      <div className='flex shrink-0 items-center gap-2 border-b border-border px-2 py-1'>
        <Button size='sm' onClick={togglePlay} title='Play or pause the motion (Space)'>{view !== 'pose' && playing ? 'Pause' : 'Play'}</Button>
        <span className='w-28 text-ui-xs tabular-nums text-muted'>{(view === 'motion' ? stageTime() : sel?.time ?? 0).toFixed(2)} / {duration.toFixed(2)} s</span>
        <Toggle label='Loop' checked={doc.loop} onChange={v => setDoc({ ...doc, loop: v })} />
        <Button size='sm' title='Add a key with the selected pose at the playhead'
                onClick={() => addKey(view === 'motion' ? stageTime() : duration + 0.5, currentPose)}>+ Key</Button>
        <div className='flex-1' />
        <span className='text-ui-xs text-dim'>Ctrl+wheel zooms</span>
        <Button size='sm' onClick={() => setPxPerSec(p => clampZoom(p / 1.4))} title='Zoom out'>−</Button>
        <Button size='sm' onClick={() => setPxPerSec(p => clampZoom(p * 1.4))} title='Zoom in'>+</Button>
        <Button size='sm' onClick={fit} title='Fit the motion in the panel'>Fit</Button>
      </div>
      <div className='flex min-h-0 flex-1'>
        <div className='min-w-0 flex-1 overflow-y-auto'>
          <div className='flex'>
            {/* Lane names */}
            <div className='shrink-0 border-r border-border' style={{ width: LABEL_W }}>
              <div style={{ height: RULER_H }} className='border-b border-border bg-surface-raised' />
              {label('Keys', TRACK_H)}
              {label('Base', LANE_H, undefined, () => setPartId(null), !selPart)}
              {parts.map(p => <div key={p.id}>{label(p.name, PART_H, p.color, () => setPartId(p.id), p.id === selPart?.id)}</div>)}
            </div>
            <div ref={scrollRef} className='relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden' onWheel={onWheel}>
              <div className='relative' style={{ width, height }}>
                {/* Ruler */}
                <div className='absolute inset-x-0 top-0 cursor-ew-resize border-b border-border bg-surface-raised'
                     style={{ height: RULER_H }} onPointerDown={scrubFrom}>
                  {ticks.map(({ t, major: big }) => (
                    <div key={t.toFixed(4)} className='absolute bottom-0 border-l border-border' style={{ left: x(t), height: big ? 10 : 5 }}>
                      {big && <span className='absolute -top-3 left-1 text-[9px] tabular-nums text-dim'>{formatTick(t)}</span>}
                    </div>
                  ))}
                  <div className='absolute bottom-0 top-0 bg-primary/10' style={{ left: x(duration), width: Math.max(0, x(end) - x(duration)) }}
                       title='The overlap tail: the trailing joints arriving after the last key' />
                </div>
                {/* Keys */}
                <div className='absolute inset-x-0' style={{ top: RULER_H, height: TRACK_H }}
                     onDoubleClick={e => addKey(tAt(e.clientX), currentPose)}
                     onDragOver={e => { if (e.dataTransfer.types.includes(POSE_DRAG_TYPE)) e.preventDefault(); }}
                     onDrop={e => { const id = e.dataTransfer.getData(POSE_DRAG_TYPE); if (id) { e.preventDefault(); addKey(tAt(e.clientX), id); } }}
                     title='Double-click to add a key with the selected pose · drop a pose from the Poses list'>
                  {keys.map((k, i) => (
                    <div key={k.id} onPointerDown={e => dragChip(e, k, i)} onDoubleClick={e => e.stopPropagation()}
                         title={`${poseName(k.poseId)} at ${k.time.toFixed(2)} s${i ? ' · drag to retime' : ' · the first key starts the motion'}`}
                         className={`absolute top-1 flex h-[26px] -translate-x-1/2 items-center gap-1 rounded px-1.5 text-ui-xs text-black shadow ${i ? 'cursor-grab' : 'cursor-pointer'} ${k.id === sel?.id ? 'ring-2 ring-fg' : ''}`}
                         style={{ left: x(k.time), background: poseColor(poseIndex(k.poseId)), maxWidth: 140 }}>
                      <span className='truncate'>{poseName(k.poseId)}</span>
                    </div>
                  ))}
                </div>
                {/* Base: the keys' own blends */}
                <svg className='absolute left-0' style={{ top: RULER_H + TRACK_H, height: LANE_H }} width={width} height={LANE_H}>
                  <line x1={0} x2={width} y1={laneY(0)} y2={laneY(0)} stroke='currentColor' className='text-border' />
                  <line x1={0} x2={width} y1={laneY(1)} y2={laneY(1)} stroke='currentColor' className='text-border' strokeDasharray='2 3' />
                  {keys.map((k, i) => {
                    if (i === 0) return null;
                    const x0 = x(keys[i - 1].time), w = x(k.time) - x0;
                    const selected = k.id === sel?.id && !selPart;
                    return (
                      <g key={k.id} className='cursor-pointer' onPointerDown={() => { setKeyId(k.id); setPartId(null); }}>
                        <rect x={x0} y={2} width={Math.max(1, w)} height={LANE_H - 4} rx={3} fill='currentColor'
                              className={selected ? 'text-primary' : 'text-surface-raised'} fillOpacity={selected ? 0.18 : 0.6} />
                        <path d={blendPath(k.blend, x0, w, laneY)} fill='none' stroke={poseColor(poseIndex(k.poseId))} strokeWidth={selected ? 2.5 : 1.75} />
                        {w > 70 && <text x={x0 + 4} y={LANE_H - 6} className='fill-current text-dim' style={{ fontSize: 9 }}>{presetName(k)}</text>}
                      </g>
                    );
                  })}
                  <circle ref={dotRef} r={4} className='fill-current text-warning' style={{ display: 'none' }} />
                </svg>
                {/* Parts: each part's blends, moved by its offsets; a key's override solid, an inherited one faded */}
                {parts.length > 0 && (
                  <svg className='absolute left-0' style={{ top: RULER_H + TRACK_H + LANE_H, height: parts.length * PART_H }} width={width} height={parts.length * PART_H}>
                    {parts.map((p, pi) => {
                      const resolved = keys.map(k => resolvePartBlend(k, p));
                      return (
                        <g key={p.id} transform={`translate(0 ${pi * PART_H})`}>
                          <line x1={0} x2={width} y1={PART_H - 0.5} y2={PART_H - 0.5} stroke='currentColor' className='text-border' strokeOpacity={0.4} />
                          {keys.map((k, i) => {
                            if (i === 0) return null;
                            const r = resolved[i];
                            const x0 = x(keys[i - 1].time + resolved[i - 1].offset), w = Math.max(1, x(k.time + r.offset) - x0);
                            const selected = k.id === sel?.id && p.id === selPart?.id;
                            return (
                              <g key={k.id} className='cursor-pointer' onPointerDown={() => { setKeyId(k.id); setPartId(p.id); }}>
                                <title>{`${p.name} into ${poseName(k.poseId)}: ${r.overridden ? 'this key’s own blend' : 'inherited'}`}</title>
                                <rect x={x0} y={1} width={w} height={PART_H - 2} rx={2} fill='currentColor'
                                      className={selected ? 'text-primary' : 'text-surface-raised'} fillOpacity={selected ? 0.25 : 0.35} />
                                <path d={blendPath(r.blend, x0, w, partY, 32)} fill='none' stroke={p.color}
                                      strokeWidth={selected ? 2 : 1.5} strokeOpacity={r.overridden ? 1 : 0.45} strokeDasharray={r.overridden ? undefined : '3 2'} />
                              </g>
                            );
                          })}
                        </g>
                      );
                    })}
                  </svg>
                )}
                <div ref={playheadRef} className='pointer-events-none absolute top-0 w-px bg-warning' style={{ height }} />
              </div>
            </div>
          </div>
        </div>
        <div className='w-[300px] shrink-0 overflow-y-auto border-l border-border p-2'>
          {sel && <KeyInspector k={sel} index={keys.indexOf(sel)} patchKey={patchKey} removeKey={removeKey} />}
        </div>
      </div>
    </div>
  );
}

function KeyInspector({ k, index, patchKey, removeKey }: {
  k: MotionKey; index: number;
  patchKey: (id: string, patch: Partial<MotionKey>) => void;
  removeKey: (id: string) => void;
}) {
  const { doc, setDoc, setPoseId, view, time, savedPresets, setSavedPresets, partId, setPartId } = useMotion();
  const presets = allPresets(savedPresets);
  const prev = doc.keys[index - 1];
  const setBlend = (blend: BlendCurve) => patchKey(k.id, { blend, presetId: presetOf(blend, presets)?.id });
  const pick = (id: string) => { const p = presets.find(x => x.id === id); if (p) patchKey(k.id, { blend: cloneCurve(p.curve), presetId: p.id }); };
  const saveAsPreset = async () => {
    const name = await promptDialog({ title: 'Save blend preset', defaultValue: 'My blend' });
    if (!name?.trim()) return;
    const preset: BlendPreset = { id: `user_${newId()}`, name: name.trim(), curve: cloneCurve(k.blend) };
    const next = [...savedPresets, preset];
    setSavedPresets(next);
    storeSavedPresets(next);
    patchKey(k.id, { presetId: preset.id });
  };
  const deletePreset = () => {
    const next = savedPresets.filter(p => p.id !== k.presetId);
    setSavedPresets(next);
    storeSavedPresets(next);
    patchKey(k.id, { presetId: undefined });
  };
  const applyToAll = () => setDoc({ ...doc, keys: doc.keys.map((x, i) => (i === 0 ? x : { ...x, blend: cloneCurve(k.blend), presetId: k.presetId })) });
  const matched = presetOf(k.blend, presets);
  const span = prev ? k.time - prev.time : 0;
  const marker = prev && view === 'motion' && time >= prev.time && time <= k.time && span > 0 ? (time - prev.time) / span : undefined;
  const isSaved = !!k.presetId && savedPresets.some(p => p.id === k.presetId);

  // --- This key's overrides of the parts ---
  const part = doc.parts.find(p => p.id === partId) ?? doc.parts[0] ?? null;
  const over = part ? k.parts?.[part.id] : undefined;
  const setOver = (next: PartBlend | undefined) => {
    if (!part) return;
    const rest = { ...(k.parts ?? {}) };
    if (next) rest[part.id] = next; else delete rest[part.id];
    patchKey(k.id, { parts: Object.keys(rest).length ? rest : undefined });
  };
  const resolved = part ? resolvePartBlend(k, part) : null;
  const overrideOn = (on: boolean) => {
    if (!on || !resolved) { setOver(undefined); return; }
    setOver(index ? { blend: cloneCurve(resolved.blend), ...(resolved.presetId ? { presetId: resolved.presetId } : {}) } : { offset: resolved.offset });
  };
  const partToAll = () => {
    if (!part) return;
    setDoc({ ...doc, keys: doc.keys.map((x, i) => {
      if (i === 0) return x;
      const rest = { ...(x.parts ?? {}) };
      if (over) rest[part.id] = structuredClone(over); else delete rest[part.id];
      return { ...x, parts: Object.keys(rest).length ? rest : undefined };
    }) });
  };

  return (<>
    <Collapsable title='Key' persistKey='cleo_creator_motion_key'>
      <div className='flex items-center gap-1'>
        <span className='w-12 text-ui-sm text-muted'>Pose</span>
        <Select className='flex-1' value={k.poseId} onChange={e => { patchKey(k.id, { poseId: e.target.value }); setPoseId(e.target.value); }}>
          {doc.poses.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </div>
      <div className='flex items-center gap-1 pt-1'>
        <span className='w-12 text-ui-sm text-muted'>Time</span>
        <NumberInput className='w-20' value={k.time} step={1 / doc.fps} disabled={index === 0}
                     onChange={v => patchKey(k.id, { time: Math.max(index === 0 ? 0 : 1 / doc.fps, v) })} />
        <span className='text-ui-xs text-dim'>s</span>
        <div className='flex-1' />
        <Button size='sm' variant='remove' disabled={doc.keys.length <= 1} onClick={() => removeKey(k.id)} title='Delete the key (Delete)'>Delete</Button>
      </div>
    </Collapsable>
    <Collapsable title='Blend' persistKey='cleo_creator_motion_blend'>
      {index === 0 ? <span className='text-ui-xs text-dim'>The first key starts the motion: nothing blends into it.</span> : (<>
        <div className='pb-1 text-ui-xs text-dim'>From “{doc.poses.find(p => p.id === prev.poseId)?.name}” into “{doc.poses.find(p => p.id === k.poseId)?.name}”</div>
        <div className='flex items-center gap-1 pb-1'>
          <span className='w-12 text-ui-sm text-muted'>Preset</span>
          <Select className='flex-1' value={matched?.id ?? ''} onChange={e => pick(e.target.value)}>
            {!matched && <option value=''>Custom</option>}
            <optgroup label='Built-in'>{BUILTIN_PRESETS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
            {savedPresets.length > 0 && <optgroup label='Saved'>{savedPresets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>}
          </Select>
        </div>
        <BlendCurveEditor curve={k.blend} onChange={setBlend} marker={marker} />
        <div className='flex flex-wrap gap-1 pt-2'>
          {k.blend.type !== 'keys' && <Button size='sm' onClick={() => setBlend(toKeys(k.blend))} title='Turn the curve into keys to draw it by hand'>Free-form</Button>}
          <Button size='sm' onClick={saveAsPreset} title='Keep this curve as a preset for every motion'>Save as preset…</Button>
          <Button size='sm' onClick={applyToAll} title='Use this curve for every blend of the motion'>Apply to all</Button>
          {isSaved && <Button size='sm' variant='remove' onClick={deletePreset} title='Delete the saved preset (blends using it keep their curve)'>Delete preset</Button>}
        </div>
      </>)}
    </Collapsable>
    <Collapsable title='Parts' persistKey='cleo_creator_motion_key_parts'>
      {!part || !resolved ? <span className='text-ui-xs text-dim'>The motion has no parts: add them in the Parts tab.</span> : (<>
        <div className='flex items-center gap-1 pb-1'>
          <span className='w-12 text-ui-sm text-muted'>Part</span>
          <Select className='flex-1' value={part.id} onChange={e => setPartId(e.target.value)}>
            {doc.parts.map(p => <option key={p.id} value={p.id}>{p.name}{k.parts?.[p.id] ? ' · overridden' : ''}</option>)}
          </Select>
        </div>
        <Toggle label='Override' checked={!!over} onChange={overrideOn} />
        {over && (<>
          <PartBlendFields value={over} presets={presets} curve={index > 0}
                           inherited={{ label: part.defaults?.blend ? 'The part’s default' : 'The key’s blend',
                                        offset: part.defaults?.offset ?? 0, overlap: part.defaults?.overlap ?? doc.overlap, variation: part.defaults?.variation ?? 1 }}
                           onChange={setOver} />
          <div className='flex flex-wrap gap-1 pt-2'>
            <Button size='sm' onClick={partToAll} title={`Give every key this override of ${part.name}`}>Apply to all</Button>
          </div>
        </>)}
      </>)}
    </Collapsable>
  </>);
}
