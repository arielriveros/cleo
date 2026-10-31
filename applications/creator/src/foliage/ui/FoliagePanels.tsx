import { useEffect, useMemo, useState } from 'react';
import { WIND_PRESETS } from 'cleo';
import { ParamForm } from '@cleo/app-kit/params/ParamForm';
import type { GenericParamSpec } from '@cleo/app-kit/params/ParamField';
import { MaterialFields } from '@cleo/app-kit/materials/MaterialFields';
import { Button, Collapsable, FileButton, SegmentedControl, TextInput } from '@cleo/app-kit/ui';
import { toast } from '@cleo/app-kit/feedback/toastStore';
import { ListRow, PanelBody, PanelHeader, SchemaSections } from '../../app/workspace';
import { OVERRIDE_SLOTS, TEXTURE_LABELS, type TextureKey } from '../buildFoliage';
import {
  DEFAULT_BUSH, DEFAULT_GRASS, DEFAULT_ROCK, DEFAULT_TREE, FOLIAGE_SCHEMAS, KIND_LABELS, formValues, fromForm, type FoliageGroup, type FoliageKind,
} from '../foliageParams';
import { applyPreset, presetsFor, type FoliagePreset } from '../foliagePresets';
import { applyMaterialPatch, hasMaterial, MATERIAL_KEYS, materialLabel, materialValues, resetMaterial } from '../materials';
import type { MaterialKey } from '../mesh';
import { readZip } from '../../core/zip';
import { PBR_SLOTS, planPbrSet } from '../pbrSet';
import type { StageSettings } from './foliageStage';
import { useFoliage } from './foliageContext';

// The Foliage Creator's dock panels. Parameters, Materials, LOD and Export share the right dock as tabs;
// Variants is the left dock. Built from the Creator's shared panel pieces (app/workspace.tsx), and the
// Materials tab from the Editor's own material sections (app-kit MaterialFields).

const DEFAULTS: Record<FoliageKind, object> = { grass: DEFAULT_GRASS, rock: DEFAULT_ROCK, tree: DEFAULT_TREE, bush: DEFAULT_BUSH };

/** LOD 0 triangle counts above which a level is flagged: foliage is drawn thousands of times. */
const LOD0_BUDGET: Record<FoliageKind, number> = { grass: 1500, rock: 6000, tree: 20000, bush: 8000 };

/** The textures each material samples, in slot order (base colour first). */
const MATERIAL_TEXTURES: Record<MaterialKey, TextureKey[]> = {
  grass: ['grass'], grassCard: ['grassCard'], rock: ['rockAlbedo', 'rockNormal'], leaves: ['leaves', 'leavesNormal'],
  bark: ['bark', 'barkNormal', 'barkOrm', 'barkAo', 'barkRoughness', 'barkMetallic'],
};
/** Single-channel slots: no texture of their own, they replace one channel of the packed ARM map. */
const CHANNEL_SLOTS = new Set<TextureKey>(['barkAo', 'barkRoughness', 'barkMetallic']);

function KindSections({ groups, persist }: { groups: FoliageGroup[]; persist: string }) {
  const { doc, setParams } = useFoliage();
  const params = doc[doc.kind];
  return <SchemaSections groups={groups} values={formValues(params)} onChange={patch => setParams(fromForm(params, patch))}
                         persist={`cleo_creator_foliage_${persist}_${doc.kind}`} />;
}

