import { useEffect, useMemo, useRef, useState } from 'react';
import type { DockviewApi, IDockviewPanelProps } from 'dockview-react';
import { DockShell } from '@cleo/app-kit/layout/DockShell';
import ConsolePanel from '@cleo/app-kit/feedback/ConsolePanel';
import { ViewportHost } from '@cleo/app-kit/engine/ViewportHost';
import { Button, DocScope, NumberInput, SegmentedControl, Select, VisibilityMenu } from '@cleo/app-kit/ui';
import { toast } from '@cleo/app-kit/feedback/toastStore';
import { useCreatorEngine } from '../../app/CreatorEngine';
import { GenerationBar } from '../../app/StatusBar';
import { downloadAll } from '../../core/download';
import { useGeneration } from '../../core/useGeneration';
import { frameBox, installOrbitCamera } from '../../fx/ui/fxPreview';
import type { Overrides, TextureKey } from '../buildFoliage';
import { FoliageClient, type FoliageBuild } from '../foliageClient';
import { exportFoliage } from '../exportFoliage';
import { DEFAULT_DOC, KIND_LABELS, normaliseFoliage, type FoliageDoc, type FoliageKind } from '../foliageParams';
import type { Image } from '../textures/image';
import { DEFAULT_STAGE, FoliageStage, patchOffsets, type LodView, type StageSettings } from './foliageStage';
import { FoliageContext, useFoliage, type FoliageState, type SavedVariant, type TextureOverride } from './foliageContext';
import { ExportPanel, LodPanel, ParametersPanel, VariantsPanel } from './FoliagePanels';

// Foliage Creator: grass clumps, rocks and trees from parameters, each with its LOD ladder, previewed in
// the 3D viewport as a real LodGroupNode and exported as one .glb per level. The layout follows the FX
// Creator's: the viewport in the middle, Parameters on the right with LOD and Export as tabs beside it,
// Variants (presets, seeds, saved variants and the stage) on the left, and the console below.
//
// Generation runs in a worker on every edit (debounced), and the preview loads the exact .glb files the
// export would write -- through the engine's importer -- so there is no "export to see it".

const DOC_KEY = 'cleo_creator_foliage_doc_v1';
const STAGE_KEY = 'cleo_creator_foliage_stage_v1';
const VARIANTS_KEY = 'cleo_creator_foliage_variants_v1';
const REBUILD_DEBOUNCE_MS = 180;
const SAVE_DEBOUNCE_MS = 250;

function load<T>(key: string, fallback: T, read: (raw: unknown) => T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return read(JSON.parse(raw));
  } catch { /* fall through */ }
  return fallback;
}
const save = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ } };

