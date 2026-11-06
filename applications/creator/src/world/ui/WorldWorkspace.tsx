import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ParamForm } from '@cleo/app-kit/params/ParamForm';
import { Button, Collapsable, Select, Slider, Toggle } from '@cleo/app-kit/ui';
import { toast } from '@cleo/app-kit/feedback/toastStore';
import { useCreatorEngine } from '../../app/CreatorEngine';
import { CreatorWorkspace, ListRow, PanelBody, PanelHeader, StageSection, ViewportOverlay } from '../../app/workspace';
import { downloadAll, downloadFile } from '../../core/download';
import type { ExportFile, GenerateContext } from '../../core/generator';
import { useGeneration } from '../../core/useGeneration';
import { AssetBar, useCreatorAsset } from '../../core/useCreatorAsset';
import { useStageCapture } from '../../core/stageCapture';
import { writeZip } from '../../core/zip';
import { worldExportHash } from '../exportWorld';
import { generateWorld } from '../generateWorld';
import { pipeErosionGpu } from '../pipeErosionGpu';
import { coastalRange, WORLD_PRESETS } from '../presets';
import type { LayerKind, WorldLayer } from '../features';
import { surfaceExportKey, type SurfaceLayer } from '../surfaces/surfaceDoc';
import { alphasToWeights, coverage as coverageOf } from '../surfaces/weights';
import { WATER_LOOKS, type WaterLook } from '../water/waterLook';
import { exportOnWorker, WorldClient } from '../worldClient';
import type { PreviewResult } from '../worldWorker';
import {
  defaultErosion, defaultLayer, EROSION_LABELS, LAYER_LABELS, normaliseWorld, PREVIEW_QUALITY, terrainKey,
  type ErosionKind, type ErosionPass, type PreviewQuality, type WorldDoc,
} from '../worldDoc';
import { ExportPanel } from './ExportPanel';
import { MapView } from './MapView';
import { MAP_VIEWS, mapPicture, type MapLayerView } from './mapImage';
import { SurfaceEditor, SurfacesSection } from './SurfacesPanel';
import { EROSION_SCHEMAS, LAYER_SCHEMAS, SETTINGS_SCHEMA, STRENGTH_SPEC } from './worldSchemas';
import { DEFAULT_WORLD_STAGE, frameWorld, WorldStage, type WorldStageSettings } from './worldStage';

// World Creator: build a landscape from a stack of landform primitives and erosion passes, texture it with
// a stack of rule-placed surfaces, preview it live on a real engine landscape (the engine's own splat
// stack, generated preview materials, the sea and the lakes), and export industry-standard heightmaps,
// splat and weight maps, masks and a manifest. The Creator's shared layout (app/workspace.tsx): Layers on
// the left, Parameters and Export on the right, the Map and the console below.

const STORAGE_KEY = 'cleo_creator_world_doc_v1';
/** The preset picked last: what Reset returns to. */
const PRESET_KEY = 'cleo_creator_world_preset_v1';
const STAGE_KEY = 'cleo_creator_world_stage_v1';

/** The world settings the Parameters tab draws; Resolution is the Export tab's. */
const PARAMETER_SETTINGS = SETTINGS_SCHEMA.filter(s => s.key !== 'resolution');
const PRESET_ENTRIES = WORLD_PRESETS.map(p => ({ ...p, description: p.description ?? p.label }));

const LAKE_SCHEMA = [
  { key: 'enabled', label: 'Lakes', kind: 'bool' as const, hint: 'Fill the basins the sea does not reach.' },
  { key: 'minDepth', label: 'Min depth', kind: 'float' as const, min: 0, max: 50, step: 0.1, unit: 'm', hint: 'A basin shallower than this holds no lake.', when: (v: Record<string, unknown>) => !!v.enabled },
  { key: 'minArea', label: 'Min area', kind: 'float' as const, min: 0, max: 200000, step: 100, unit: 'm²', hint: 'Smaller lakes are dropped.', when: (v: Record<string, unknown>) => !!v.enabled },
  { key: 'fill', label: 'Fill', kind: 'float' as const, min: 0, max: 1, step: 0.01, hint: '1 fills each basin to its spill point; less leaves it lower.', when: (v: Record<string, unknown>) => !!v.enabled },
];

