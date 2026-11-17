import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ParamForm } from '@cleo/app-kit/params/ParamForm';
import { Button, Collapsable, Select, Slider } from '@cleo/app-kit/ui';
import { toast } from '@cleo/app-kit/feedback/toastStore';
import { useCreatorEngine } from '../../app/CreatorEngine';
import { CreatorWorkspace, PanelBody, PanelHeader, StageSection, ViewportOverlay } from '../../app/workspace';
import { downloadAll, downloadFile } from '../../core/download';
import type { ExportFile, GenerateContext } from '../../core/generator';
import { useGeneration } from '../../core/useGeneration';
import { useCreatorAsset } from '../../core/useCreatorAsset';
import { useStageCapture } from '../../core/stageCapture';
import { writeZip } from '../../core/zip';
import type { CreatorFile } from '@cleo/app-kit/creatorLibrary';
import { worldExportHash } from '../exportWorld';
import { generateWorld } from '../generateWorld';
import { ancestors, outputNode, type GraphNode, type WorldGraph } from '../graph/graphDoc';
import { filterParams } from '../graph/nodes/erosionNodes';
import { editedNode } from '../graph/realtime';
import { newId } from '../ids';
import { blankMask, decodeMask, encodeMask, paintFileName, paintHash, parsePaintFileName, type PaintMaskMeta, type PaintPixels } from '../paint';
import { loadScratchMasks, pruneScratchMasks, saveScratchMask } from '../paintStore';
import { pipeErosionGpu } from '../pipeErosionGpu';
import { WORLD_PRESETS } from '../presets';
import { stockBiomeOf } from '../surfaces/presets';
import { surfaceExportKey, type SurfaceLayer } from '../surfaces/surfaceDoc';
import { alphasToWeights, coverage as coverageOf } from '../surfaces/weights';
import { WATER_LOOKS, type WaterLook } from '../water/waterLook';
import { exportOnWorker, WorldClient } from '../worldClient';
import type { PreviewResult } from '../worldWorker';
import { normaliseWorld, PREVIEW_QUALITY, terrainKey, type PreviewQuality, type WorldDoc } from '../worldDoc';
import { ExportPanel } from './ExportPanel';
import { WorldGraphPanel, type NodeBadge } from './graph/WorldGraphPanel';
import { MapView, type MapHandles } from './MapView';
import { MAP_VIEWS, mapPicture, type MapLayerView, type MapPicture } from './mapImage';
import { dab, DEFAULT_BRUSH, readRegion, unionRegion, type Brush, type MaskRegion } from './paint/paintBrush';
import { useViewportPaint } from './paint/useViewportPaint';
import { RealtimePreview, type RealtimeState } from './realtimePreview';
import { SurfaceEditor, SurfacesSection } from './SurfacesPanel';
import { WorldHistory } from './worldHistory';
import { WorldInspector, type PaintTools } from './WorldInspector';
import { HAS_CENTER, HAS_POINTS, SETTINGS_SCHEMA } from './worldSchemas';
import { DEFAULT_WORLD_STAGE, frameWorld, WorldStage, type WorldStageSettings } from './worldStage';
import type { Point2 } from '../spline';

// World Creator: build a landscape as a node graph -- shapes with exact slopes, hand-placed landforms,
// the erosion filter and the erosion simulations, masks, painted masks -- texture it with a stack of
// rule-placed surfaces, preview it live on a real engine landscape (the engine's own splat stack,
// generated preview materials, the sea and the lakes), and export industry-standard heightmaps, splat
// and weight maps, masks and a manifest.
//
// Layout: the Graph and the Map side by side below the viewport; the selected node's Inspector, the World
// settings, the Surfaces and the Export on the right. Dragging a parameter of the erosion filter (or any
// per-sample node) updates the landscape every frame (realtimePreview.ts); the full preview -- fields,
// surfaces, water -- follows once the edit pauses.

const STORAGE_KEY = 'cleo_creator_world_doc_v1';
/** The preset picked last: what Reset returns to. */
const PRESET_KEY = 'cleo_creator_world_preset_v1';
const STAGE_KEY = 'cleo_creator_world_stage_v1';
const BRUSH_KEY = 'cleo_creator_world_brush_v1';

const PARAMETER_SETTINGS = SETTINGS_SCHEMA.filter(s => s.key !== 'resolution');
const PRESET_ENTRIES = WORLD_PRESETS.map(p => ({ ...p, description: p.description ?? p.label }));

