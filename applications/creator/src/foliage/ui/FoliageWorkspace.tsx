import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, NumberInput, SegmentedControl, Select } from '@cleo/app-kit/ui';
import { toast } from '@cleo/app-kit/feedback/toastStore';
import { useCreatorEngine } from '../../app/CreatorEngine';
import { CreatorWorkspace, ViewportOverlay } from '../../app/workspace';
import { downloadAll } from '../../core/download';
import { AssetBar, useCreatorAsset } from '../../core/useCreatorAsset';
import type { CreatorFile } from '@cleo/app-kit/creatorLibrary';
import type { ExportFile } from '../../core/generator';
import { useGeneration } from '../../core/useGeneration';
import { frameBox, installOrbitCamera } from '../../fx/ui/fxPreview';
import type { Overrides, TextureKey } from '../buildFoliage';
import { FoliageClient, type FoliageBuild } from '../foliageClient';
import { exportFoliage } from '../exportFoliage';
import { DEFAULT_DOC, KIND_LABELS, normaliseFoliage, type FoliageDoc, type FoliageKind } from '../foliageParams';
import type { Image } from '../textures/image';
import { DEFAULT_STAGE, FoliageStage, patchOffsets, type LodView, type StageSettings } from './foliageStage';
import { FoliageContext, useFoliage, type FoliageState, type SavedVariant, type TextureOverride } from './foliageContext';
import { ExportPanel, LodPanel, MaterialsPanel, ParametersPanel, VariantsPanel } from './FoliagePanels';

// Foliage Creator: grass clumps, bushes, trees and rocks from parameters, each with its LOD ladder,
// previewed in the 3D viewport as a real LodGroupNode and exported as one .glb per level. The Creator's
// shared layout (app/workspace.tsx): Variants (presets, seeds, saved variants, the sun) on the left,
// Parameters with Materials, LOD and Export as tabs on the right, the console below.
//
// Generation runs in a worker on every edit (debounced), and the preview loads the exact .glb files the
// export would write -- through the engine's importer -- so there is no "export to see it".

const DOC_KEY = 'cleo_creator_foliage_doc_v1';
const STAGE_KEY = 'cleo_creator_foliage_stage_v1';
const VARIANTS_KEY = 'cleo_creator_foliage_variants_v1';
const REBUILD_DEBOUNCE_MS = 180;
/** A saved tree's impostor is re-baked once edits pause this long (a bake costs a second or two). */
const IMPOSTOR_IDLE_MS = 3000;
/** Private files of a saved asset: `override/<texture key>/<gl|dx>/<file name>`. */
const OVERRIDE_PREFIX = 'override/';
const SAVE_DEBOUNCE_MS = 250;

function load<T>(key: string, fallback: T, read: (raw: unknown) => T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return read(JSON.parse(raw));
  } catch { /* fall through */ }
  return fallback;
}
const save = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ } };

/**
 * Decode an image file into RGBA8 pixels (row 0 = top), exactly as stored: normal, AO and roughness maps
 * are data, so no colour-space conversion and no premultiplied alpha.
 */
