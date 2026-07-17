import { useEffect, useState } from "react";
import { Terrain, LandscapeNode } from "cleo";
import { useCleoEngine, TerrainTool, TerrainBrushMode } from "../EngineContext";
import TerrainLayerSlot from "./TerrainLayerSlot";
import { Toggle } from "../../components/ui";

const TOOLS: { id: TerrainTool; label: string }[] = [
    { id: 'raise', label: 'Raise' },
    { id: 'lower', label: 'Lower' },
    { id: 'smooth', label: 'Smooth' },
    { id: 'flatten', label: 'Flatten' },
];

/** Floating panel shown while landscape mode is active: create/import terrain, sculpt, paint terrain
 *  materials onto the 4 layers, and scatter each painted material's foliage. */
export default function LandscapeInspector() {
    const { editorScene, eventEmitter, terrainBrush, setGizmoMode } = useCleoEngine();

    const [size, setSize] = useState(200);
    const [resolution, setResolution] = useState(129);
    const [chunkQuads, setChunkQuads] = useState(32);
    const [amplitude, setAmplitude] = useState(30);
    const [mode, setMode] = useState<TerrainBrushMode>(terrainBrush.current.mode);
    const [tool, setTool] = useState<TerrainTool>(terrainBrush.current.tool);
    const [radius, setRadius] = useState(terrainBrush.current.radius);
    const [strength, setStrength] = useState(terrainBrush.current.strength);
    const [falloff, setFalloff] = useState(terrainBrush.current.falloff);
    const [hasTerrain, setHasTerrain] = useState(false);
    const [paintLayer, setPaintLayer] = useState(0);
    const [foliageErase, setFoliageErase] = useState(false);

    // Keep the shared brush ref in sync with the UI.
    useEffect(() => {
        const b = terrainBrush.current;
        b.mode = mode; b.tool = tool; b.radius = radius; b.strength = strength; b.falloff = falloff;
        b.paintLayer = paintLayer; b.foliageErase = foliageErase;
        if (mode === 'move') setGizmoMode('position'); // the terrain move-gizmo is a position gizmo
        eventEmitter.emit('TERRAIN_BRUSH_CHANGED'); // let the viewport mount/unmount the terrain gizmo
    }, [mode, tool, radius, strength, falloff, paintLayer, foliageErase, terrainBrush, setGizmoMode, eventEmitter]);

    useEffect(() => {
        const refreshTerrain = () => setHasTerrain(Array.from(editorScene.landscapes).length > 0);
        refreshTerrain();
        eventEmitter.on('SCENE_CHANGED', refreshTerrain);
        return () => { eventEmitter.off('SCENE_CHANGED', refreshTerrain); };
    }, [editorScene, eventEmitter]);

    const activeLandscape = (): LandscapeNode | null => {
        const list = Array.from(editorScene.landscapes) as LandscapeNode[];
        const id = terrainBrush.current.activeLandscapeId;
        if (id) { const n = list.find(l => l.id === id); if (n) return n; }
        return list[0] || null;
    };

    // Create the single terrain, or — if one already exists — rebuild it at the new size/resolution while
    // preserving the sculpted shape (resampled), the layer materials, and regenerating foliage everywhere.
    const createOrUpdateTerrain = () => {
        const existing = activeLandscape();
        if (existing) {
            const old = existing.terrain;
            const next = new Terrain({ size, resolution, chunkQuads });
            next.resampleHeightsFrom(old);
            for (let i = 0; i < old.layers.length && i < 4; i++) {
                const L = old.layers[i];
                if (L.material) next.setLayer(i, L.material, { tiling: L.tiling, auto: L.auto, hRange: L.hRange, sRange: L.sRange, materialId: L.materialId ?? null });
            }
            existing.setTerrain(next);
            next.generateFoliageEverywhere();
            eventEmitter.emit('SCENE_CHANGED');
            return;
        }
        const terrain = new Terrain({ size, resolution, chunkQuads });
        const node = new LandscapeNode('Landscape', terrain);
        editorScene.addNode(node);
        terrainBrush.current.activeLandscapeId = node.id;
        eventEmitter.emit('SCENE_CHANGED');
        eventEmitter.emit('SELECT_NODE', node.id);
        setHasTerrain(true);
    };

    const generateFoliage = () => {
        const node = activeLandscape();
        if (!node) { alert('Create a terrain first.'); return; }
        node.terrain.generateFoliageEverywhere();
        eventEmitter.emit('SCENE_CHANGED');
    };

    const importHeightmap = (files: FileList | null) => {
        if (!files || files.length === 0) return;
        const node = activeLandscape();
        if (!node) { alert('Create a terrain first.'); return; }
        const reader = new FileReader();
        reader.onload = (e) => node.terrain.importHeightmap(e.target?.result as string, amplitude).catch(err => console.error(err));
        reader.readAsDataURL(files[0]);
    };

    const exportHeightmap = () => {
        const node = activeLandscape();
        if (!node) { alert('Create a terrain first.'); return; }
        const a = document.createElement('a');
        a.href = node.terrain.exportHeightmap();
        a.download = 'heightmap.png';
        a.click();
    };

    const label = 'text-xs text-gray-300';
    const num = 'w-14 bg-surface-raised text-white border border-control-hover rounded px-1 py-[2px] text-xs';
    const modeBtn = (m: TerrainBrushMode, text: string) =>
        <button className={`flex-1 rounded px-2 py-1 text-xs ${mode === m ? 'bg-selected' : 'bg-control hover:bg-control-hover'}`} onClick={() => setMode(m)}>{text}</button>;

    return (
        <div data-cleo-overlay className="absolute top-2 left-2 z-20 w-64 max-h-[85%] overflow-y-auto bg-surface-raised/95 border border-control rounded-md p-3 text-white shadow-lg select-none">
            <div className="font-semibold text-sm mb-2">Landscape</div>

            <div className="mb-3 border-b border-control pb-3">
                <div className="flex items-center justify-between mb-1">
                    <span className={label}>Size</span>
                    <input type="number" className={num} value={size} min={10} onChange={e => setSize(Number(e.target.value))} />
                </div>
                <div className="flex items-center justify-between mb-1">
                    <span className={label}>Resolution</span>
                    <input type="number" className={num} value={resolution} min={8} max={513} onChange={e => setResolution(Number(e.target.value))} />
                </div>
                <div className="flex items-center justify-between mb-2">
                    <span className={label} title="Quads per side of each render chunk: the unit of frustum culling and distance LOD.">Chunk</span>
                    <input type="number" className={num} value={chunkQuads} min={8} max={64} step={8} onChange={e => setChunkQuads(Number(e.target.value))} />
                </div>
                <button className="w-full bg-success hover:bg-success-hover rounded px-2 py-1 text-xs" onClick={createOrUpdateTerrain}>{hasTerrain ? 'Update Terrain' : 'Create Terrain'}</button>
                {hasTerrain && <div className="text-[10px] text-gray-400 mt-1">Update rebuilds the terrain at the new size/resolution, keeps materials + shape, and refills foliage.</div>}
                <div className="text-[10px] text-gray-400 mt-1">Smaller chunks = finer culling &amp; LOD granularity, more draw calls.</div>
            </div>

            <div className="grid grid-cols-4 gap-1 mb-2">{modeBtn('sculpt', 'Sculpt')}{modeBtn('paint', 'Paint')}{modeBtn('foliage', 'Foliage')}{modeBtn('move', 'Move')}</div>

            {mode === 'sculpt' && (
                <div className="mb-2">
                    <div className={`${label} mb-1`}>Tool</div>
                    <div className="grid grid-cols-2 gap-1">
                        {TOOLS.map(t => (
                            <button key={t.id}
                                className={`rounded px-2 py-1 text-xs ${tool === t.id ? 'bg-selected' : 'bg-control hover:bg-control-hover'}`}
                                onClick={() => setTool(t.id)}>{t.label}</button>
                        ))}
                    </div>
                </div>
            )}

            {mode === 'paint' && (
                <div className="mb-2">
                    <div className={`${label} mb-1`}>Active layer</div>
                    <div className="grid grid-cols-4 gap-1 mb-2">
                        {[0, 1, 2, 3].map(i => (
                            <button key={i}
                                className={`rounded px-2 py-1 text-xs ${paintLayer === i ? 'bg-selected' : 'bg-control hover:bg-control-hover'}`}
                                onClick={() => setPaintLayer(i)}>{i}</button>
                        ))}
                    </div>
                    <TerrainLayerSlot landscape={activeLandscape()} layerIndex={paintLayer} />
                </div>
            )}

            {mode === 'foliage' && (
                <div className="mb-2 space-y-2">
                    <div className="flex items-center justify-between">
                        <span className={label}>Erase mode</span>
                        <Toggle checked={foliageErase} onChange={setFoliageErase} />
                    </div>
                    <button className="w-full bg-success hover:bg-success-hover rounded px-2 py-1 text-xs" onClick={generateFoliage}>Generate Foliage (whole terrain)</button>
                    <p className="text-[10px] text-gray-400">
                        The brush scatters each painted material’s foliage (and skips excluded types).
                        Define a material’s foliage in the “Terrain Mat.” tab, then paint that material here.
                    </p>
                </div>
            )}

            {mode === 'move' && (
                <div className="mb-2">
                    <p className="text-[10px] text-gray-400">Drag the vertical gizmo in the viewport to raise/lower the whole terrain.</p>
                </div>
            )}

            <div className="space-y-2 mt-2">
                <div>
                    <div className="flex justify-between"><span className={label}>Radius</span><span className={label}>{radius.toFixed(1)}</span></div>
                    <input type="range" className="w-full" min={1} max={100} step={0.5} value={radius} onChange={e => setRadius(Number(e.target.value))} />
                </div>
                <div>
                    <div className="flex justify-between"><span className={label}>Strength</span><span className={label}>{strength.toFixed(1)}</span></div>
                    <input type="range" className="w-full" min={0.5} max={50} step={0.5} value={strength} onChange={e => setStrength(Number(e.target.value))} />
                </div>
                <div>
                    <div className="flex justify-between"><span className={label}>Falloff</span><span className={label}>{falloff.toFixed(2)}</span></div>
                    <input type="range" className="w-full" min={0} max={1} step={0.05} value={falloff} onChange={e => setFalloff(Number(e.target.value))} />
                </div>
            </div>

            <div className="mt-3 border-t border-control pt-3">
                <div className="flex items-center justify-between mb-1">
                    <span className={label}>Amplitude</span>
                    <input type="number" className={num} value={amplitude} onChange={e => setAmplitude(Number(e.target.value))} />
                </div>
                <div className="flex gap-1">
                    <label className="flex-1 bg-control hover:bg-control-hover rounded px-2 py-1 text-xs text-center cursor-pointer">
                        Import
                        <input type="file" className="hidden" accept=".png,.jpg,.jpeg,.bmp" onChange={e => importHeightmap(e.target.files)} />
                    </label>
                    <button className="flex-1 bg-control hover:bg-control-hover rounded px-2 py-1 text-xs" onClick={exportHeightmap}>Export</button>
                </div>
            </div>

            {!hasTerrain && <div className="text-[10px] text-gray-400 mt-2">Create a terrain, then left-drag in the viewport to sculpt or paint.</div>}
        </div>
    );
}
