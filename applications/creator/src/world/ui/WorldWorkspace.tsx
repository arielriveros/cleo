import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ParamForm } from '@cleo/app-kit/params/ParamForm';
import { Button, Collapsable, Select, SegmentedControl, Toggle } from '@cleo/app-kit/ui';
import { toast } from '@cleo/app-kit/feedback/toastStore';
import { useCreatorEngine } from '../../app/CreatorEngine';
import { CreatorWorkspace, ListRow, PanelBody, PanelHeader, ViewportOverlay } from '../../app/workspace';
import { downloadAll } from '../../core/download';
import { useGeneration } from '../../core/useGeneration';
import { AssetBar, useCreatorAsset } from '../../core/useCreatorAsset';
import { exportWorld, generateWorld, type WorldOutput } from '../generateWorld';
import { MASK_KINDS } from '../masks';
import { pipeErosionGpu } from '../pipeErosionGpu';
import { coastalRange, WORLD_PRESETS } from '../presets';
import type { LayerKind, WorldLayer } from '../features';
import { defaultErosion, defaultLayer, EROSION_LABELS, LAYER_LABELS, type ErosionKind, type ErosionPass, type WorldDoc } from '../worldDoc';
import { MapView, type MapLayerView } from './MapView';
import { EROSION_SCHEMAS, LAYER_SCHEMAS, SETTINGS_SCHEMA, STRENGTH_SPEC } from './worldSchemas';
import { frameWorld, hideWorldPreview, showWorldPreview } from './worldPreview';

// World Creator: build a landscape from a stack of landform primitives and erosion passes, preview it
// live on a real engine landscape, and export the heightmap (+ masks) at full resolution. The Creator's
// shared layout (app/workspace.tsx): Layers on the left, Parameters and Export on the right, the Map and
// the console below.

const PREVIEW_RESOLUTION = 257;
const STORAGE_KEY = 'cleo_creator_world_doc_v1';
/** The preset picked last: what Reset returns to. */
const PRESET_KEY = 'cleo_creator_world_preset_v1';

/** The world settings the Parameters tab draws; Resolution is the Export tab's. */
const PARAMETER_SETTINGS = SETTINGS_SCHEMA.filter(s => s.key !== 'resolution');
const EXPORT_SETTINGS = SETTINGS_SCHEMA.filter(s => s.key === 'resolution');
const PRESET_ENTRIES = WORLD_PRESETS.map(p => ({ ...p, description: p.description ?? p.label }));

interface WorldState {
  doc: WorldDoc;
  setDoc: (next: WorldDoc) => void;
  selected: string | null;
  select: (id: string | null) => void;
  preview: WorldOutput | null;
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
    if (raw) return JSON.parse(raw) as WorldDoc;
  } catch { /* fall through */ }
  return coastalRange();
}

/** A saved world is regenerated at full resolution once edits have paused this long. */
const WORLD_PUBLISH_IDLE_MS = 2000;

export function WorldWorkspace() {
  const { scene, camera, hasCompute } = useCreatorEngine();
  const [doc, setDocState] = useState<WorldDoc>(loadDoc);
  const [selected, select] = useState<string | null>(null);
  const [preview, setPreview] = useState<WorldOutput | null>(null);
  const [mapView, setMapView] = useState<MapLayerView>('height');
  const [presetId, setPresetId] = useState<string>(() => { try { return localStorage.getItem(PRESET_KEY) ?? WORLD_PRESETS[0].id; } catch { return WORLD_PRESETS[0].id; } });
  const live = useGeneration();
  const full = useGeneration();
  const framedFor = useRef('');

  const setDoc = useCallback((next: WorldDoc) => {
    setDocState(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* quota */ }
  }, []);

  /** A preset replaces the document but keeps the seed. */
  const applyPreset = (id: string) => {
    const p = WORLD_PRESETS.find(x => x.id === id);
    if (!p) return;
    const next = p.params();
    setDoc({ ...next, settings: { ...next.settings, seed: doc.settings.seed } });
    select(null);
    setPresetId(id);
    try { localStorage.setItem(PRESET_KEY, id); } catch { /* quota */ }
  };

  // The live preview: re-run at preview resolution whenever the document changes, debounced so a slider
  // drag regenerates once it pauses rather than on every step. CPU erosion at this size is fast enough.
  useEffect(() => {
    const t = setTimeout(() => {
      live.run(ctx => generateWorld(doc, ctx, { resolution: Math.min(PREVIEW_RESOLUTION, doc.settings.resolution) }))
        .then(out => { if (out) setPreview(out); });
    }, 200);
    return () => clearTimeout(t);
  }, [doc, live.run]);

  const frame = () => { if (camera && preview) frameWorld(camera, preview.frame.size, preview.frame.heightScale); };
  useEffect(() => {
    if (!scene || !preview) return;
    showWorldPreview(scene, preview);
    const key = `${preview.frame.size}:${preview.frame.heightScale}`;
    if (camera && framedFor.current !== key) { frameWorld(camera, preview.frame.size, preview.frame.heightScale); framedFor.current = key; }
  }, [scene, camera, preview]);
  useEffect(() => () => { if (scene) hideWorldPreview(scene); }, [scene]);

  const generateAndExport = async () => {
    const out = await full.run(ctx => generateWorld(doc, ctx, { pipeGpu: hasCompute ? pipeErosionGpu : null }));
    if (!out) return;
    const files = await exportWorld(out, doc);
    await downloadAll(files);
    toast.success(`Exported ${doc.settings.resolution}² heightmap and ${MASK_KINDS.length} masks (pipe erosion on ${out.pipeBackend ?? 'none'}).`);
  };

  // --- The saved asset: once edits pause, the world is generated at full resolution and published to the
  // Creator library, which the editor follows (its landscapes offer to re-apply it). ---
  const asset = useCreatorAsset<WorldDoc>('world', doc, d => { setDoc(d); select(null); });
  const publishedFrom = useRef<WorldDoc | null>(null);
  useEffect(() => {
    if (!asset.active || publishedFrom.current === doc) return;
    const from = doc;
    const t = setTimeout(async () => {
      const out = await full.run(ctx => generateWorld(from, ctx, { pipeGpu: hasCompute ? pipeErosionGpu : null }));
      if (!out) return;
      publishedFrom.current = from;
      asset.publish({ from, files: await exportWorld(out, from) });
    }, WORLD_PUBLISH_IDLE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, asset.active?.id]);

  const value = useMemo(() => ({ doc, setDoc, selected, select, preview, mapView, setMapView, presetId, applyPreset }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, setDoc, selected, preview, mapView, presetId]);
  const status = full.status.running ? full.status : live.status;
  const enabledLayers = doc.layers.filter(l => l.enabled).length;
  const enabledPasses = doc.erosion.filter(p => p.enabled).length;

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
                         title: 'Generate at the export resolution, then download the heightmap, the masks and the sidecar' }}
        left={{ id: 'layers', title: 'Layers', render: () => <LayersPanel /> }}
        right={[
          { id: 'parameters', title: 'Parameters', render: () => <ParametersPanel /> },
          { id: 'export', title: 'Export', render: () => <ExportPanel /> },
        ]}
        bottom={[{ id: 'map', title: 'Map', render: () => <MapPanel /> }]}
        viewport={<ViewportOverlay readout={preview && <>Preview {preview.frame.resolution}² · {preview.frame.size} m · {enabledLayers} layers · {enabledPasses} erosion passes</>}
                                   onFrame={frame} frameTitle='Frame the world (F)' />}
        onFrame={frame}
        generation={{ status, onCancel: () => { full.cancel(); live.cancel(); },
                      idle: preview ? `Preview ${preview.frame.resolution}² — ${enabledLayers} layers, ${enabledPasses} erosion passes` : undefined }} />
    </WorldContext.Provider>
  );
}

