import { useEffect, useMemo, useState } from 'react';
import { Button, Collapsable, Select, Slider, Toggle } from '@cleo/app-kit/ui';
import { confirmDialog, promptDialog } from '@cleo/app-kit/feedback/dialogStore';
import { ListRow, PanelBody } from '../../app/workspace';
import { BUILTIN_PRESETS, cloneCurve, presetOf, type BlendCurve, type BlendPreset } from '../blendCurve';
import { newId, PART_COLORS, type MotionPart, type PartBlend } from '../motionDoc';
import { boneGroups, defaultParts } from '../parts';
import { BlendCurveEditor } from './BlendCurveEditor';
import { useMotion } from './motionContext';

// The Parts tab (right dock): the motion's body-part groups -- each a set of bones that arrives at the keys
// its own way (parts.ts) -- their bones, and how each arrives by default. A key overrides a part's default
// for the blend into it, in the Timeline's Key inspector; the timeline draws every part's blends as a lane
// under the keys. While this tab shows, clicking a joint in the viewport adds its bone to the selected part
// (or takes it out).

/** What an unset field of a part blend takes: the curve's label, and the numbers. */
export interface PartBlendInherited { label: string; offset: number; overlap: number; variation: number }

/**
 * A part blend's fields -- curve, offset, overlap, life -- each set or inherited (dim, ↺ to go back to
 * inheriting). The part's defaults and a key's override edit the same way.
 */