/** Right dock: the shape of the current kind. */
export function ParametersPanel() {
  const { doc, setDoc } = useFoliage();
  const apply = (p: FoliagePreset) => setDoc({ ...doc, [p.kind]: applyPreset(p), name: p.id });
  const reset = () => { setDoc({ ...doc, [doc.kind]: DEFAULTS[doc.kind] }); toast.success(`${KIND_LABELS[doc.kind]} reset to its defaults.`); };
  return (
    <PanelBody>
      <PanelHeader kind={KIND_LABELS[doc.kind]} name={doc.name} onReset={reset}
                   presets={presetsFor(doc.kind)} onPreset={apply} presetLabel={`${KIND_LABELS[doc.kind]} presets`} />
      <KindSections groups={FOLIAGE_SCHEMAS[doc.kind].filter(g => !g.side)} persist='params' />
    </PanelBody>
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

/** One texture slot: the texture in use, and whether it is generated or the user's image. */
function TextureSlot({ textureKey, url }: { textureKey: TextureKey; url?: string }) {
  const { doc, overrides, setOverride } = useFoliage();
  const slot = OVERRIDE_SLOTS[doc.kind].find(s => s.key === textureKey);
  const o = overrides[textureKey];
  const src = o?.url ?? url;
  return (
    <div className='flex gap-2 items-start'>
      <div className={`${CHANNEL_SLOTS.has(textureKey) ? 'w-10 h-10 ml-6' : 'w-16 h-16'} shrink-0 cleo-texture-checker border border-border`}>
        {src && <img src={src} className='w-full h-full object-cover' />}
      </div>
      <div className='flex-1 min-w-0'>
        <div className='text-ui-sm'>
          {slot?.label ?? TEXTURE_LABELS[textureKey]}{' '}
          <span className='text-muted'>· {o ? o.fileName : CHANNEL_SLOTS.has(textureKey) ? 'from the ARM map' : 'generated'}</span>
        </div>
        <div className='text-ui-xs text-muted'>{slot ? slot.hint : 'Generated from the material above it; follows its texture.'}</div>
        {slot && (
          <div className='flex gap-1 pt-1'>
            <FileButton accept='image/*' onFiles={files => files[0] && setOverride(textureKey, files[0])}>Image…</FileButton>
            {o && <Button size='sm' variant='ghost' onClick={() => setOverride(textureKey, null)}>Use generated</Button>}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Load a whole PBR texture set -- several images, or the .zip they were downloaded in -- onto a material's
 * slots by file name (pbrSet.ts).
 */
function PbrSetButton({ material }: { material: MaterialKey }) {
  const { setOverride } = useFoliage();
  const [loading, setLoading] = useState(false);
  const load = async (picked: File[]) => {
    setLoading(true);
    try {
      const files: File[] = [];
      for (const f of picked) {
        if (/\.zip$/i.test(f.name)) {
          for (const e of await readZip(new Uint8Array(await f.arrayBuffer())))
            files.push(new File([e.bytes as BlobPart], e.name.replace(/^.*\//, ''), { type: /\.png$/i.test(e.name) ? 'image/png' : 'image/jpeg' }));
        } else files.push(f);
      }
      const plan = planPbrSet(material, files.map(f => f.name));
      if (!plan.files.length) { toast.error(`No ${material} maps found in ${picked.map(f => f.name).join(', ')}.`); return; }
      await Promise.all(plan.files.map(p => setOverride(p.slot, files.find(f => f.name === p.name)!, { flipGreen: p.flipGreen })));
      const used = plan.files.map(p => `${TEXTURE_LABELS[p.slot]} ← ${p.name}${p.flipGreen ? ' (DirectX, green flipped)' : ''}`);
      toast.success([...used, ...(plan.skipped.length ? [`Not used: ${plan.skipped.join(', ')}`] : [])].join('\n'), { title: 'Texture set loaded' });
    } catch (e) {
      toast.error(String((e as Error)?.message ?? e), { title: 'Could not read the texture set' });
    } finally {
      setLoading(false);
    }
  };
  return (
    <FileButton accept='image/*,.zip' multiple disabled={loading} onFiles={files => files.length && load(files)}
                title='Several images or a .zip: colour, normal, ARM, AO, roughness and metallic are matched by file name (diff, nor_gl, arm, ao, rough, metal...).'>
      {loading ? 'Loading…' : 'Load texture set…'}
    </FileButton>
  );
}

/**
 * Right dock tab: every material the kind generates -- bark, leaves or needles, blades, rock -- in the
 * Editor's material sections (Properties, Textures, Cutout, Wind). Each texture slot is either generated
 * (its generator's settings below it) or an image of the user's.
 */
export function MaterialsPanel() {
  const { doc, setDoc } = useFoliage();
  const urls = useGeneratedUrls();
  const keys = MATERIAL_KEYS[doc.kind].filter(k => hasMaterial(doc, k));
  const [picked, setPicked] = useState<MaterialKey>(keys[0]);
  const key = keys.includes(picked) ? picked : keys[0];
  if (!key) return <PanelBody><p className='text-ui-sm text-muted'>This {KIND_LABELS[doc.kind].toLowerCase()} has no materials.</p></PanelBody>;
  const params = doc[doc.kind];
  const generator = FOLIAGE_SCHEMAS[doc.kind].filter(g => g.side === 'material' && g.material === key);
  const textures = MATERIAL_TEXTURES[key].filter(t => urls[t] || OVERRIDE_SLOTS[doc.kind].some(s => s.key === t));
  const overridden = !!(params.materials && params.materials[key] && Object.keys(params.materials[key]!).length);
  return (
    <PanelBody>
      <PanelHeader kind='Material' name={materialLabel(doc, key)}
                   onReset={overridden ? () => { setDoc(resetMaterial(doc, key)); toast.success(`${materialLabel(doc, key)} back to its generated settings.`); } : undefined} />
      {keys.length > 1 && (
        <SegmentedControl<MaterialKey> size='sm' value={key} onChange={setPicked}
                                       options={keys.map(k => ({ value: k, label: materialLabel(doc, k) }))} />
      )}
      <MaterialFields value={materialValues(doc, key)} onChange={patch => setDoc(applyMaterialPatch(doc, key, patch))}
                      tintsTexture={textures.length > 0}
                      textures={(
                        <div className='flex flex-col gap-2'>
                          {PBR_SLOTS[key] && <div><PbrSetButton material={key} /></div>}
                          {textures.map(t => <TextureSlot key={t} textureKey={t} url={urls[t]} />)}
                          {generator.length > 0 && (
                            <div className='pt-1'>
                              <SchemaSections groups={generator} values={formValues(params)} persist={`cleo_creator_foliage_material_${doc.kind}`}
                                              onChange={patch => setDoc({ ...doc, [doc.kind]: fromForm(params, patch) })} />
                            </div>
                          )}
                        </div>
                      )} />
    </PanelBody>
  );
}

/** Right dock tab: the level ladder, what each level costs, and the impostor. */
export function LodPanel() {
  const { doc, build, impostorPreview, bakeImpostorPreview, exporting } = useFoliage();
  const levels = build?.summary.levels ?? [];
  const budget = LOD0_BUDGET[doc.kind];
  return (
    <PanelBody>
      <KindSections groups={FOLIAGE_SCHEMAS[doc.kind].filter(g => g.side === 'lod')} persist='lod' />
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
    </PanelBody>
  );
}

/** Right dock tab: what the export writes -- the file names, texture sizes and the textures themselves. */
export function ExportPanel() {
  const { doc, setDoc } = useFoliage();
  const urls = useGeneratedUrls();
  const stem = doc.name.trim().replace(/\s+/g, '_') || 'foliage';
  const impostor = doc.kind === 'tree' && doc.tree.impostor;
  return (
    <PanelBody>
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
        <p className='text-ui-xs text-muted pt-1'>Download .glb (toolbar) writes them. Import the .glb files in the Editor, then set LOD 1 and 2 as the LOD 0 model's levels.</p>
      </Collapsable>
      <KindSections groups={FOLIAGE_SCHEMAS[doc.kind].filter(g => g.side === 'export')} persist='export' />
      <Collapsable title='Embedded textures' persistKey='cleo_creator_foliage_export_textures'>
        <div className='grid grid-cols-3 gap-2'>
          {(Object.keys(urls) as TextureKey[]).map(k => (
            <figure key={k} className='flex flex-col gap-0.5'>
              <img src={urls[k]} className='w-full aspect-square object-cover cleo-texture-checker border border-border' />
              <figcaption className='text-ui-xs text-muted truncate'>{TEXTURE_LABELS[k]}</figcaption>
            </figure>
          ))}
        </div>
        <p className='text-ui-xs text-muted pt-1'>Replace any of them in the Materials tab.</p>
      </Collapsable>
    </PanelBody>
  );
}

const STAGE_SPECS: GenericParamSpec[] = [
  { key: 'sunYaw', label: 'Sun direction', kind: 'float', min: -180, max: 180, step: 1, unit: '°' },
  { key: 'sunElevation', label: 'Sun elevation', kind: 'float', min: -10, max: 90, step: 1, unit: '°', hint: 'Low and behind the plant shows its translucency.' },
  { key: 'sunLux', label: 'Sun illuminance', kind: 'float', min: 0, max: 120000, step: 500, unit: 'lx' },
  { key: 'ambientLux', label: 'Ambient light', kind: 'float', min: 0, max: 40000, step: 100, unit: 'lx' },
];

/** The preview's wind: the stage's WindNode, which a swaying preview is drawn through (foliageStage.ts). */
const WIND_SPECS: GenericParamSpec[] = [
  { key: 'wind', label: 'Wind', kind: 'bool', hint: 'Sway the preview as a foliage layer does in a level. Off (or wireframe) shows it still.' },
  { key: 'windDirection', label: 'Direction', kind: 'float', min: 0, max: 360, step: 1, unit: '°', when: p => !!p.wind },
  { key: 'windStrength', label: 'Strength', kind: 'float', min: 0, max: 3, step: 0.01, when: p => !!p.wind },
  { key: 'windGustScale', label: 'Gust size', kind: 'float', min: 1, max: 100, step: 0.5, unit: 'm', when: p => !!p.wind },
  { key: 'windGustSpeed', label: 'Gust speed', kind: 'float', min: 0, max: 20, step: 0.1, unit: 'm/s', when: p => !!p.wind },
];

/** The preview's walker: something moving through the asset, to show its Interaction. */
const WALK_SPECS: GenericParamSpec[] = [
  { key: 'walk', label: 'Walk-through', kind: 'bool', hint: 'Walk someone back and forth through the preview, to see how the plant gives way and springs back (the material’s Interaction).' },
];

/** Left dock: presets, seeds, saved variants, the preview's sun and its wind. */
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
    <PanelBody>
      <PanelHeader kind={KIND_LABELS[doc.kind]} name={`seed ${doc.seed}`} />
      <Collapsable title='Presets' persistKey='cleo_creator_foliage_variants_presets'>
        <div className='flex flex-col'>
          {presets.map(p => (
            <ListRow key={p.id} selected={doc.name === p.id} title={p.description} caption={p.description}
                     onClick={() => setDoc({ ...doc, [p.kind]: applyPreset(p), name: p.id })}>
              {p.label}
            </ListRow>
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
          <ListRow key={v.id} title={`${KIND_LABELS[v.doc.kind]}, seed ${v.doc.seed}`} caption={KIND_LABELS[v.doc.kind]}
                   onClick={() => setDoc(structuredClone(v.doc))}
                   actions={<Button size='icon' variant='remove' title='Delete' onClick={() => setVariants(variants.filter(x => x.id !== v.id))}>✕</Button>}>
            {v.label}
          </ListRow>
        ))}
      </Collapsable>
      <Collapsable title='Sun & sky' persistKey='cleo_creator_foliage_variants_stage'>
        <ParamForm schema={STAGE_SPECS} values={stage as unknown as Record<string, unknown>}
                   onChange={patch => setStage({ ...stage, ...(patch as Partial<StageSettings>) })} />
      </Collapsable>
      <Collapsable title='Wind' persistKey='cleo_creator_foliage_variants_wind'>
        <ParamForm schema={WIND_SPECS} values={stage as unknown as Record<string, unknown>}
                   onChange={patch => setStage({ ...stage, ...(patch as Partial<StageSettings>) })} />
        <ParamForm schema={WALK_SPECS} values={stage as unknown as Record<string, unknown>}
                   onChange={patch => setStage({ ...stage, ...(patch as Partial<StageSettings>) })} />
        {stage.wind && (
          <div className='flex flex-col pt-1'>
            {WIND_PRESETS.map(p => (
              <ListRow key={p.id} selected={stage.windPreset === p.id} title={p.description} caption={p.description}
                       onClick={() => setStage({ ...stage, windPreset: p.id, windStrength: p.options.strength ?? stage.windStrength,
                                                 windGustScale: p.options.gustScale ?? stage.windGustScale, windGustSpeed: p.options.gustSpeed ?? stage.windGustSpeed })}>
                {p.label}
              </ListRow>
            ))}
          </div>
        )}
      </Collapsable>
    </PanelBody>
  );
}