// --- Panels -----------------------------------------------------------------------------------------

function MapPanel() {
  const { doc, setDoc, selected, preview, mapView, setMapView } = useWorld();
  const onChangeLayer = (id: string, patch: Partial<WorldLayer>) =>
    setDoc({ ...doc, layers: doc.layers.map(l => (l.id === id ? ({ ...l, ...patch } as WorldLayer) : l)) });
  return (
    <div className='flex flex-col h-full'>
      <div className='flex items-center gap-2 px-2 py-1 border-b border-border'>
        <SegmentedControl size='sm' value={mapView} onChange={setMapView}
                          options={[{ value: 'height', label: 'Height' }, ...MASK_KINDS.map(k => ({ value: k, label: k[0].toUpperCase() + k.slice(1) }))]} />
        <span className='text-dim text-ui-xs'>Drag the selected layer's handles · double-click adds a point · Alt+click removes one</span>
      </div>
      <div className='flex-1 min-h-0'>
        <MapView output={preview} view={mapView} layers={doc.layers} selectedId={selected} onChangeLayer={onChangeLayer} seaLevel={doc.settings.seaLevel} />
      </div>
    </div>
  );
}

function LayersPanel() {
  const { doc, setDoc, selected, select } = useWorld();
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
      <PanelHeader kind='World' name={`${doc.layers.length} layers · ${doc.erosion.length} passes`} />
      <Collapsable title='Landforms' persistKey='cleo_creator_world_layers_landforms' right={
        <Select value='' onChange={e => { const k = e.target.value as LayerKind; if (!k) return; const l = defaultLayer(k); setDoc({ ...doc, layers: [...doc.layers, l] }); select(l.id); }}>
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
        <Select value='' onChange={e => { const k = e.target.value as ErosionKind; if (!k) return; const p = defaultErosion(k); setDoc({ ...doc, erosion: [...doc.erosion, p] }); select(p.id); }}>
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
    </PanelBody>
  );
}

function ParametersPanel() {
  const { doc, setDoc, selected, presetId, applyPreset } = useWorld();
  const layer = doc.layers.find(l => l.id === selected);
  const pass = doc.erosion.find(p => p.id === selected);
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
      {!layer && !pass && <div className='text-dim text-ui-sm'>Select a layer or an erosion pass to edit it.</div>}
    </PanelBody>
  );
}

/** What the export writes: the resolution, and the files. */
function ExportPanel() {
  const { doc, setDoc } = useWorld();
  return (
    <PanelBody>
      <Collapsable title='Resolution' persistKey='cleo_creator_world_export_resolution'>
        <ParamForm schema={EXPORT_SETTINGS} values={{ resolution: String(doc.settings.resolution) }}
                   onChange={patch => setDoc({ ...doc, settings: { ...doc.settings, resolution: Number(patch.resolution ?? doc.settings.resolution) } })} />
      </Collapsable>
      <Collapsable title='File' persistKey='cleo_creator_world_export_file'>
        <ul className='text-ui-xs text-muted font-mono'>
          <li>world_height.png</li>
          <li>world_height.r16</li>
          {MASK_KINDS.map(k => <li key={k}>world_{k}.png</li>)}
          <li>world.json</li>
        </ul>
        <p className='text-ui-xs text-muted pt-1'>Generate &amp; export (toolbar) writes them at {doc.settings.resolution}². Import the heightmap on a Landscape in the Editor.</p>
      </Collapsable>
    </PanelBody>
  );
}
