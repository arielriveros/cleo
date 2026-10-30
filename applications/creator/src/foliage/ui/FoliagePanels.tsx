import { useEffect, useMemo, useState } from 'react';
import { ParamForm } from '@cleo/app-kit/params/ParamForm';
import type { GenericParamSpec } from '@cleo/app-kit/params/ParamField';
import { Button, Collapsable, FileButton, PresetMenu, TextInput } from '@cleo/app-kit/ui';
import { toast } from '@cleo/app-kit/feedback/toastStore';
import { OVERRIDE_SLOTS, TEXTURE_LABELS, type TextureKey } from '../buildFoliage';
import {
  DEFAULT_GRASS, DEFAULT_ROCK, DEFAULT_TREE, FOLIAGE_SCHEMAS, KIND_LABELS, formValues, fromForm, type FoliageGroup, type FoliageKind,
} from '../foliageParams';
import { applyPreset, presetsFor, type FoliagePreset } from '../foliagePresets';
import type { StageSettings } from './foliageStage';
import { useFoliage } from './foliageContext';

// The Foliage Creator's dock panels. Parameters, LOD and Export share the right dock as tabs (the FX
// Creator's Parameters / Bake split); Variants is the left dock.

const DEFAULTS: Record<FoliageKind, object> = { grass: DEFAULT_GRASS, rock: DEFAULT_ROCK, tree: DEFAULT_TREE };

/** LOD 0 triangle counts above which a level is flagged: foliage is drawn thousands of times. */
const LOD0_BUDGET: Record<FoliageKind, number> = { grass: 1500, rock: 6000, tree: 20000 };

function Groups({ groups, persist }: { groups: FoliageGroup[]; persist: string }) {
  const { doc, setParams } = useFoliage();
  const params = doc[doc.kind];
  const values = formValues(params);
  return (<>
    {groups.map(group => (
      <Collapsable key={group.title} title={group.title} persistKey={`cleo_creator_foliage_${persist}_${doc.kind}_${group.title}`}>
        <ParamForm schema={group.specs} values={values} onChange={patch => setParams(fromForm(params, patch))} />
      </Collapsable>
    ))}
  </>);
}

/** Right dock: the shape and look of the current kind. */
export function ParametersPanel() {
  const { doc, setDoc } = useFoliage();
  const apply = (p: FoliagePreset) => setDoc({ ...doc, [p.kind]: applyPreset(p), name: p.id });
  const reset = () => { setDoc({ ...doc, [doc.kind]: DEFAULTS[doc.kind] }); toast.success(`${KIND_LABELS[doc.kind]} reset to its defaults.`); };
  return (
    <div className='p-2 overflow-auto h-full'>
      <div className='flex items-center gap-2 pb-1'>
        <span className='flex-1 min-w-0 truncate text-ui-sm text-muted'>{KIND_LABELS[doc.kind]} · <span className='text-fg'>{doc.name}</span></span>
        <Button size='sm' variant='ghost' onClick={reset}>Reset</Button>
        <PresetMenu label={`${KIND_LABELS[doc.kind]} presets`} presets={presetsFor(doc.kind)} onApply={apply} />
      </div>
      <Groups groups={FOLIAGE_SCHEMAS[doc.kind].filter(g => !g.side)} persist='params' />
    </div>
  );
}