interface WorldState {
  doc: WorldDoc;
  setDoc: (next: WorldDoc) => void;
  selected: string | null;
  select: (id: string | null) => void;
  preview: PreviewResult | null;
  coverage: Map<string, number>;
  mapView: MapLayerView;
  setMapView: (v: MapLayerView) => void;
  presetId: string;
  applyPreset: (id: string) => void;
}

const WorldContext = createContext<WorldState | null>(null);
const useWorld = () => useContext(WorldContext)!;

function loadDoc(): WorldDoc {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normaliseWorld(JSON.parse(raw));
  } catch { /* fall through */ }
  return normaliseWorld(coastalRange());
}

function loadStage(): WorldStageSettings {
  try { return { ...DEFAULT_WORLD_STAGE, ...JSON.parse(localStorage.getItem(STAGE_KEY) ?? '{}') }; } catch { return { ...DEFAULT_WORLD_STAGE }; }
}

/** A saved world is regenerated at full resolution once edits have paused this long. */
const WORLD_PUBLISH_IDLE_MS = 2000;

/** A sub-range of a generation's progress bar. */
const span = (ctx: GenerateContext, from: number, to: number): GenerateContext => ({
  progress: (f, l) => ctx.progress(from + (to - from) * f, l),
  get cancelled() { return ctx.cancelled; },
});