const LAKE_SCHEMA = [
  { key: 'enabled', label: 'Lakes', kind: 'bool' as const, hint: 'Fill the basins the sea does not reach.' },
  { key: 'minDepth', label: 'Min depth', kind: 'float' as const, min: 0, max: 50, step: 0.1, unit: 'm', hint: 'A basin shallower than this holds no lake.', when: (v: Record<string, unknown>) => !!v.enabled },
  { key: 'minArea', label: 'Min area', kind: 'float' as const, min: 0, max: 200000, step: 100, unit: 'm²', hint: 'Smaller lakes are dropped.', when: (v: Record<string, unknown>) => !!v.enabled },
  { key: 'fill', label: 'Fill', kind: 'float' as const, min: 0, max: 1, step: 0.01, hint: '1 fills each basin to its spill point; less leaves it lower.', when: (v: Record<string, unknown>) => !!v.enabled },
];

/** A saved world is regenerated at full resolution once edits have paused this long. */
const WORLD_PUBLISH_IDLE_MS = 2000;
/** The settled preview's debounce: short normally, longer while a realtime edit is showing. */
const PREVIEW_DEBOUNCE_MS = 150;
const PREVIEW_SETTLE_MS = 350;
/** How long an opened asset may take to hand over its painted masks before they start blank. */
const MASK_WAIT_MS = 2000;

interface WorldState {
  doc: WorldDoc;
  /** An edit, named for the undo history; `key` coalesces a drag into one step. */
  commit: (next: WorldDoc, label: string, key?: string) => void;
  selectedNode: string | null;
  selectNode: (id: string | null) => void;
  selectedSurface: string | null;
  selectSurface: (id: string | null) => void;
  preview: PreviewResult | null;
  coverage: Map<string, number>;
  mapView: MapLayerView;
  setMapView: (v: MapLayerView) => void;
  presetId: string;
  applyPreset: (id: string) => void;
  badges: Record<string, NodeBadge>;
  paintTools: PaintTools;
  onStroke: (u: number, v: number, phase: 'start' | 'move' | 'end') => void;
  /** The brush is on and the selected node has a mask to paint. */
  painting: boolean;
  info: (id: string) => string | undefined;
}

const WorldContext = createContext<WorldState | null>(null);
const useWorld = () => useContext(WorldContext)!;

function loadDoc(): WorldDoc {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normaliseWorld(JSON.parse(raw));
  } catch { /* fall through */ }
  return normaliseWorld(WORLD_PRESETS[0].params());
}

function loadJson<T>(key: string, fallback: T): T {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) ?? '{}') }; } catch { return { ...fallback }; }
}

/** A sub-range of a generation's progress bar. */
const span = (ctx: GenerateContext, from: number, to: number): GenerateContext => ({
  progress: (f, l) => ctx.progress(from + (to - from) * f, l),
  get cancelled() { return ctx.cancelled; },
});

/** The nodes the Output reads (only they cost anything, or show their effect). */
const liveNodes = (g: WorldGraph): Set<string> => {
  const out = outputNode(g);
  return out ? new Set([out.id, ...ancestors(g, out.id)]) : new Set();
};