/** Right dock tab: the level ladder, what each level costs, and the impostor. */
export function LodPanel() {
  const { doc, build, impostorPreview, bakeImpostorPreview, exporting } = useFoliage();
  const levels = build?.summary.levels ?? [];
  const budget = LOD0_BUDGET[doc.kind];
  return (
    <div className='p-2 overflow-auto h-full flex flex-col gap-2'>
      <Groups groups={FOLIAGE_SCHEMAS[doc.kind].filter(g => g.side === 'lod')} persist='lod' />
      <Collapsable title='Level costs' persistKey='cleo_creator_foliage_lod_costs'>
        <table className='w-full text-ui-sm tabular-nums'>
          <thead className='text-muted'>
            <tr><th className='text-left font-normal'>Level</th><th className='text-right font-normal'>From</th><th className='text-right font-normal'>Triangles</th><th className='text-right font-normal'>Vertices</th><th className='text-right font-normal'>Parts</th></tr>
          </thead>
          <tbody>
            {levels.map((l, i) => (
              <tr key={i}>
                <td>LOD {i}</td>
                <td className='text-right'>{l.distance} m</td>
                <td className={`text-right ${i === 0 && l.triangles > budget ? 'text-warning' : ''}`}>{l.triangles.toLocaleString()}</td>
                <td className='text-right'>{l.vertices.toLocaleString()}</td>
                <td className='text-right'>{l.parts}</td>
              </tr>
            ))}
            {build?.summary.impostor && (
              <tr><td>Impostor</td><td className='text-right'>{build.summary.impostor.distance} m</td><td className='text-right'>2</td><td className='text-right'>4</td><td className='text-right'>1</td></tr>
            )}
            {build && <tr className='text-muted'><td>Culled</td><td className='text-right'>{build.summary.cullDistance} m</td><td /><td /><td /></tr>}
          </tbody>
        </table>
        {levels[0] && levels[0].triangles > budget && (
          <p className='text-ui-xs text-warning pt-1'>
            LOD 0 is over {budget.toLocaleString()} triangles. A foliage layer draws it many times and stores every level in the scene; fewer branches, cards or blades will scale better.
          </p>
        )}
      </Collapsable>
      {doc.kind === 'tree' && doc.tree.impostor && (
        <Collapsable title='Impostor atlas' persistKey='cleo_creator_foliage_lod_impostor'>
          <p className='text-ui-xs text-muted pb-1'>
            Baked from LOD 2 (the level it replaces), {doc.tree.impostorFrames}×{doc.tree.impostorFrames} views. Exported beside the .glb files.
          </p>
          <Button size='sm' disabled={exporting || !build} onClick={bakeImpostorPreview}>Bake preview</Button>
          {impostorPreview && (
            <div className='grid grid-cols-2 gap-2 pt-2'>
              <img src={impostorPreview.albedoUrl} className='w-full cleo-texture-checker' title='Albedo + coverage' />
              <img src={impostorPreview.normalUrl} className='w-full' title='Normal + AO' />
            </div>
          )}
        </Collapsable>
      )}
    </div>
  );
}

/** Object URLs for the build's generated PNGs, revoked when the build changes. */
function useGeneratedUrls(): Partial<Record<TextureKey, string>> {
  const { build } = useFoliage();
  const urls = useMemo(() => {
    const out: Partial<Record<TextureKey, string>> = {};
    if (build) for (const [k, bytes] of Object.entries(build.files.pngs) as [TextureKey, Uint8Array][])
      out[k] = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
    return out;
  }, [build]);
  useEffect(() => () => { for (const u of Object.values(urls)) if (u) URL.revokeObjectURL(u); }, [urls]);
  return urls;
}

/** Right dock tab: the file name, texture sizes and overrides, and the download. */
export function ExportPanel() {
  const { doc, setDoc, build, overrides, setOverride, exporting, onExport } = useFoliage();
  const urls = useGeneratedUrls();
  const slots = OVERRIDE_SLOTS[doc.kind];
  const generatedOnly = (Object.keys(urls) as TextureKey[]).filter(k => !slots.some(s => s.key === k));
  const stem = doc.name.trim().replace(/\s+/g, '_') || 'foliage';
  const impostor = doc.kind === 'tree' && doc.tree.impostor;
  return (
    <div className='p-2 overflow-auto h-full flex flex-col gap-2'>
      <Collapsable title='File' persistKey='cleo_creator_foliage_export_file'>
        <div className='flex items-center gap-2'>
          <span className='text-muted text-ui-sm w-16'>Name</span>
          <TextInput value={doc.name} onChange={name => setDoc({ ...doc, name })} />
        </div>
        <ul className='text-ui-xs text-muted pt-2 font-mono'>
          {[0, 1, 2].map(i => <li key={i}>{stem}_LOD{i}.glb</li>)}
          {impostor && <><li>{stem}_impostor_albedo.png</li><li>{stem}_impostor_normal.png</li></>}
          <li>{stem}.foliage.json</li>
        </ul>
      </Collapsable>
      <Groups groups={FOLIAGE_SCHEMAS[doc.kind].filter(g => g.side === 'export')} persist='export' />
      <Collapsable title='Texture overrides' persistKey='cleo_creator_foliage_export_overrides'>
        <div className='flex flex-col gap-2'>
          {slots.map(slot => {
            const o = overrides[slot.key];
            const src = o?.url ?? urls[slot.key];
            return (
              <div key={slot.key} className='flex gap-2 items-start'>
                <div className='w-16 h-16 shrink-0 cleo-texture-checker border border-border'>
                  {src && <img src={src} className='w-full h-full object-cover' />}
                </div>
                <div className='flex-1 min-w-0'>
                  <div className='text-ui-sm'>{slot.label} {o && <span className='text-muted'>· {o.fileName}</span>}</div>
                  <div className='text-ui-xs text-muted'>{slot.hint}</div>
                  <div className='flex gap-1 pt-1'>
                    <FileButton accept='image/*' onFiles={files => files[0] && setOverride(slot.key, files[0])}>Replace…</FileButton>
                    {o && <Button size='sm' variant='ghost' onClick={() => setOverride(slot.key, null)}>Use generated</Button>}
                  </div>
                </div>
              </div>
            );
          })}
          {generatedOnly.map(k => (
            <div key={k} className='flex gap-2 items-center'>
              <div className='w-16 h-16 shrink-0 cleo-texture-checker border border-border'><img src={urls[k]} className='w-full h-full object-cover' /></div>
              <div className='text-ui-sm'>{TEXTURE_LABELS[k]} <span className='text-ui-xs text-muted'>· generated from the above</span></div>
            </div>
          ))}
        </div>
      </Collapsable>
      <div className='flex items-center gap-2 pt-1'>
        <Button variant='primary' disabled={exporting || !build} onClick={onExport}>Download</Button>
        <span className='text-ui-xs text-muted'>Import the .glb files in the Editor, then set LOD 1 and 2 as the LOD 0 model's levels.</span>
      </div>
    </div>
  );
}