/** Decode an image file into RGBA8 pixels (row 0 = top). */
async function decodeImage(file: File): Promise<Image> {
  const bitmap = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  bitmap.close();
  return { width: canvas.width, height: canvas.height, data: new Uint8Array(data.buffer.slice(0)) };
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
      setBuilding(true);
      try {
        const result = await c.build(doc, overrideImages);
        if (!result) return;
        const copies = patch ? patchOffsets(Math.max(0.3, doc.grass.clumpRadius * 2.6)) : undefined;
        await stageRef.current?.show(result, copies);
        setBuild(result);
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

  const setOverride = async (key: TextureKey, file: File | null) => {
    const old = overrides[key];
    if (!file) {
      if (old) URL.revokeObjectURL(old.url);
      const next = { ...overrides };
      delete next[key];
      setOverrides(next);
      return;
    }
    try {
      const image = await decodeImage(file);
      if (old) URL.revokeObjectURL(old.url);
      setOverrides(o => ({ ...o, [key]: { image, url: URL.createObjectURL(file), fileName: file.name } }));
    } catch (e) {
      toast.error(`Could not read ${file.name}: ${String((e as Error)?.message ?? e)}`);
    }
  };
  useEffect(() => () => { for (const o of Object.values(overrides)) if (o) URL.revokeObjectURL(o.url); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
  const overlay = (<>
    <div data-cleo-overlay className='absolute top-2 right-2 z-20 flex items-center gap-2'>
      <VisibilityMenu items={[
        { key: 'grid', label: 'Grid', checked: stage.grid },
        { key: 'ground', label: 'Floor', checked: stage.ground },
        { key: 'sky', label: 'Sky', checked: stage.sky },
        ...(doc.kind === 'grass' ? [{ key: 'patch', label: 'Patch of clumps', checked: stage.patch }] : []),
        { key: 'wireframe', label: 'Wireframe', checked: stage.wireframe },
      ].map(item => ({ ...item, onChange: (v: boolean) => setStage({ ...stage, [item.key]: v }) }))} />
      <Select value={String(lodView)} title='Which level the viewport shows' onChange={e => setLodView(e.target.value === 'auto' ? 'auto' : Number(e.target.value) as LodView)}>
        <option value='auto'>LOD: by distance</option>
        {[0, 1, 2].map(i => <option key={i} value={i}>LOD {i}</option>)}
      </Select>
      <Button size='sm' variant='ghost' className='bg-surface-raised/80' title='Frame the asset (F)' onClick={() => frameAsset()}>Frame</Button>
    </div>
    {build && (
      <div data-cleo-overlay className='absolute left-2 top-2 rounded bg-surface/80 px-2 py-1 text-ui-xs text-muted tabular-nums pointer-events-none'>
        {KIND_LABELS[build.summary.kind]} · {build.summary.levels.map((l, i) => `LOD${i} ${l.triangles.toLocaleString()}`).join(' · ')} tris
        {active ? ` · showing ${active.culled ? 'nothing (culled)' : `LOD ${active.level}`}` : ''} · {build.ms.toFixed(0)} ms
      </div>
    )}
  </>);

  // F frames the asset, as in the editor. Not while typing into a field.
  const frameRef = useRef(frameAsset);
  frameRef.current = frameAsset;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || t?.closest?.('input, textarea, select, [contenteditable]')) return;
      if (e.key.toLowerCase() === 'f') { frameRef.current(); e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const value = useMemo<FoliageState>(() => ({
    doc, setDoc, setParams, build, building, stage, setStage, overrides, setOverride, variants, setVariants, seedHistory,
    impostorPreview, bakeImpostorPreview, exporting: exportJob.status.running, onExport, viewportRef, overlay,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [doc, build, building, stage, overrides, variants, seedHistory, impostorPreview, exportJob.status.running, lodView, active]);

  const kindOptions = (['grass', 'rock', 'tree'] as FoliageKind[]).map(k => ({ value: k, label: KIND_LABELS[k] }));
  return (
    <FoliageContext.Provider value={value}>
      <DocScope page='creator/foliage'>
        <div className='flex flex-col h-full'>
          <div className='toolbar'>
            <SegmentedControl<FoliageKind> size='sm' value={doc.kind} options={kindOptions}
                                           onChange={k => setDoc({ ...doc, kind: k, name: doc.name === doc.kind ? k : doc.name })} />
            <span className='text-muted'>Seed</span>
            <NumberInput className='w-28' value={doc.seed} onChange={v => setDoc({ ...doc, seed: Math.max(0, Math.floor(v)) })} />
            <Button size='sm' title='A new random seed: another plant from the same parameters' onClick={() => setDoc({ ...doc, seed: randomSeed() })}>New seed</Button>
            <div className='flex-1' />
            <span className='text-dim'>{building ? 'Generating…' : ''}</span>
            <Button size='sm' variant='primary' disabled={exportJob.status.running || !build} onClick={onExport}>Download .glb</Button>
          </div>
          <div className='flex-1 min-h-0'>
            <DockShell components={FOLIAGE_PANELS} storageKey='cleo_creator_foliage_layout' version={1} buildDefault={buildFoliageLayout} anchorPanel='viewport' />
          </div>
          <GenerationBar status={exportJob.status} onCancel={exportJob.cancel}
                         idle={build ? `${KIND_LABELS[build.summary.kind]} “${build.summary.name}”: ${build.summary.levels.length} levels, cull at ${build.summary.cullDistance} m${build.summary.impostor ? `, impostor from ${build.summary.impostor.distance} m` : ''}` : 'Generating…'} />
        </div>
      </DocScope>
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

function buildFoliageLayout(api: DockviewApi) {
  api.addPanel({ id: 'viewport', component: 'viewport', title: 'Viewport' });
  api.addPanel({ id: 'variants', component: 'variants', title: 'Variants', position: { referencePanel: 'viewport', direction: 'left' }, initialWidth: 280 });
  api.addPanel({ id: 'parameters', component: 'parameters', title: 'Parameters', position: { referencePanel: 'viewport', direction: 'right' }, initialWidth: 340 });
  api.addPanel({ id: 'lod', component: 'lod', title: 'LOD', position: { referencePanel: 'parameters', direction: 'within' } });
  api.addPanel({ id: 'export', component: 'export', title: 'Export', position: { referencePanel: 'parameters', direction: 'within' } });
  api.addPanel({ id: 'console', component: 'console', title: 'Console', position: { referencePanel: 'viewport', direction: 'below' }, initialHeight: 150 });
  api.getPanel('parameters')?.api.setActive();
}

function ViewportPanel(_: IDockviewPanelProps) {
  const { viewportRef, overlay } = useFoliage();
  return <ViewportHost viewportRef={viewportRef}>{overlay}</ViewportHost>;
}

const FOLIAGE_PANELS = {
  viewport: ViewportPanel,
  variants: (_: IDockviewPanelProps) => <VariantsPanel />,
  parameters: (_: IDockviewPanelProps) => <ParametersPanel />,
  lod: (_: IDockviewPanelProps) => <LodPanel />,
  export: (_: IDockviewPanelProps) => <ExportPanel />,
  console: (_: IDockviewPanelProps) => <ConsolePanel />,
};