async function decodeImage(file: File, flipGreen = false): Promise<Image> {
  const bitmap = await createImageBitmap(file, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  bitmap.close();
  const pixels = new Uint8Array(data.buffer.slice(0));
  // A DirectX normal map: green points down; the generator's maps (and glTF's) are OpenGL, green up.
  if (flipGreen) for (let i = 1; i < pixels.length; i += 4) pixels[i] = 255 - pixels[i];
  return { width: canvas.width, height: canvas.height, data: pixels };
}

const randomSeed = () => Math.floor(Math.random() * 0x7fffffff);

export function FoliageWorkspace() {
  const { instance, scene, camera, sun } = useCreatorEngine();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [doc, setDocState] = useState<FoliageDoc>(() => load(DOC_KEY, DEFAULT_DOC, raw => normaliseFoliage(raw as FoliageDoc)));
  const [stage, setStage] = useState<StageSettings>(() => load(STAGE_KEY, DEFAULT_STAGE, raw => ({ ...DEFAULT_STAGE, ...(raw as object) })));
  const [variants, setVariantsState] = useState<SavedVariant[]>(() => load(VARIANTS_KEY, [], raw => Array.isArray(raw) ? raw as SavedVariant[] : []));
  const [overrides, setOverrides] = useState<Partial<Record<TextureKey, TextureOverride>>>({});
  const [build, setBuild] = useState<FoliageBuild | null>(null);
  const [building, setBuilding] = useState(false);
  const [lodView, setLodView] = useState<LodView>('auto');
  const [seedHistory, setSeedHistory] = useState<number[]>([doc.seed]);
  const [impostorPreview, setImpostorPreview] = useState<{ albedoUrl: string; normalUrl: string } | null>(null);
  const exportJob = useGeneration();

  const client = useRef<FoliageClient | null>(null);
  const stageRef = useRef<FoliageStage | null>(null);
  const orbit = useRef<ReturnType<typeof installOrbitCamera> | null>(null);
  /** The kind the camera was last framed for: a new kind re-frames, a new seed does not. */
  const framedKind = useRef<FoliageKind | null>(null);

  const setDoc = (d: FoliageDoc) => {
    setDocState(d);
    if (d.seed !== doc.seed) setSeedHistory(h => [d.seed, ...h.filter(s => s !== d.seed)].slice(0, 12));
  };
  const setParams = (p: object) => setDoc({ ...doc, [doc.kind]: p });
  const setVariants = (v: SavedVariant[]) => { setVariantsState(v); save(VARIANTS_KEY, v); };

  useEffect(() => { const t = setTimeout(() => save(DOC_KEY, doc), SAVE_DEBOUNCE_MS); return () => clearTimeout(t); }, [doc]);
  useEffect(() => { const t = setTimeout(() => save(STAGE_KEY, stage), SAVE_DEBOUNCE_MS); return () => clearTimeout(t); }, [stage]);

  // The worker, for as long as the workspace is open.
  useEffect(() => {
    client.current = new FoliageClient();
    return () => { client.current?.dispose(); client.current = null; };
  }, []);

  // The stage and the orbit camera.
  useEffect(() => {
    if (!instance || !scene) return;
    const s = new FoliageStage(instance, scene, sun);
    stageRef.current = s;
    s.apply(stage);
    return () => { s.dispose(); stageRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance, scene, sun]);
  useEffect(() => { stageRef.current?.apply(stage); }, [stage]);
  useEffect(() => { stageRef.current?.setLod(lodView); }, [lodView]);
  useEffect(() => {
    if (!camera) return;
    orbit.current = installOrbitCamera(camera, frameBox([10, 10, 10], 30));
    return () => { orbit.current?.restore(); orbit.current = null; };
  }, [camera]);

  // Regenerate on every edit, debounced; the client coalesces anything that arrives mid-build.
  const overrideImages = useMemo<Overrides>(() => {
    const out: Overrides = {};
    for (const [k, o] of Object.entries(overrides) as [TextureKey, TextureOverride][]) out[k] = o.image;
    return out;
  }, [overrides]);
  const patch = doc.kind === 'grass' && stage.patch;
  useEffect(() => {
    const t = setTimeout(async () => {
      const c = client.current;
      if (!c) return;
      const from = doc;
      setBuilding(true);
      try {
        const result = await c.build(from, overrideImages);
        if (!result) return;
        const copies = patch ? patchOffsets(Math.max(0.3, from.grass.clumpRadius * 2.6)) : undefined;
        await stageRef.current?.show(result, copies);
        builtFrom.current = from;
        setBuild(result);
        publishBuild(result, from);
        if (framedKind.current !== doc.kind) frameAsset(result);
      } catch (e) {
        console.error(e);
        toast.error(String((e as Error)?.message ?? e), { title: 'Foliage generation failed' });
      } finally {
        setBuilding(false);
      }
    }, REBUILD_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, overrideImages, patch]);

  // A new build invalidates the impostor preview.
  useEffect(() => { setImpostorPreview(null); }, [build]);

  const frameAsset = (b: FoliageBuild | null = build) => {
    if (!b || !orbit.current) return;
    framedKind.current = b.summary.kind;
    const { min, max } = b.summary.bounds;
    const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const grassPatch = b.summary.kind === 'grass' && stage.patch;
    const view: [number, number, number] = grassPatch ? [size[0] * 5, size[1], size[2] * 5] : size;
    orbit.current.frame(frameBox(view, orbit.current.current().yaw, [(min[0] + max[0]) / 2, Math.min(0, min[1]), (min[2] + max[2]) / 2]));
  };

  const setOverride = async (key: TextureKey, file: File | null, opts: { flipGreen?: boolean } = {}) => {
    const flipGreen = !!opts.flipGreen;
    const old = overrides[key];
    if (!file) {
      if (old) URL.revokeObjectURL(old.url);
      setOverrides(prev => { const next = { ...prev }; delete next[key]; return next; });
      return;
    }
    try {
      const image = await decodeImage(file, flipGreen);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (old) URL.revokeObjectURL(old.url);
      setOverrides(o => ({ ...o, [key]: { image, url: URL.createObjectURL(file), fileName: file.name, bytes, mime: file.type || 'image/png', flipGreen } }));
    } catch (e) {
      toast.error(`Could not read ${file.name}: ${String((e as Error)?.message ?? e)}`);
    }
  };
  useEffect(() => () => { for (const o of Object.values(overrides)) if (o) URL.revokeObjectURL(o.url); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // --- The saved asset: every build of it goes to the Creator library, which the editor follows. ---
  const docRef = useRef(doc);
  docRef.current = doc;
  /** The document the shown build was made from. */
  const builtFrom = useRef<FoliageDoc | null>(null);
  /** The last impostor baked for the saved asset; published with every build until a newer one lands. */
  const impostorBake = useRef<{ doc: FoliageDoc; bake: NonNullable<FoliageBuild['impostor']> } | null>(null);
  const restoreOverrides = (files: CreatorFile[]) => {
    for (const k of Object.keys(overrides) as TextureKey[]) void setOverride(k, null);
    for (const f of files) {
      const [, key, flip, ...name] = f.name.slice(OVERRIDE_PREFIX.length - 1).split('/');
      if (!f.name.startsWith(OVERRIDE_PREFIX) || !key) continue;
      void setOverride(key as TextureKey, new File([f.blob], name.join('/'), { type: f.mime }), { flipGreen: flip === 'dx' });
    }
  };
  const asset = useCreatorAsset<FoliageDoc>('foliage', doc, d => { impostorBake.current = null; setDoc(normaliseFoliage(d)); }, restoreOverrides);
  const wantsImpostor = (d: FoliageDoc) => d.kind === 'tree' && d.tree.impostor;
  function publishBuild(result: FoliageBuild, from: FoliageDoc) {
    if (!asset.active) return;
    const impostor = wantsImpostor(from) ? impostorBake.current?.bake ?? null : null;
    const privateFiles: ExportFile[] = (Object.entries(overrides) as [TextureKey, TextureOverride][]).map(([k, o]) => ({
      name: `${OVERRIDE_PREFIX}${k}/${o.flipGreen ? 'dx' : 'gl'}/${o.fileName}`, mime: o.mime, bytes: o.bytes,
    }));
    asset.publish({ from, files: exportFoliage(normaliseFoliage(from), result.summary, result.files, impostor), privateFiles });
  }
  // Saving (or opening) an asset publishes what is on screen, without waiting for an edit.
  useEffect(() => {
    if (build && builtFrom.current === doc) publishBuild(build, doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.active?.id]);
  // A saved tree's impostor follows its edits once they pause: the bake re-builds the tree, so it waits.
  useEffect(() => {
    if (!asset.active || !build || builtFrom.current !== doc || !wantsImpostor(doc) || impostorBake.current?.doc === doc) return;
    const from = doc;
    const t = setTimeout(async () => {
      const c = client.current;
      if (!c || docRef.current !== from) return;
      try {
        const result = await c.build(from, overrideImages, true);
        if (!result?.impostor || docRef.current !== from) return;
        impostorBake.current = { doc: from, bake: result.impostor };
        publishBuild(result, from);
      } catch (e) {
        console.error(e);
      }
    }, IMPOSTOR_IDLE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [build, asset.active?.id]);

  const bakeImpostorPreview = async () => {
    const c = client.current;
    if (!c || doc.kind !== 'tree') return;
    const result = await exportJob.run(async ctx => {
      ctx.progress(0.1, 'Baking impostor');
      return c.build(doc, overrideImages, true);
    });
    if (!result?.impostor) return;
    const url = (bytes: Uint8Array) => URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
    setImpostorPreview(prev => {
      if (prev) { URL.revokeObjectURL(prev.albedoUrl); URL.revokeObjectURL(prev.normalUrl); }
      return { albedoUrl: url(result.impostor!.albedo), normalUrl: url(result.impostor!.normal) };
    });
  };

  const onExport = async () => {
    const c = client.current;
    if (!c) return;
    const withImpostor = doc.kind === 'tree' && doc.tree.impostor;
    const files = await exportJob.run(async ctx => {
      ctx.progress(0.1, withImpostor ? 'Building and baking the impostor' : 'Building');
      const result = await c.build(doc, overrideImages, withImpostor);
      if (!result) return null;
      ctx.progress(0.9, 'Writing files');
      return exportFoliage(normaliseFoliage(doc), result.summary, result.files, result.impostor);
    });
    if (!files) return;
    await downloadAll(files);
    toast.success(`Exported ${files.length} files: ${files.map(f => f.name).join(', ')}.`);
  };

  const active = useActiveLod(stageRef);
  const overlay = (
    <ViewportOverlay
      readout={build && <>
        {KIND_LABELS[build.summary.kind]} · {build.summary.levels.map((l, i) => `LOD${i} ${l.triangles.toLocaleString()}`).join(' · ')} tris
        {active ? ` · showing ${active.culled ? 'nothing (culled)' : `LOD ${active.level}`}` : ''} · {build.ms.toFixed(0)} ms
      </>}
      visibility={[
        { key: 'grid', label: 'Grid', checked: stage.grid },
        { key: 'ground', label: 'Floor', checked: stage.ground },
        { key: 'sky', label: 'Sky', checked: stage.sky },
        ...(doc.kind === 'grass' ? [{ key: 'patch', label: 'Patch of clumps', checked: stage.patch }] : []),
        { key: 'wireframe', label: 'Wireframe', checked: stage.wireframe },
      ].map(item => ({ ...item, onChange: (v: boolean) => setStage({ ...stage, [item.key]: v }) }))}
      controls={(
        <Select value={String(lodView)} title='Which level the viewport shows' onChange={e => setLodView(e.target.value === 'auto' ? 'auto' : Number(e.target.value) as LodView)}>
          <option value='auto'>LOD: by distance</option>
          {[0, 1, 2].map(i => <option key={i} value={i}>LOD {i}</option>)}
        </Select>
      )}
      onFrame={() => frameAsset()} />
  );

  const value = useMemo<FoliageState>(() => ({
    doc, setDoc, setParams, build, building, stage, setStage, overrides, setOverride, variants, setVariants, seedHistory,
    impostorPreview, bakeImpostorPreview, exporting: exportJob.status.running, onExport,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [doc, build, building, stage, overrides, variants, seedHistory, impostorPreview, exportJob.status.running]);

  const kindOptions = (['grass', 'bush', 'tree', 'rock'] as FoliageKind[]).map(k => ({ value: k, label: KIND_LABELS[k] }));
  return (
    <FoliageContext.Provider value={value}>
      <CreatorWorkspace
        id='foliage' page='creator/foliage'
        asset={<AssetBar state={asset} />}
        toolbar={<>
          <SegmentedControl<FoliageKind> size='sm' value={doc.kind} options={kindOptions}
                                         onChange={k => setDoc({ ...doc, kind: k, name: doc.name === doc.kind ? k : doc.name })} />
          <span className='text-muted'>Seed</span>
          <NumberInput className='w-28' value={doc.seed} onChange={v => setDoc({ ...doc, seed: Math.max(0, Math.floor(v)) })} />
          <Button size='sm' title='A new random seed: another plant from the same parameters' onClick={() => setDoc({ ...doc, seed: randomSeed() })}>New seed</Button>
        </>}
        toolbarStatus={building ? 'Generating…' : undefined}
        primaryAction={{ label: 'Download .glb', disabled: exportJob.status.running || !build, onClick: onExport,
                         title: 'Every level as a .glb, the impostor atlases and a .foliage.json sidecar' }}
        left={{ id: 'variants', title: 'Variants', render: () => <VariantsPanel /> }}
        right={[
          { id: 'parameters', title: 'Parameters', render: () => <ParametersPanel /> },
          { id: 'materials', title: 'Materials', render: () => <MaterialsPanel /> },
          { id: 'lod', title: 'LOD', render: () => <LodPanel /> },
          { id: 'export', title: 'Export', render: () => <ExportPanel /> },
        ]}
        viewport={overlay} viewportRef={viewportRef} onFrame={() => frameAsset()}
        generation={{ status: exportJob.status, onCancel: exportJob.cancel,
                      idle: build ? `${KIND_LABELS[build.summary.kind]} “${build.summary.name}”: ${build.summary.levels.length} levels, cull at ${build.summary.cullDistance} m${build.summary.impostor ? `, impostor from ${build.summary.impostor.distance} m` : ''}` : 'Generating…' }} />
    </FoliageContext.Provider>
  );
}

/** The stage's active level, polled a few times a second for the overlay. */
function useActiveLod(stage: React.MutableRefObject<FoliageStage | null>) {
  const [active, setActive] = useState<{ level: number; culled: boolean } | null>(null);
  useEffect(() => {
    const t = setInterval(() => {
      const a = stage.current?.activeLod() ?? null;
      setActive(prev => (prev?.level === a?.level && prev?.culled === a?.culled ? prev : a));
    }, 250);
    return () => clearInterval(t);
  }, [stage]);
  return active;
}