const STAGE_SPECS: GenericParamSpec[] = [
  { key: 'sunYaw', label: 'Sun direction', kind: 'float', min: -180, max: 180, step: 1, unit: '°' },
  { key: 'sunElevation', label: 'Sun elevation', kind: 'float', min: -10, max: 90, step: 1, unit: '°', hint: 'Low and behind the plant shows its translucency.' },
  { key: 'sunLux', label: 'Sun illuminance', kind: 'float', min: 0, max: 120000, step: 500, unit: 'lx' },
  { key: 'ambientLux', label: 'Ambient light', kind: 'float', min: 0, max: 40000, step: 100, unit: 'lx' },
];

/** Left dock: presets, seeds, saved variants and the preview stage. */
export function VariantsPanel() {
  const { doc, setDoc, variants, setVariants, seedHistory, stage, setStage } = useFoliage();
  const [label, setLabel] = useState('');
  const presets = presetsFor(doc.kind);
  const saveVariant = () => {
    const name = label.trim() || `${KIND_LABELS[doc.kind]} ${doc.seed}`;
    setVariants([{ id: `${Date.now().toString(36)}`, label: name, doc: structuredClone(doc) }, ...variants]);
    setLabel('');
  };
  return (
    <div className='p-2 overflow-auto h-full flex flex-col gap-2'>
      <Collapsable title='Presets' persistKey='cleo_creator_foliage_variants_presets'>
        <div className='flex flex-col'>
          {presets.map(p => (
            <button key={p.id} type='button' title={p.description}
                    className={`text-left px-2 py-1 rounded hover:bg-surface-raised ${doc.name === p.id ? 'bg-surface-raised' : ''}`}
                    onClick={() => setDoc({ ...doc, [p.kind]: applyPreset(p), name: p.id })}>
              <div className='text-ui-sm'>{p.label}</div>
              <div className='text-ui-xs text-muted'>{p.description}</div>
            </button>
          ))}
        </div>
      </Collapsable>
      <Collapsable title='Seeds' persistKey='cleo_creator_foliage_variants_seeds'>
        <div className='flex flex-wrap gap-1'>
          {seedHistory.map(s => (
            <Button key={s} size='sm' variant={s === doc.seed ? 'primary' : 'ghost'} onClick={() => setDoc({ ...doc, seed: s })}>{s}</Button>
          ))}
        </div>
        <p className='text-ui-xs text-muted pt-1'>Every seed is another plant from the same parameters. New seed is in the toolbar.</p>
      </Collapsable>
      <Collapsable title='Saved variants' persistKey='cleo_creator_foliage_variants_saved'>
        <div className='flex gap-1 pb-1'>
          <TextInput value={label} placeholder={`${KIND_LABELS[doc.kind]} ${doc.seed}`} onChange={setLabel} />
          <Button size='sm' onClick={saveVariant}>Save</Button>
        </div>
        {variants.length === 0 && <p className='text-ui-xs text-muted'>Keep a parameter set and seed you like to come back to it.</p>}
        {variants.map(v => (
          <div key={v.id} className='flex items-center gap-1 py-0.5'>
            <button type='button' className='flex-1 min-w-0 truncate text-left text-ui-sm hover:text-fg text-muted'
                    title={`${KIND_LABELS[v.doc.kind]}, seed ${v.doc.seed}`} onClick={() => setDoc(structuredClone(v.doc))}>
              {v.label} <span className='text-ui-xs'>· {KIND_LABELS[v.doc.kind]}</span>
            </button>
            <Button size='sm' variant='ghost' title='Delete' onClick={() => setVariants(variants.filter(x => x.id !== v.id))}>✕</Button>
          </div>
        ))}
      </Collapsable>
      <Collapsable title='Stage' persistKey='cleo_creator_foliage_variants_stage'>
        <ParamForm schema={STAGE_SPECS} values={stage as unknown as Record<string, unknown>}
                   onChange={patch => setStage({ ...stage, ...(patch as Partial<StageSettings>) })} />
      </Collapsable>
    </div>
  );
}
