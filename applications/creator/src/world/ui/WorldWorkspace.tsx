import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { DockviewApi, IDockviewPanelProps } from 'dockview-react';
import { DockShell } from '@cleo/app-kit/layout/DockShell';
import { ViewportHost } from '@cleo/app-kit/engine/ViewportHost';
import { ParamForm } from '@cleo/app-kit/params/ParamForm';
import ConsolePanel from '@cleo/app-kit/feedback/ConsolePanel';
import { Button, DocScope, Section, Select, SegmentedControl, Toggle, cn } from '@cleo/app-kit/ui';
import { toast } from '@cleo/app-kit/feedback/toastStore';
import { useCreatorEngine } from '../../app/CreatorEngine';
import { GenerationBar } from '../../app/StatusBar';
import { downloadAll } from '../../core/download';
import { useGeneration } from '../../core/useGeneration';
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
// live on a real engine landscape, and export the heightmap (+ masks) at full resolution.

const PREVIEW_RESOLUTION = 257;
const STORAGE_KEY = 'cleo_creator_world_doc_v1';

interface WorldState {
  doc: WorldDoc;
  setDoc: (next: WorldDoc) => void;
  selected: string | null;
  select: (id: string | null) => void;
  preview: WorldOutput | null;
  mapView: MapLayerView;
  setMapView: (v: MapLayerView) => void;
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

export function WorldWorkspace() {
  const { scene, camera, hasCompute } = useCreatorEngine();
  const [doc, setDocState] = useState<WorldDoc>(loadDoc);
  const [selected, select] = useState<string | null>(null);
  const [preview, setPreview] = useState<WorldOutput | null>(null);
  const [mapView, setMapView] = useState<MapLayerView>('height');
  const live = useGeneration();
  const full = useGeneration();
  const framedFor = useRef('');

  const setDoc = useCallback((next: WorldDoc) => {
    setDocState(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* quota */ }
  }, []);

  // The live preview: re-run at preview resolution whenever the document changes, debounced so a slider
  // drag regenerates once it pauses rather than on every step. CPU erosion at this size is fast enough.
  useEffect(() => {
    const t = setTimeout(() => {
      live.run(ctx => generateWorld(doc, ctx, { resolution: Math.min(PREVIEW_RESOLUTION, doc.settings.resolution) }))
        .then(out => { if (out) setPreview(out); });
    }, 200);
    return () => clearTimeout(t);
  }, [doc, live.run]);

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

  const value = useMemo(() => ({ doc, setDoc, selected, select, preview, mapView, setMapView }), [doc, setDoc, selected, preview, mapView]);
  const status = full.status.running ? full.status : live.status;

  return (
    <WorldContext.Provider value={value}>
      <DocScope page='creator/world'>
        <div className='flex flex-col h-full'>
          <div className='toolbar'>
            <span className='text-muted'>Preset</span>
            <Select value='' onChange={e => { const p = WORLD_PRESETS.find(x => x.id === e.target.value); if (p) { setDoc({ ...p.params(), settings: { ...p.params().settings, seed: doc.settings.seed } }); select(null); } }}>
              <option value=''>Choose…</option>
              {WORLD_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </Select>
            <Button size='sm' onClick={() => setDoc({ ...doc, settings: { ...doc.settings, seed: (doc.settings.seed * 48271 + 11) % 99991 } })}>New seed</Button>
            <div className='flex-1' />
            <span className='text-dim'>Pipe erosion: {hasCompute ? 'GPU' : 'CPU'}</span>
            <Button variant='primary' disabled={full.status.running} onClick={generateAndExport}>
              Generate {doc.settings.resolution}² & export
            </Button>
          </div>
          <div className='flex-1 min-h-0'>
            <DockShell components={WORLD_PANELS} storageKey='cleo_creator_world_layout' version={1} buildDefault={buildWorldLayout} />
          </div>
          <GenerationBar status={status} onCancel={() => { full.cancel(); live.cancel(); }}
                         idle={preview ? `Preview ${preview.frame.resolution}² — ${doc.layers.filter(l => l.enabled).length} layers, ${doc.erosion.filter(p => p.enabled).length} erosion passes` : undefined} />
        </div>
      </DocScope>
    </WorldContext.Provider>
  );
}

function buildWorldLayout(api: DockviewApi) {
  api.addPanel({ id: 'viewport', component: 'viewport', title: 'Viewport' });
  api.addPanel({ id: 'layers', component: 'layers', title: 'Layers', position: { referencePanel: 'viewport', direction: 'left' }, initialWidth: 260 });
  api.addPanel({ id: 'properties', component: 'properties', title: 'Properties', position: { referencePanel: 'viewport', direction: 'right' }, initialWidth: 320 });
  api.addPanel({ id: 'map', component: 'map', title: 'Map', position: { referencePanel: 'viewport', direction: 'below' }, initialHeight: 320 });
  api.addPanel({ id: 'console', component: 'console', title: 'Console', position: { referencePanel: 'map', direction: 'within' } });
  api.getPanel('map')?.api.setActive();
}

// --- Panels -----------------------------------------------------------------------------------------

function ViewportPanel(_: IDockviewPanelProps) {
  return <ViewportHost />;
}

function MapPanel(_: IDockviewPanelProps) {
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

function LayersPanel(_: IDockviewPanelProps) {
  const { doc, setDoc, selected, select } = useWorld();
  const move = <T,>(list: T[], i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return list;
    const out = [...list];
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  };
  const row = (id: string, label: string, enabled: boolean, onToggle: (v: boolean) => void, onUp: () => void, onDown: () => void, onRemove: () => void) => (
    <div key={id} onClick={() => select(id)}
         className={cn('group flex items-center gap-1 px-1 py-0.5 rounded cursor-pointer', selected === id ? 'bg-border-subtle text-fg' : 'text-muted hover:text-fg')}>
      <span onClick={e => e.stopPropagation()}><Toggle checked={enabled} onChange={onToggle} /></span>
      <span className='flex-1 truncate'>{label}</span>
      <span className='hidden group-hover:flex'>
        <Button size='icon' variant='ghost' title='Move up' onClick={e => { e.stopPropagation(); onUp(); }}>↑</Button>
        <Button size='icon' variant='ghost' title='Move down' onClick={e => { e.stopPropagation(); onDown(); }}>↓</Button>
      </span>
      <Button size='icon' variant='remove' title='Remove' onClick={e => { e.stopPropagation(); onRemove(); }}>✕</Button>
    </div>
  );
  return (
    <div className='p-2 overflow-auto h-full'>
      <Section title='Landforms' right={
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
      </Section>
      <Section title='Erosion' right={
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
      </Section>
    </div>
  );
}

function PropertiesPanel(_: IDockviewPanelProps) {
  const { doc, setDoc, selected } = useWorld();
  const layer = doc.layers.find(l => l.id === selected);
  const pass = doc.erosion.find(p => p.id === selected);
  const settingsValues = { ...doc.settings, resolution: String(doc.settings.resolution) };
  return (
    <div className='p-2 overflow-auto h-full'>
      <Section title='World settings'>
        <ParamForm schema={SETTINGS_SCHEMA} values={settingsValues}
                   onChange={patch => setDoc({ ...doc, settings: { ...doc.settings, ...patch, resolution: Number(patch.resolution ?? doc.settings.resolution) } })} />
      </Section>
      {layer && (
        <Section title={`${LAYER_LABELS[layer.kind]}: ${layer.name}`}>
          <ParamForm schema={[STRENGTH_SPEC, ...LAYER_SCHEMAS[layer.kind]]} values={layer as unknown as Record<string, unknown>}
                     onChange={patch => setDoc({ ...doc, layers: doc.layers.map(l => (l.id === layer.id ? ({ ...l, ...patch } as WorldLayer) : l)) })} />
          {'center' in layer && <div className='text-ui-xs text-dim mt-1'>Centre ({layer.center[0].toFixed(3)}, {layer.center[1].toFixed(3)}) — drag it on the map.</div>}
          {'points' in layer && <div className='text-ui-xs text-dim mt-1'>{layer.points.length} spline points — edit them on the map.</div>}
        </Section>
      )}
      {pass && (
        <Section title={EROSION_LABELS[pass.kind]}>
          <ParamForm schema={EROSION_SCHEMAS[pass.kind]} values={pass.params as unknown as Record<string, unknown>}
                     onChange={patch => setDoc({ ...doc, erosion: doc.erosion.map(p => (p.id === pass.id ? ({ ...p, params: { ...p.params, ...patch } } as ErosionPass) : p)) })} />
        </Section>
      )}
      {!layer && !pass && <div className='text-dim'>Select a layer or an erosion pass to edit it.</div>}
    </div>
  );
}

function ConsoleTab(_: IDockviewPanelProps) {
  return <ConsolePanel />;
}

const WORLD_PANELS = { viewport: ViewportPanel, layers: LayersPanel, properties: PropertiesPanel, map: MapPanel, console: ConsoleTab };