export function WorldWorkspace() {
  const { instance, scene, camera, sun, hasCompute } = useCreatorEngine();
  const [doc, setDocState] = useState<WorldDoc>(loadDoc);
  const [selected, select] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [mapView, setMapView] = useState<MapLayerView>('surfaces');
  const [stageSettings, setStageState] = useState<WorldStageSettings>(loadStage);
  const [presetId, setPresetId] = useState<string>(() => { try { return localStorage.getItem(PRESET_KEY) ?? WORLD_PRESETS[0].id; } catch { return WORLD_PRESETS[0].id; } });
  const live = useGeneration();
  const full = useGeneration();
  const framedFor = useRef('');
  const docRef = useRef(doc);
  docRef.current = doc;
  const client = useRef<WorldClient | null>(null);
  const stage = useRef<WorldStage | null>(null);

  const setDoc = useCallback((next: WorldDoc) => {
    setDocState(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* quota */ }
  }, []);
  const setStage = (s: WorldStageSettings) => {
    setStageState(s);
    try { localStorage.setItem(STAGE_KEY, JSON.stringify(s)); } catch { /* quota */ }
  };

  /** A preset replaces the terrain but keeps the seed and the surfaces (and how the preview looks). */
  const applyPreset = (id: string) => {
    const p = WORLD_PRESETS.find(x => x.id === id);
    if (!p) return;
    const next = normaliseWorld(p.params());
    setDoc({ ...next, settings: { ...next.settings, seed: doc.settings.seed }, surfaces: doc.surfaces, preview: doc.preview, output: doc.output });
    select(null);
    setPresetId(id);
    try { localStorage.setItem(PRESET_KEY, id); } catch { /* quota */ }
  };

  // --- The stage and the worker ---
  useEffect(() => {
    if (!instance || !scene) return;
    const s = new WorldStage(instance, scene, sun);
    s.apply(stageSettings);
    stage.current = s;
    return () => { s.dispose(); stage.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance, scene, sun]);
  useEffect(() => { stage.current?.apply(stageSettings); }, [stageSettings]);
  useEffect(() => {
    client.current = new WorldClient();
    return () => { client.current?.dispose(); client.current = null; };
  }, []);

  // The live preview: re-run whenever what decides it changes (not on preview-only edits), debounced so a
  // slider drag runs once it pauses. The worker caches each stage, so a surface edit never re-erodes.
  const quality = PREVIEW_QUALITY[doc.preview.quality];
  const previewKey = useMemo(() => JSON.stringify([
    terrainKey(doc, quality.heights), doc.settings.seaLevel, doc.water, doc.surfaces.map(surfaceExportKey), quality,
  ]), [doc, quality]);
  useEffect(() => {
    const t = setTimeout(() => {
      const d = docRef.current;
      const q = PREVIEW_QUALITY[d.preview.quality];
      live.run(ctx => client.current?.preview(d, q.heights, q.masks, (f, l) => ctx.progress(f, l)) ?? Promise.resolve(null))
        .then(r => { if (r) setPreview(r); });
    }, 150);
    return () => clearTimeout(t);
  }, [previewKey, live.run]);

  useEffect(() => {
    if (!preview) return;
    stage.current?.show(preview, docRef.current);
    const key = `${preview.out.frame.size}:${preview.out.frame.heightScale}`;
    if (camera && framedFor.current !== key) { frameWorld(camera, preview.out.frame.size, preview.out.frame.heightScale); framedFor.current = key; }
  }, [preview, camera]);
  // Preview-only edits: the surfaces' look and the water's, applied without a new preview.
  const looksKey = JSON.stringify(doc.surfaces.map(s => [s.id, s.enabled, s.preview]));
  useEffect(() => { stage.current?.refreshMaterials(docRef.current); }, [looksKey]);
  useEffect(() => { stage.current?.setWaterLook(doc.preview.water); }, [doc.preview.water]);

  const frame = () => { if (camera && preview) frameWorld(camera, preview.out.frame.size, preview.out.frame.heightScale); };

  /** Every export file of `d` at full resolution: GPU erosion on the main thread when there is any, the rest on a worker. */
  const buildFiles = async (d: WorldDoc, name: string, ctx: GenerateContext) => {
    const gpu = hasCompute && d.erosion.some(p => p.enabled && p.kind === 'pipe');
    const terrain = gpu ? await generateWorld(d, span(ctx, 0, 0.5), { pipeGpu: pipeErosionGpu }) : undefined;
    return exportOnWorker(d, name, gpu ? span(ctx, 0.5, 1) : ctx, terrain);
  };

  const capture = useStageCapture();
  const asset = useCreatorAsset<WorldDoc>('world', doc, d => { setDoc(normaliseWorld(d)); select(null); }, undefined, capture);

  const generateAndExport = async () => {
    const name = asset.name;
    const res = await full.run(ctx => buildFiles(doc, name, ctx));
    if (!res) return;
    if (doc.output.zip) {
      const bytes = await writeZip(res.files.map(f => ({ name: f.name, bytes: f.bytes })));
      downloadFile({ name: `${name}.zip`, mime: 'application/zip', bytes });
    } else await downloadAll(res.files);
    toast.success(`Exported ${res.files.length} files (${doc.settings.resolution}² heights, ${doc.output.splatResolution}² surfaces; pipe erosion on ${res.pipeBackend ?? 'none'}).`);
  };

  // --- The saved asset: once edits pause, the world is generated at full resolution and published to the
  // Creator library, which the editor follows. Library files keep fixed `world_*` names (the editor keys
  // its texture ids on them). A preview-only edit re-publishes the document with the files it has. ---
  const publishedFrom = useRef<WorldDoc | null>(null);
  const published = useRef<{ asset: string; hash: string; files: ExportFile[] } | null>(null);
  useEffect(() => {
    if (!asset.active || publishedFrom.current === doc) return;
    const from = doc;
    const id = asset.active.id;
    const hash = worldExportHash(from);
    if (published.current?.asset === id && published.current.hash === hash) {
      publishedFrom.current = from;
      asset.publish({ from, files: published.current.files });
      return;
    }
    const t = setTimeout(async () => {
      const res = await full.run(ctx => buildFiles(from, 'world', ctx));
      if (!res) return;
      published.current = { asset: id, hash, files: res.files };
      publishedFrom.current = from;
      asset.publish({ from, files: res.files });
    }, WORLD_PUBLISH_IDLE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, asset.active?.id]);

  // Each surface's share of the map, from the preview (what the Surfaces list captions).
  const coverage = useMemo(() => {
    const m = new Map<string, number>();
    if (!preview) return m;
    const enabled = doc.surfaces.map((s, i) => ({ s, a: preview.surfaces.alphas[i] })).filter(e => e.a) as { s: SurfaceLayer; a: Uint8Array }[];
    if (enabled.length !== preview.surfaces.alphas.filter(Boolean).length) return m;
    const shares = coverageOf(alphasToWeights(enabled.map(e => e.a), preview.surfaces.size));
    enabled.forEach((e, i) => m.set(e.s.id, shares[i]));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview]);

  const value = useMemo(() => ({ doc, setDoc, selected, select, preview, coverage, mapView, setMapView, presetId, applyPreset }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, setDoc, selected, preview, coverage, mapView, presetId]);
  const status = full.status.running ? full.status : live.status;
  const enabledLayers = doc.layers.filter(l => l.enabled).length;
  const enabledPasses = doc.erosion.filter(p => p.enabled).length;
  const enabledSurfaces = doc.surfaces.filter((s, i) => i === 0 || s.enabled).length;
  const lakes = preview?.fields.water.lakes.length ?? 0;

  const setWater = (patch: Partial<WaterLook>) => setDoc({ ...doc, preview: { ...doc.preview, water: { ...doc.preview.water, ...patch } } });
  const overlay = (
    <ViewportOverlay
      readout={preview && <>
        Preview {preview.out.frame.resolution}² · surfaces {preview.surfaces.size}² · {preview.out.frame.size} m · {enabledLayers} landforms · {enabledPasses} erosion · {enabledSurfaces} surfaces · {lakes} lake{lakes === 1 ? '' : 's'}
      </>}
      stage={{
        toggles: [
          { key: 'water', label: 'Water', checked: stageSettings.water },
          { key: 'sky', label: 'Sky', checked: stageSettings.sky },
          { key: 'grid', label: 'Grid', checked: stageSettings.grid },
        ].map(item => ({ ...item, onChange: (v: boolean) => setStage({ ...stageSettings, [item.key]: v }) })),
        sun: { yaw: stageSettings.sunYaw, elevation: stageSettings.sunElevation, onChange: (sunYaw, sunElevation) => setStage({ ...stageSettings, sunYaw, sunElevation }) },
        extra: (<>
          <StageSection title='Preview quality'>
            <Select value={doc.preview.quality} onChange={e => setDoc({ ...doc, preview: { ...doc.preview, quality: e.target.value as PreviewQuality } })}>
              <option value='draft' title='A 257² landscape with 512² surface masks'>Draft (257²)</option>
              <option value='fine' title='A 513² landscape with 1024² surface masks'>Fine (513²)</option>
            </Select>
          </StageSection>
          <StageSection title='Water look' right={
            <Select value={doc.preview.water.preset} onChange={e => { const l = WATER_LOOKS.find(x => x.id === e.target.value); if (l) setWater({ ...l.look }); }}>
              {WATER_LOOKS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
              {!WATER_LOOKS.some(l => l.id === doc.preview.water.preset) && <option value={doc.preview.water.preset}>Custom</option>}
            </Select>
          }>
            <Slider label='Clarity (m)' min={0.2} max={12} step={0.1} value={doc.preview.water.clarity} onChange={v => setWater({ clarity: v, preset: 'custom' })} />
            <Slider label='Wave size (m)' min={1} max={40} step={0.5} value={doc.preview.water.waveScale} onChange={v => setWater({ waveScale: v, preset: 'custom' })} />
            <Slider label='Wave strength' min={0} max={1} step={0.01} value={doc.preview.water.waveStrength} onChange={v => setWater({ waveStrength: v, preset: 'custom' })} />
            <Slider label='Wind (°)' min={0} max={360} step={1} value={doc.preview.water.windDirection} onChange={v => setWater({ windDirection: v, preset: 'custom' })} />
            <Slider label='Wind speed' min={0} max={4} step={0.05} value={doc.preview.water.windSpeed} onChange={v => setWater({ windSpeed: v, preset: 'custom' })} />
            <Slider label='Foam' min={0} max={1} step={0.01} value={doc.preview.water.foam} onChange={v => setWater({ foam: v, preset: 'custom' })} />
          </StageSection>
        </>),
      }}
      onFrame={frame} frameTitle='Frame the world (F)' />
  );

  return (
    <WorldContext.Provider value={value}>
      <CreatorWorkspace
        id='world' page='creator/world'
        asset={<AssetBar state={asset} />}
        toolbar={(
          <Button size='sm' title='A new seed: the same landforms, different detail'
                  onClick={() => setDoc({ ...doc, settings: { ...doc.settings, seed: (doc.settings.seed * 48271 + 11) % 99991 } })}>New seed</Button>
        )}
        toolbarStatus={`Pipe erosion: ${hasCompute ? 'GPU' : 'CPU'}`}
        primaryAction={{ label: `Generate ${doc.settings.resolution}² & export`, disabled: full.status.running, onClick: generateAndExport,
                         title: 'Generate at the export resolution, then download the heightmap, the surface maps, the masks and the manifest' }}
        left={{ id: 'layers', title: 'Layers', render: () => <LayersPanel /> }}
        right={[
          { id: 'parameters', title: 'Parameters', render: () => <ParametersPanel /> },
          { id: 'export', title: 'Export', render: () => <ExportPanel doc={doc} setDoc={setDoc} /> },
        ]}
        bottom={[{ id: 'map', title: 'Map', render: () => <MapPanel /> }]}
        viewport={overlay}
        onFrame={frame}
        generation={{ status, onCancel: () => { full.cancel(); live.cancel(); } }} />
    </WorldContext.Provider>
  );
}

// --- Panels -----------------------------------------------------------------------------------------

function MapPanel() {
  const { doc, setDoc, selected, preview, mapView, setMapView } = useWorld();
  const onChangeLayer = (id: string, patch: Partial<WorldLayer>) =>
    setDoc({ ...doc, layers: doc.layers.map(l => (l.id === id ? ({ ...l, ...patch } as WorldLayer) : l)) });
  const looks = JSON.stringify(doc.surfaces.map(s => [s.id, s.preview.kind, s.preview.tint]));
  const picture = useMemo(() => (preview ? mapPicture(mapView, preview, doc, selected) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preview, mapView, selected, looks]);
  return (
    <div className='flex flex-col h-full'>
      <div className='flex items-center gap-2 px-2 py-1 border-b border-border'>
        <Select value={mapView} onChange={e => setMapView(e.target.value as MapLayerView)}>
          {MAP_VIEWS.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
        </Select>
        <span className='text-dim text-ui-xs'>Drag the selected landform's handles · double-click adds a point · Alt+click removes one</span>
      </div>
      <div className='flex-1 min-h-0'>
        <MapView picture={picture} layers={doc.layers} selectedId={selected} onChangeLayer={onChangeLayer} />
      </div>
    </div>
  );
}

function LayersPanel() {
  const { doc, setDoc, selected, select, coverage } = useWorld();
  const move = <T,>(list: T[], i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return list;
    const out = [...list];
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  };
  const row = (id: string, label: string, enabled: boolean, onToggle: (v: boolean) => void, onUp: () => void, onDown: () => void, onRemove: () => void) => (
    <ListRow key={id} selected={selected === id} onClick={() => select(id)}
             leading={<Toggle checked={enabled} onChange={onToggle} />}
             actions={<>
               <span className='hidden group-hover:flex'>
                 <Button size='icon' variant='ghost' title='Move up' onClick={onUp}>↑</Button>
                 <Button size='icon' variant='ghost' title='Move down' onClick={onDown}>↓</Button>
               </span>
               <Button size='icon' variant='remove' title='Remove' onClick={onRemove}>✕</Button>
             </>}>
      {label}
    </ListRow>
  );
  return (
    <PanelBody>
      <Collapsable title='Landforms' persistKey='cleo_creator_world_layers_landforms' right={
        <Select value='' className='w-[76px]' onChange={e => { const k = e.target.value as LayerKind; if (!k) return; const l = defaultLayer(k); setDoc({ ...doc, layers: [...doc.layers, l] }); select(l.id); }}>
          <option value=''>+ Add</option>
          {(Object.keys(LAYER_LABELS) as LayerKind[]).map(k => <option key={k} value={k}>{LAYER_LABELS[k]}</option>)}
        </Select>
      }>
        <div className='text-ui-xs text-dim mb-1'>Applied top to bottom: each layer reads the height above it.</div>
        {doc.layers.map((l, i) => row(l.id, l.name, l.enabled,
          v => setDoc({ ...doc, layers: doc.layers.map(x => (x.id === l.id ? { ...x, enabled: v } : x)) }),
          () => setDoc({ ...doc, layers: move(doc.layers, i, -1) }),
          () => setDoc({ ...doc, layers: move(doc.layers, i, 1) }),
          () => { setDoc({ ...doc, layers: doc.layers.filter(x => x.id !== l.id) }); if (selected === l.id) select(null); }))}
      </Collapsable>
      <Collapsable title='Erosion' persistKey='cleo_creator_world_layers_erosion' right={
        <Select value='' className='w-[76px]' onChange={e => { const k = e.target.value as ErosionKind; if (!k) return; const p = defaultErosion(k); setDoc({ ...doc, erosion: [...doc.erosion, p] }); select(p.id); }}>
          <option value=''>+ Add</option>
          {(Object.keys(EROSION_LABELS) as ErosionKind[]).map(k => <option key={k} value={k}>{EROSION_LABELS[k]}</option>)}
        </Select>
      }>
        {doc.erosion.map((p, i) => row(p.id, EROSION_LABELS[p.kind], p.enabled,
          v => setDoc({ ...doc, erosion: doc.erosion.map(x => (x.id === p.id ? { ...x, enabled: v } : x)) }),
          () => setDoc({ ...doc, erosion: move(doc.erosion, i, -1) }),
          () => setDoc({ ...doc, erosion: move(doc.erosion, i, 1) }),
          () => { setDoc({ ...doc, erosion: doc.erosion.filter(x => x.id !== p.id) }); if (selected === p.id) select(null); }))}
      </Collapsable>
      <SurfacesSection surfaces={doc.surfaces} onChange={surfaces => setDoc({ ...doc, surfaces })} selected={selected} select={select} coverage={coverage} />
    </PanelBody>
  );
}

function ParametersPanel() {
  const { doc, setDoc, selected, presetId, applyPreset, preview } = useWorld();
  const layer = doc.layers.find(l => l.id === selected);
  const pass = doc.erosion.find(p => p.id === selected);
  const surfaceIndex = doc.surfaces.findIndex(s => s.id === selected);
  const surface = surfaceIndex >= 0 ? doc.surfaces[surfaceIndex] : null;
  const preset = WORLD_PRESETS.find(p => p.id === presetId);
  return (
    <PanelBody>
      <PanelHeader kind='World' name={preset?.label ?? 'custom'} presetLabel='World presets' presets={PRESET_ENTRIES}
                   onPreset={p => applyPreset(p.id)}
                   onReset={() => { applyPreset(presetId); toast.success(`Reset to ${preset?.label ?? 'the preset'}.`); }} />
      <Collapsable title='World settings' persistKey='cleo_creator_world_settings'>
        <ParamForm schema={PARAMETER_SETTINGS} values={doc.settings as unknown as Record<string, unknown>}
                   onChange={patch => setDoc({ ...doc, settings: { ...doc.settings, ...patch } })} />
      </Collapsable>
      <Collapsable title='Lakes' persistKey='cleo_creator_world_lakes'>
        <ParamForm schema={LAKE_SCHEMA} values={doc.water.lakes as unknown as Record<string, unknown>}
                   onChange={patch => setDoc({ ...doc, water: { lakes: { ...doc.water.lakes, ...patch } } })} />
      </Collapsable>
      {layer && (
        <Collapsable title={`${LAYER_LABELS[layer.kind]}: ${layer.name}`} persistKey='cleo_creator_world_selected'>
          <ParamForm schema={[STRENGTH_SPEC, ...LAYER_SCHEMAS[layer.kind]]} values={layer as unknown as Record<string, unknown>}
                     onChange={patch => setDoc({ ...doc, layers: doc.layers.map(l => (l.id === layer.id ? ({ ...l, ...patch } as WorldLayer) : l)) })} />
          {'center' in layer && <div className='text-ui-xs text-dim mt-1'>Centre ({layer.center[0].toFixed(3)}, {layer.center[1].toFixed(3)}) — drag it on the map.</div>}
          {'points' in layer && <div className='text-ui-xs text-dim mt-1'>{layer.points.length} spline points — edit them on the map.</div>}
        </Collapsable>
      )}
      {pass && (
        <Collapsable title={EROSION_LABELS[pass.kind]} persistKey='cleo_creator_world_selected'>
          <ParamForm schema={EROSION_SCHEMAS[pass.kind]} values={pass.params as unknown as Record<string, unknown>}
                     onChange={patch => setDoc({ ...doc, erosion: doc.erosion.map(p => (p.id === pass.id ? ({ ...p, params: { ...p.params, ...patch } } as ErosionPass) : p)) })} />
        </Collapsable>
      )}
      {surface && (
        <SurfaceEditor surface={surface} index={surfaceIndex} surfaces={doc.surfaces} fields={preview?.fields ?? null} alphas={preview?.surfaces ?? null}
                       onChange={patch => setDoc({ ...doc, surfaces: doc.surfaces.map(s => (s.id === surface.id ? { ...s, ...patch } : s)) })} />
      )}
      {!layer && !pass && !surface && <div className='text-dim text-ui-sm'>Select a landform, an erosion pass or a surface to edit it.</div>}
    </PanelBody>
  );
}