export function PartBlendFields({ value, inherited, onChange, curve = true, presets, baseCurve }: {
  value: PartBlend | undefined;
  inherited: PartBlendInherited;
  onChange: (next: PartBlend | undefined) => void;
  /** Show the curve (a first key has no blend into it). */
  curve?: boolean;
  presets: BlendPreset[];
  /** The curve inherited, drawn when none is set. */
  baseCurve?: BlendCurve;
}) {
  const v = value ?? {};
  const set = (patch: Partial<PartBlend>) => {
    const next: PartBlend = { ...v, ...patch };
    for (const k of Object.keys(next) as (keyof PartBlend)[]) if (next[k] === undefined) delete next[k];
    onChange(Object.keys(next).length ? next : undefined);
  };
  const matched = v.blend ? presetOf(v.blend, presets) : undefined;
  const pick = (id: string) => {
    if (!id) { set({ blend: undefined, presetId: undefined }); return; }
    const p = presets.find(x => x.id === id);
    if (p) set({ blend: cloneCurve(p.curve), presetId: p.id });
  };
  const saved = presets.filter(p => !BUILTIN_PRESETS.includes(p));
  return (<>
    {curve && (<>
      <div className='flex items-center gap-1 pb-1'>
        <span className='w-14 text-ui-sm text-muted'>Curve</span>
        <Select className='flex-1' value={v.blend ? (matched?.id ?? 'custom') : ''} onChange={e => pick(e.target.value)}>
          <option value=''>{inherited.label}</option>
          {v.blend && !matched && <option value='custom'>Custom</option>}
          <optgroup label='Built-in'>{BUILTIN_PRESETS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
          {saved.length > 0 && <optgroup label='Saved'>{saved.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>}
        </Select>
      </div>
      {v.blend ? <BlendCurveEditor curve={v.blend} onChange={c => set({ blend: c, presetId: presetOf(c, presets)?.id })} />
        : baseCurve && <div className='pointer-events-none opacity-50'><BlendCurveEditor curve={baseCurve} onChange={() => {}} /></div>}
    </>)}
    <InheritSlider label='Offset (s)' min={-1} max={1} step={0.01} value={v.offset} fallback={inherited.offset} onChange={offset => set({ offset })} />
    <InheritSlider label='Overlap (s / joint)' min={0} max={0.12} step={0.005} value={v.overlap} fallback={inherited.overlap} onChange={overlap => set({ overlap })} />
    <InheritSlider label='Life' min={0} max={3} step={0.05} value={v.variation} fallback={inherited.variation} onChange={variation => set({ variation })} />
  </>);
}

/** A slider that shows the inherited value dimmed until it is set, with ↺ back to inheriting. */
function InheritSlider({ label, min, max, step, value, fallback, onChange }: {
  label: string; min: number; max: number; step: number; value: number | undefined; fallback: number; onChange: (v: number | undefined) => void;
}) {
  return (
    <div className='flex items-center gap-1'>
      <Slider className='flex-1' label={label} min={min} max={max} step={step} readout value={value ?? fallback} onChange={onChange}
              labelClassName={value === undefined ? 'text-dim' : undefined} />
      <Button size='icon' variant='ghost' disabled={value === undefined} title='Inherit again' onClick={() => onChange(undefined)}>↺</Button>
    </div>
  );
}

export function PartsPanel() {
  const { doc, setDoc, rig, partId, setPartId, setPartsOpen, savedPresets } = useMotion();
  const [everyBone, setEveryBone] = useState(false);
  // Open: a joint clicked in the viewport joins or leaves the selected part.
  useEffect(() => { setPartsOpen(true); return () => setPartsOpen(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const owner = useMemo(() => {
    const m = new Map<string, MotionPart>();
    for (const p of doc.parts) for (const b of p.bones) if (!m.has(b)) m.set(b, p);
    return m;
  }, [doc.parts]);
  if (!rig) return <PanelBody><span className='text-muted text-ui-sm'>Loading the skeleton…</span></PanelBody>;

  const part = doc.parts.find(p => p.id === partId) ?? doc.parts[0] ?? null;
  const setParts = (parts: MotionPart[]) => setDoc({ ...doc, parts });
  const patch = (id: string, change: Partial<MotionPart>) => setParts(doc.parts.map(p => (p.id === id ? { ...p, ...change } : p)));
  const add = async () => {
    const name = await promptDialog({ title: 'New part', defaultValue: `Part ${doc.parts.length + 1}`, validate: v => (v.trim() ? null : 'Give the part a name.') });
    if (!name?.trim()) return;
    const p: MotionPart = { id: newId(), name: name.trim(), color: PART_COLORS[doc.parts.length % PART_COLORS.length], bones: [] };
    setParts([...doc.parts, p]);
    setPartId(p.id);
  };
  const rename = async (p: MotionPart) => {
    const name = await promptDialog({ title: 'Rename part', defaultValue: p.name, validate: v => (v.trim() ? null : 'Give the part a name.') });
    if (name?.trim()) patch(p.id, { name: name.trim() });
  };
  const reset = async () => {
    const ok = await confirmDialog({
      title: 'Reset the parts?', confirmLabel: 'Reset', tone: 'danger',
      message: 'The body, arms and legs come back with no blends of their own; parts you added, and the keys’ overrides of them, go.',
    });
    if (ok) { setDoc({ ...doc, parts: defaultParts(rig), keys: doc.keys.map(({ parts: _, ...k }) => k) }); setPartId(null); }
  };
  /** The bone joins the selected part (leaving any other), or leaves it. */
  const toggle = (bone: string) => {
    if (!part) return;
    const has = part.bones.includes(bone);
    setParts(doc.parts.map(p => (p.id === part.id
      ? { ...p, bones: has ? p.bones.filter(b => b !== bone) : [...p.bones, bone] }
      : has ? p : { ...p, bones: p.bones.filter(b => b !== bone) })));
  };

  const groups = boneGroups(rig);
  const grouped = new Set(groups.flatMap(g => g.bones));
  const others = rig.bones.filter(b => b.joint && !grouped.has(b.name)).map(b => b.name);
  const short = (n: string) => n.replace(/^.*[:|]/, '');
  const boneRow = (n: string) => {
    const o = owner.get(n);
    const mine = !!part && o?.id === part.id;
    return (
      <ListRow key={n} onClick={() => toggle(n)} title={mine ? `In ${part!.name}: click to take it out` : `Click to put it in ${part?.name}`}
               leading={<Toggle checked={mine} onChange={() => toggle(n)} />}
               caption={o && !mine ? o.name : undefined}
               actions={o && !mine ? <span className='inline-block h-2 w-2 rounded-full' style={{ background: o.color }} /> : undefined}>
        {short(n)}
      </ListRow>
    );
  };

  return (
    <PanelBody>
      <Collapsable title='Parts' persistKey='cleo_creator_motion_parts'>
        <div className='flex flex-col'>
          {doc.parts.map(p => (
            <ListRow key={p.id} selected={p.id === part?.id} onClick={() => setPartId(p.id)}
                     leading={<input type='color' className='h-4 w-5 cursor-pointer border-0 bg-transparent p-0' value={p.color} title='Its lane colour on the timeline'
                                     onChange={e => patch(p.id, { color: e.target.value })} />}
                     caption={`${p.bones.length} bones${p.defaults ? ' · own blend' : ''}`}
                     actions={<>
                       <Button size='icon' variant='ghost' title='Rename' onClick={() => void rename(p)}>✎</Button>
                       <Button size='icon' variant='remove' title='Delete the part: its bones follow the keys’ blends again'
                               onClick={() => setParts(doc.parts.filter(x => x.id !== p.id))}>✕</Button>
                     </>}>
              {p.name}
            </ListRow>
          ))}
        </div>
        <div className='flex flex-wrap gap-1 pt-2'>
          <Button size='sm' onClick={() => void add()}>+ Part</Button>
          <Button size='sm' variant='ghost' onClick={() => void reset()}>Reset to defaults</Button>
        </div>
      </Collapsable>
      {part && (<>
        <Collapsable title='Membership' persistKey='cleo_creator_motion_part_bones'>
          {groups.map(g => (
            <div key={g.id} className='pb-1'>
              <div className='pt-1 text-ui-xs text-dim'>{g.title}</div>
              {g.bones.map(boneRow)}
            </div>
          ))}
          <Toggle label='Every bone' checked={everyBone} onChange={setEveryBone} />
          {everyBone && others.map(boneRow)}
        </Collapsable>
        <Collapsable title='Defaults' persistKey='cleo_creator_motion_part_defaults'>
          <PartBlendFields value={part.defaults} presets={[...BUILTIN_PRESETS, ...savedPresets]}
                           inherited={{ label: 'Each key’s blend', offset: 0, overlap: doc.overlap, variation: 1 }}
                           onChange={defaults => patch(part.id, { defaults })} />
        </Collapsable>
      </>)}
    </PanelBody>
  );
}