export function WorldWorkspace() {
  const { instance, scene, camera, sun, hasCompute, bus } = useCreatorEngine();
  const [doc, setDocState] = useState<WorldDoc>(loadDoc);
  const docRef = useRef(doc);
  const [selectedNode, selectNode] = useState<string | null>(null);
  const [selectedSurface, selectSurface] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ result: PreviewResult; doc: WorldDoc } | null>(null);
  const [mapView, setMapView] = useState<MapLayerView>('surfaces');
  const [stageSettings, setStageState] = useState<WorldStageSettings>(() => loadJson(STAGE_KEY, DEFAULT_WORLD_STAGE));
  const [brush, setBrushState] = useState<Brush>(() => loadJson(BRUSH_KEY, DEFAULT_BRUSH));
  const [paintActive, setPaintActive] = useState(false);
  const [realtime, setRealtime] = useState<RealtimeState>({ active: false, backend: null, bypassed: [], ms: 0 });
  const [presetId, setPresetId] = useState<string>(() => { try { return localStorage.getItem(PRESET_KEY) ?? WORLD_PRESETS[0].id; } catch { return WORLD_PRESETS[0].id; } });
  const [, setHistoryTick] = useState(0);
  const [paintVersion, setPaintVersion] = useState(0);
  const live = useGeneration();
  const full = useGeneration();
  const framedFor = useRef('');
  const client = useRef<WorldClient | null>(null);
  const stage = useRef<WorldStage | null>(null);
  const rt = useRef<RealtimePreview | null>(null);
  const history = useRef(new WorldHistory());
  const paint = useRef<PaintPixels>({});
  const viewportRef = useRef<HTMLDivElement>(null);

  // --- The document: every change through setDoc (no history) or commit (an undoable edit). ---
  const setDoc = useCallback((next: WorldDoc) => {
    docRef.current = next;
    setDocState(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* quota */ }
  }, []);
  const commit = useCallback((next: WorldDoc, label: string, key?: string) => {
    history.current.record(docRef.current, label, key);
    setHistoryTick(t => t + 1);
    setDoc(next);
  }, [setDoc]);
  const setStage = (s: WorldStageSettings) => {
    setStageState(s);
    try { localStorage.setItem(STAGE_KEY, JSON.stringify(s)); } catch { /* quota */ }
  };
  const setBrush = (b: Brush) => {
    setBrushState(b);
    try { localStorage.setItem(BRUSH_KEY, JSON.stringify(b)); } catch { /* quota */ }
  };

  /**
   * A preset replaces the terrain and brings the surfaces that suit it, unless the document's own have been
   * edited (then they stay). It keeps the seed (a preset drains whatever the seed), the export resolution,
   * the export and preview settings, and the painted masks.
   */
  const applyPreset = (id: string) => {
    const p = WORLD_PRESETS.find(x => x.id === id);
    if (!p) return;
    const next = normaliseWorld(p.params());
    const surfaces = stockBiomeOf(doc.surfaces) ? next.surfaces : doc.surfaces;
    commit({ ...next, settings: { ...next.settings, seed: doc.settings.seed, resolution: doc.settings.resolution }, surfaces,
             preview: doc.preview, output: doc.output, paint: doc.paint }, `Preset ${p.label}`);
    selectNode(null);
    setPresetId(id);
    try { localStorage.setItem(PRESET_KEY, id); } catch { /* quota */ }
  };

  // --- The stage, the worker and the realtime preview ---
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
    const c = new WorldClient();
    client.current = c;
    return () => { c.dispose(); client.current = null; };
  }, []);
  useEffect(() => {
    if (!instance || !client.current) return;
    const r = new RealtimePreview(client.current, (h, res, d) => stage.current?.showHeights(h, res, d.settings.heightScale), setRealtime);
    rt.current = r;
    return () => { r.dispose(); rt.current = null; };
  }, [instance, hasCompute]);

  // --- The saved asset (and the painted masks that travel with it) ---
  const capture = useStageCapture();
  /** The document's mask hashes, made to match the pixels here (so no cache keeps another's result). */
  const syncHashes = () => {
    const d = docRef.current;
    let changed = false;
    const metas = d.paint.map(m => {
      const px = paint.current[m.id];
      const hash = px ? paintHash(px, m.signed) : m.hash;
      if (hash !== m.hash) changed = true;
      return hash === m.hash ? m : { ...m, hash };
    });
    if (changed) setDoc({ ...d, paint: metas });
  };
  const restorePaint = (files: CreatorFile[]) => {
    void (async () => {
      for (const f of files) {
        const parsed = parsePaintFileName(f.name);
        if (!parsed) continue;
        const { pixels } = await decodeMask(new Uint8Array(await f.blob.arrayBuffer()), parsed.signed);
        paint.current[parsed.id] = pixels;
      }
      syncHashes();
      setPaintVersion(v => v + 1);
    })();
  };
  const asset = useCreatorAsset<WorldDoc>('world', doc, d => { setDoc(normaliseWorld(d)); history.current.clear(); setHistoryTick(t => t + 1); selectNode(null); }, restorePaint, capture);

  // Masks the document names but whose pixels are not here yet: the Scratch document's come from
  // IndexedDB at once; an asset's from its files (restorePaint), blank if they never come.
  const assetActive = !!asset.active;
  const paintIds = doc.paint.map(m => m.id).join(',');
  useEffect(() => {
    const missing = docRef.current.paint.filter(m => !paint.current[m.id]);
    if (!missing.length) return;
    let cancelled = false;
    const blank = () => {
      if (cancelled) return;
      for (const m of docRef.current.paint) if (!paint.current[m.id]) paint.current[m.id] = blankMask(m.resolution);
      syncHashes();
      setPaintVersion(v => v + 1);
    };
    if (!assetActive) {
      void loadScratchMasks(missing.map(m => m.id)).then(found => {
        if (cancelled) return;
        for (const m of missing) if (found[m.id]?.length === m.resolution ** 2) paint.current[m.id] = found[m.id];
        blank();
      });
    }
    // Never blank-fill before the store has answered: a preview of blank pixels would be cached under the
    // mask's real hash.
    const t = assetActive ? setTimeout(blank, MASK_WAIT_MS) : undefined;
    return () => { cancelled = true; clearTimeout(t); };
  }, [paintIds, assetActive]);
  const paintReady = doc.paint.every(m => !!paint.current[m.id]);

  // --- The live preview: re-run whenever what decides it changes (not on preview-only or layout edits),
  // debounced so a drag runs once it pauses; longer while the realtime preview carries the drag. ---
  const quality = PREVIEW_QUALITY[doc.preview.quality];
  const previewKey = useMemo(() => JSON.stringify([
    terrainKey(doc, quality.heights), doc.settings.seaLevel, doc.water, doc.surfaces.map(surfaceExportKey), quality,
  ]), [doc, quality]);
  const realtimeActive = realtime.active;
  useEffect(() => {
    if (!paintReady) return;
    const t = setTimeout(() => {
      const d = docRef.current;
      const q = PREVIEW_QUALITY[d.preview.quality];
      live.run(ctx => client.current?.preview(d, paint.current, q.heights, q.masks, (f, l) => ctx.progress(f, l)) ?? Promise.resolve(null))
        .then(r => { if (r) setPreview({ result: r, doc: d }); });
    }, realtimeActive ? PREVIEW_SETTLE_MS : PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, live.run, paintReady, paintVersion]);

  // The realtime preview: an edit of one node's parameters (or one painted mask) that can run live does.
  const lastSeen = useRef(doc);
  useEffect(() => {
    const prev = lastSeen.current;
    lastSeen.current = doc;
    if (prev === doc || !paintReady) return;
    const root = editedNode(prev, doc);
    if (root) rt.current?.edit(doc, paint.current, root);
  }, [doc, paintReady]);

  useEffect(() => {
    if (!preview) return;
    // A settled preview of an older document than the one on screen would undo the drag in view: wait.
    if (realtimeActive && preview.doc !== docRef.current) return;
    rt.current?.settle();
    stage.current?.show(preview.result, preview.doc);
    const key = `${preview.result.out.frame.size}:${preview.result.out.frame.heightScale}`;
    if (camera && framedFor.current !== key) { frameWorld(camera, preview.result.out.frame.size, preview.result.out.frame.heightScale); framedFor.current = key; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, camera]);
  // Preview-only edits: the surfaces' look and the water's, applied without a new preview.
  const looksKey = JSON.stringify(doc.surfaces.map(s => [s.id, s.enabled, s.preview]));
  useEffect(() => { stage.current?.refreshMaterials(docRef.current); }, [looksKey]);
  useEffect(() => { stage.current?.setWaterLook(doc.preview.water); }, [doc.preview.water]);

  const frame = () => { if (camera && preview) frameWorld(camera, preview.result.out.frame.size, preview.result.out.frame.heightScale); };

  // --- Painting ---
  const selected = doc.graph.nodes.find(n => n.id === selectedNode) ?? null;
  const paintMaskId = selected?.type === 'paint' && typeof selected.params.mask === 'string' ? selected.params.mask : '';
  const paintMeta = doc.paint.find(m => m.id === paintMaskId) ?? null;
  const painting = paintActive && !!paintMeta;
  const stroke = useRef<{ maskId: string; before: Float32Array; region: MaskRegion | null; last: [number, number] | null; n: number } | null>(null);

  const onStroke = useCallback((u: number, v: number, phase: 'start' | 'move' | 'end') => {
    const d = docRef.current;
    const node = d.graph.nodes.find(n => n.id === selectedNode);
    const meta = d.paint.find(m => m.id === node?.params.mask);
    const pixels = meta ? paint.current[meta.id] : undefined;
    if (!node || !meta || !pixels) return;
    if (phase === 'start') stroke.current = { maskId: meta.id, before: pixels.slice(), region: null, last: null, n: 0 };
    const s = stroke.current;
    if (!s || s.maskId !== meta.id) return;
    // Dabs a third of the radius apart along the pointer's path.
    const from = s.last ?? [u, v];
    const stepMap = Math.max(1e-4, brush.radius / d.settings.size / 3);
    const steps = Math.max(1, Math.ceil(Math.hypot(u - from[0], v - from[1]) / stepMap));
    for (let k = s.last ? 1 : 0; k <= steps; k++) {
      const t = k / steps;
      s.region = unionRegion(s.region, dab(pixels, meta.resolution, meta.signed, d.settings.size, from[0] + (u - from[0]) * t, from[1] + (v - from[1]) * t, brush));
    }
    s.last = [u, v];
    s.n++;
    if (phase !== 'end') {
      // Live: the GPU reads the pixels here; the CPU fallback needs a hash the worker has not cached.
      const liveDoc = { ...d, paint: d.paint.map(m => (m.id === meta.id ? { ...m, hash: `${m.hash}~${s.n}` } : m)) };
      rt.current?.edit(liveDoc, paint.current, node.id);
      return;
    }
    stroke.current = null;
    if (!s.region) return;
    const hash = paintHash(pixels, meta.signed);
    history.current.recordPaint(d, {
      maskId: meta.id, resolution: meta.resolution, region: s.region,
      before: readRegion(s.before, meta.resolution, s.region), after: readRegion(pixels, meta.resolution, s.region),
    });
    setHistoryTick(x => x + 1);
    setDoc({ ...d, paint: d.paint.map(m => (m.id === meta.id ? { ...m, hash } : m)) });
    if (!asset.active) void saveScratchMask(meta.id, pixels);
  }, [selectedNode, brush, setDoc, asset.active]);

  const paintTools: PaintTools = {
    masks: doc.paint, active: paintActive, setActive: setPaintActive, brush, setBrush,
    newMask: signed => {
      const d = docRef.current;
      const node = d.graph.nodes.find(n => n.id === selectedNode);
      if (!node) return;
      const id = newId('mask');
      const resolution = 512;
      const pixels = blankMask(resolution);
      paint.current[id] = pixels;
      const meta: PaintMaskMeta = { id, name: `${signed ? 'Height' : 'Mask'} ${d.paint.length + 1}`, resolution, signed, hash: paintHash(pixels, signed) };
      commit({
        ...d, paint: [...d.paint, meta],
        graph: { ...d.graph, nodes: d.graph.nodes.map(n => (n.id === node.id ? { ...n, params: { ...n.params, mask: id } } : n)) },
      }, 'New mask');
      setPaintActive(true);
      if (!asset.active) void saveScratchMask(id, pixels);
    },
    fill: (maskId, value) => {
      const d = docRef.current;
      const meta = d.paint.find(m => m.id === maskId);
      const pixels = paint.current[maskId];
      if (!meta || !pixels) return;
      const region = { x0: 0, y0: 0, x1: meta.resolution, y1: meta.resolution };
      const before = pixels.slice();
      pixels.fill(Math.max(meta.signed ? -1 : 0, Math.min(1, value)));
      history.current.recordPaint(d, { maskId, resolution: meta.resolution, region, before, after: pixels.slice() }, value ? 'Fill mask' : 'Clear mask');
      setHistoryTick(x => x + 1);
      setDoc({ ...d, paint: d.paint.map(m => (m.id === maskId ? { ...m, hash: paintHash(pixels, m.signed) } : m)) });
      if (!asset.active) void saveScratchMask(maskId, pixels);
    },
  };
  // The Scratch document's store keeps only its current masks.
  useEffect(() => { if (!asset.active) void pruneScratchMasks(doc.paint.map(m => m.id)); }, [paintIds, asset.active]);

  useViewportPaint({
    active: painting, instance, bus, viewport: viewportRef.current,
    landscape: () => stage.current?.landscapeNode ?? null, size: doc.settings.size, onStroke,
  });

  // --- Undo ---
  const undoTo = (r: { doc: WorldDoc; mask?: string } | null) => {
    if (!r) return;
    setHistoryTick(x => x + 1);
    setDoc(r.doc);
    if (r.mask) {
      setPaintVersion(v => v + 1);
      if (!asset.active && paint.current[r.mask]) void saveScratchMask(r.mask, paint.current[r.mask]);
    }
  };
  const undo = {
    undo: () => undoTo(history.current.undo(docRef.current, paint.current)),
    redo: () => undoTo(history.current.redo(docRef.current, paint.current)),
    canUndo: history.current.canUndo, canRedo: history.current.canRedo,
    undoLabel: history.current.undoLabel, redoLabel: history.current.redoLabel,
  };

  // --- Export and the library ---
  /** Every export file of `d` at full resolution: GPU erosion on the main thread when there is any, the rest on a worker. */
  const buildFiles = async (d: WorldDoc, name: string, ctx: GenerateContext) => {
    const reach = liveNodes(d.graph);
    const gpu = hasCompute && d.graph.nodes.some(n => n.enabled && n.type === 'pipe' && reach.has(n.id));
    const terrain = gpu ? await generateWorld(d, span(ctx, 0, 0.5), { pipeGpu: pipeErosionGpu, paint: paint.current }) : undefined;
    return exportOnWorker(d, paint.current, name, gpu ? span(ctx, 0.5, 1) : ctx, terrain);
  };
  /** The painted masks, as the asset stores them. */
  const maskFiles = async (d: WorldDoc): Promise<ExportFile[]> => Promise.all(d.paint.filter(m => paint.current[m.id]).map(async m => ({
    name: paintFileName(m.id, m.signed), mime: 'image/png', bytes: await encodeMask(paint.current[m.id], m.resolution, m.signed),
  })));

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

  // Once edits pause, the world is generated at full resolution and published to the Creator library,
  // which the editor follows. Library files keep fixed `world_*` names (the editor keys its texture ids on
  // them). An edit that changes no export (the preview's look, a node moved on the canvas) re-publishes
  // the document with the files it has.
  const publishedFrom = useRef<WorldDoc | null>(null);
  const published = useRef<{ asset: string; hash: string; files: ExportFile[] } | null>(null);
  useEffect(() => {
    if (!asset.active || publishedFrom.current === doc || !paintReady) return;
    const from = doc;
    const id = asset.active.id;
    const hash = worldExportHash(from);
    const t = setTimeout(async () => {
      const privateFiles = await maskFiles(from);
      if (published.current?.asset === id && published.current.hash === hash) {
        publishedFrom.current = from;
        asset.publish({ from, files: published.current.files, privateFiles });
        return;
      }
      const res = await full.run(ctx => buildFiles(from, 'world', ctx));
      if (!res) return;
      published.current = { asset: id, hash, files: res.files };
      publishedFrom.current = from;
      asset.publish({ from, files: res.files, privateFiles });
    }, published.current?.asset === id && published.current.hash === hash ? 0 : WORLD_PUBLISH_IDLE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, asset.active?.id, paintReady]);

  // Each surface's share of the map, from the preview (what the Surfaces list captions).
  const coverage = useMemo(() => {
    const m = new Map<string, number>();
    if (!preview) return m;
    const p = preview.result;
    const enabled = doc.surfaces.map((s, i) => ({ s, a: p.surfaces.alphas[i] })).filter(e => e.a) as { s: SurfaceLayer; a: Uint8Array }[];
    if (enabled.length !== p.surfaces.alphas.filter(Boolean).length) return m;
    const shares = coverageOf(alphasToWeights(enabled.map(e => e.a), p.surfaces.size));
    enabled.forEach((e, i) => m.set(e.s.id, shares[i]));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview]);

  // --- What each node card says: pending while the realtime preview skips it, a warning when the
  // filter's finest gullies are finer than the preview grid, its time when it last ran. ---
  const reach = useMemo(() => liveNodes(doc.graph), [doc.graph]);
  const badges = useMemo(() => {
    const out: Record<string, NodeBadge> = {};
    const ms = preview?.result.nodeMs ?? {};
    const cell = doc.settings.size / (quality.heights - 1);
    for (const n of doc.graph.nodes) {
      if (realtime.active && realtime.bypassed.includes(n.id)) { out[n.id] = { text: 'Pending', tone: 'warning', title: 'Skipped while you edit live; it runs when the edit pauses.' }; continue; }
      if (!reach.has(n.id) && n.type !== 'output') { out[n.id] = { text: 'Not connected', tone: 'dim', title: 'Nothing the Output reads comes from here, so it does not run.' }; continue; }
      if (n.type === 'erosionFilter' && n.enabled) {
        const p = filterParams(n.params);
        const finest = p.spacing * p.cellScale / Math.pow(Math.max(1.01, p.lacunarity), Math.max(0, p.octaves - 1));
        if (finest < cell * 2) { out[n.id] = { text: 'Finer than preview', tone: 'warning', title: `Its finest gullies (${finest.toFixed(1)} m) are finer than the preview grid resolves (${(cell * 2).toFixed(1)} m): they show in a finer export.` }; continue; }
      }
      if (ms[n.id] > 0) out[n.id] = { text: `${ms[n.id] < 10 ? ms[n.id].toFixed(1) : Math.round(ms[n.id])} ms`, tone: 'dim', title: 'Time it took when it last ran at preview resolution' };
    }
    return out;
  }, [doc.graph, doc.settings.size, quality.heights, preview, realtime, reach]);

  const info = (id: string) => {
    const b = badges[id];
    if (!b) return undefined;
    return b.title;
  };

  const value: WorldState = {
    doc, commit, selectedNode, selectNode, selectedSurface, selectSurface, preview: preview?.result ?? null, coverage,
    mapView, setMapView, presetId, applyPreset, badges, paintTools, onStroke, painting, info,
  };
  const status = full.status.running ? full.status : live.status;
  const filters = doc.graph.nodes.filter(n => n.type === 'erosionFilter' && n.enabled && reach.has(n.id)).length;
  const enabledSurfaces = doc.surfaces.filter((s, i) => i === 0 || s.enabled).length;
  const lakes = preview?.result.fields.water.lakes.length ?? 0;
  const parity = typeof location !== 'undefined' && new URLSearchParams(location.search).has('worldParity');

  const setWater = (patch: Partial<WaterLook>) => setDoc({ ...doc, preview: { ...doc.preview, water: { ...doc.preview.water, ...patch } } });
  const overlay = (
    <ViewportOverlay
      readout={preview && <>
        {realtime.active ? `Live (${realtime.backend === 'gpu' ? 'GPU' : 'CPU'}, ${realtime.ms.toFixed(0)} ms)` : `Preview ${preview.result.out.frame.resolution}²`}
        {' '}· surfaces {preview.result.surfaces.size}² · {preview.result.out.frame.size} m · {reach.size - 1} nodes · {filters} erosion filter{filters === 1 ? '' : 's'} · {enabledSurfaces} surfaces · {lakes} lake{lakes === 1 ? '' : 's'}
        {painting && ' · painting'}
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

  const runParity = async () => {
    if (!selectedNode || !rt.current) { toast.error('Select a node to check'); return; }
    const r = await rt.current.parity(docRef.current, paint.current, selectedNode);
    if (!r) { toast.error('That node cannot run live (or there is no GPU compute)'); return; }
    const ok = r.p999 < 0.05 && r.mean < 0.005;
    const line = `GPU vs CPU over ${r.n} samples: max ${r.max.toFixed(4)} m, p99.9 ${r.p999.toFixed(4)} m, mean ${r.mean.toFixed(5)} m`;
    console.info(`[World parity] ${line}`);
    if (ok) toast.success(line); else toast.error(line);
  };

  return (
    <WorldContext.Provider value={value}>
      <CreatorWorkspace
        id='world' page='creator/world'
        layoutVersion={1}
        bottomHeight={380}
        assetState={asset}
        undo={undo}
        toolbar={(<>
          <Button size='sm' title='A new seed: the same graph, different detail'
                  onClick={() => commit({ ...doc, settings: { ...doc.settings, seed: (doc.settings.seed * 48271 + 11) % 99991 } }, 'New seed')}>New seed</Button>
          {parity && <Button size='sm' title='Run the selected node live on the GPU and on the CPU and compare the heights' onClick={() => void runParity()}>Parity</Button>}
        </>)}
        toolbarStatus={`Live preview: ${hasCompute ? 'GPU' : 'CPU'}`}
        primaryAction={{ label: `Generate ${doc.settings.resolution}² & export`, disabled: full.status.running, onClick: generateAndExport,
                         title: 'Generate at the export resolution, then download the heightmap, the surface maps, the masks and the manifest' }}
        right={[
          { id: 'node', title: 'Node', render: () => <NodePanel /> },
          { id: 'worldSettings', title: 'World', render: () => <SettingsPanel /> },
          { id: 'surfaces', title: 'Surfaces', render: () => <SurfacesTab /> },
          { id: 'export', title: 'Export', render: () => <ExportPanel doc={doc} setDoc={setDoc} /> },
        ]}
        bottom={[
          { id: 'graph', title: 'Graph', render: () => <GraphTab /> },
          { id: 'map', title: 'Map', render: () => <MapPanel />, split: 'right' },
        ]}
        viewport={overlay}
        viewportRef={viewportRef}
        onFrame={frame}
        hotkeys={{
          '[': () => setBrush({ ...brush, radius: Math.max(2, Math.round(brush.radius / 1.25)) }),
          ']': () => setBrush({ ...brush, radius: Math.min(2000, Math.round(brush.radius * 1.25)) }),
        }}
        generation={{ status, onCancel: () => { full.cancel(); live.cancel(); } }} />
    </WorldContext.Provider>
  );
}

// --- Panels -----------------------------------------------------------------------------------------

function GraphTab() {
  const { doc, commit, selectedNode, selectNode, preview, badges } = useWorld();
  const onChange = (graph: WorldGraph, label: string) => commit({ ...doc, graph }, label);
  return <WorldGraphPanel graph={doc.graph} selected={selectedNode} onSelect={selectNode} onChange={onChange}
                          thumbs={preview?.thumbs ?? {}} badges={badges} />;
}

function NodePanel() {
  const { doc, commit, selectedNode, paintTools, info } = useWorld();
  const node = doc.graph.nodes.find(n => n.id === selectedNode) ?? null;
  const setNode = (patch: Partial<GraphNode>, label: string, key?: string) => {
    if (!node) return;
    commit({ ...doc, graph: { ...doc.graph, nodes: doc.graph.nodes.map(n => (n.id === node.id ? { ...n, ...patch } : n)) } }, label, key);
  };
  return (
    <PanelBody>
      <WorldInspector node={node} paint={paintTools} info={node ? info(node.id) : undefined}
                      onRename={name => setNode({ name }, 'Rename node', `${node?.id}:name`)}
                      onParams={(patch, coalesce) => node && setNode({ params: { ...node.params, ...patch } }, `Edit ${node.name}`,
                                                                    coalesce ? `${node.id}:${Object.keys(patch).join(',')}` : undefined)} />
    </PanelBody>
  );
}

function SettingsPanel() {
  const { doc, commit, presetId, applyPreset } = useWorld();
  const preset = WORLD_PRESETS.find(p => p.id === presetId);
  return (
    <PanelBody>
      <PanelHeader kind='World' name={preset?.label ?? 'custom'} presetLabel='World presets' presets={PRESET_ENTRIES}
                   onPreset={p => applyPreset(p.id)}
                   onReset={() => { applyPreset(presetId); toast.success(`Reset to ${preset?.label ?? 'the preset'}.`); }} />
      <Collapsable title='World settings' persistKey='cleo_creator_world_settings'>
        <ParamForm schema={PARAMETER_SETTINGS} values={doc.settings as unknown as Record<string, unknown>}
                   onChange={(patch, c) => commit({ ...doc, settings: { ...doc.settings, ...patch } }, 'World settings', c ? `settings:${Object.keys(patch).join(',')}` : undefined)} />
      </Collapsable>
      <Collapsable title='Lakes' persistKey='cleo_creator_world_lakes'>
        <ParamForm schema={LAKE_SCHEMA} values={doc.water.lakes as unknown as Record<string, unknown>}
                   onChange={(patch, c) => commit({ ...doc, water: { lakes: { ...doc.water.lakes, ...patch } } }, 'Lakes', c ? `lakes:${Object.keys(patch).join(',')}` : undefined)} />
      </Collapsable>
    </PanelBody>
  );
}

function SurfacesTab() {
  const { doc, commit, selectedSurface, selectSurface, coverage, preview } = useWorld();
  const index = doc.surfaces.findIndex(s => s.id === selectedSurface);
  const surface = index >= 0 ? doc.surfaces[index] : null;
  return (
    <PanelBody>
      <SurfacesSection surfaces={doc.surfaces} onChange={surfaces => commit({ ...doc, surfaces }, 'Surfaces')}
                       selected={selectedSurface} select={selectSurface} coverage={coverage} />
      {surface && (
        <SurfaceEditor surface={surface} index={index} surfaces={doc.surfaces} fields={preview?.fields ?? null} alphas={preview?.surfaces ?? null}
                       onChange={patch => commit({ ...doc, surfaces: doc.surfaces.map(s => (s.id === surface.id ? { ...s, ...patch } : s)) }, `Edit ${surface.name}`, `surface:${surface.id}:${Object.keys(patch).join(',')}`)} />
      )}
    </PanelBody>
  );
}

/** A node's thumbnail as a Map picture (what the "Selected node" view shows). */
function thumbPicture(t: { size: number; pixels: Uint8Array } | undefined): MapPicture | null {
  if (!t) return null;
  const rgba = new Uint8ClampedArray(t.size * t.size * 4);
  for (let i = 0; i < t.pixels.length; i++) { const v = t.pixels[i]; rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255; }
  return { width: t.size, height: t.size, rgba };
}

function MapPanel() {
  const { doc, commit, selectedNode, selectedSurface, preview, mapView, setMapView, painting, onStroke, paintTools } = useWorld();
  const looks = JSON.stringify(doc.surfaces.map(s => [s.id, s.preview.kind, s.preview.tint]));
  const picture = useMemo(() => {
    if (!preview) return null;
    if (mapView === 'node') return thumbPicture(selectedNode ? preview.thumbs[selectedNode] : undefined);
    return mapPicture(mapView, preview, doc, selectedSurface);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, mapView, selectedSurface, selectedNode, looks]);
  const handles: MapHandles[] = useMemo(() => doc.graph.nodes
    .filter(n => HAS_CENTER.has(n.type) || HAS_POINTS.has(n.type))
    .filter(n => n.type !== 'gradient' || n.params.mode === 'radial')
    .map(n => ({
      id: n.id, kind: n.type, enabled: n.enabled,
      center: Array.isArray(n.params.center) ? n.params.center as Point2 : undefined,
      radius: typeof n.params.radius === 'number' ? n.params.radius : typeof n.params.extent === 'number' ? n.params.extent : undefined,
      points: Array.isArray(n.params.points) ? n.params.points as Point2[] : undefined,
    })), [doc.graph]);
  const onChange = (id: string, patch: { center?: Point2; points?: Point2[] }) => {
    const n = doc.graph.nodes.find(x => x.id === id);
    if (!n) return;
    commit({ ...doc, graph: { ...doc.graph, nodes: doc.graph.nodes.map(x => (x.id === id ? { ...x, params: { ...x.params, ...patch } } : x)) } },
      `Move ${n.name}`, `${id}:handles`);
  };
  return (
    <div className='flex flex-col h-full'>
      <div className='flex items-center gap-2 px-2 py-1 border-b border-border'>
        <Select value={mapView} onChange={e => setMapView(e.target.value as MapLayerView)}>
          {MAP_VIEWS.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
        </Select>
        <span className='text-dim text-ui-xs truncate'>
          {painting ? 'Painting the selected mask · [ and ] change the size' : 'Drag the selected node\'s handles · double-click adds a point · Alt+click removes one'}
        </span>
      </div>
      <div className='flex-1 min-h-0'>
        <MapView picture={picture} handles={handles} selectedId={selectedNode} onChange={onChange}
                 paint={painting ? { radius: paintTools.brush.radius / doc.settings.size, onStroke } : null} />
      </div>
    </div>
  );
}
