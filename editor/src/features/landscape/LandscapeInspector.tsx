import { useEffect, useState } from "react";
import { useCleoEngine, TerrainTool, TerrainBrushMode } from "../EngineContext";
import TerrainLayerSlot from "./TerrainLayerSlot";
import { Hint, Select, Toggle } from "../../components/ui";
import { useActiveLandscape } from "./useActiveLandscape";

const TOOLS: { id: TerrainTool; label: string }[] = [
    { id: 'raise', label: 'Raise' },
    { id: 'lower', label: 'Lower' },
    { id: 'smooth', label: 'Smooth' },
    { id: 'flatten', label: 'Flatten' },
];

/**
 * Floating tool card shown while landscape mode is active: sculpt, paint terrain materials onto the 4
 * layers, and scatter each painted material's foliage.
 *
 * Editing only — a landscape is CREATED from the scene tree's Add menu, its size/resolution and heightmap
 * live on its node inspector, and it is positioned with the ordinary transform gizmo in scene mode. Same
 * split as the tilemap: the mode holds the brushes, the node holds what the thing is.
 */
export default function LandscapeInspector() {
    const { eventEmitter, terrainBrush } = useCleoEngine();
    const { node, landscapes, select } = useActiveLandscape();

    const [mode, setMode] = useState<TerrainBrushMode>(terrainBrush.current.mode);
    const [tool, setTool] = useState<TerrainTool>(terrainBrush.current.tool);
    const [radius, setRadius] = useState(terrainBrush.current.radius);
    const [strength, setStrength] = useState(terrainBrush.current.strength);
    const [falloff, setFalloff] = useState(terrainBrush.current.falloff);
    const [paintLayer, setPaintLayer] = useState(0);
    const [foliageErase, setFoliageErase] = useState(false);
    /** Outcome of the last whole-terrain generation, shown under the button. */
    const [foliageStatus, setFoliageStatus] = useState('');

    // Keep the shared brush ref in sync with the UI.
    useEffect(() => {
        const b = terrainBrush.current;
        b.mode = mode; b.tool = tool; b.radius = radius; b.strength = strength; b.falloff = falloff;
        b.paintLayer = paintLayer; b.foliageErase = foliageErase;
        eventEmitter.emit('TERRAIN_BRUSH_CHANGED');
    }, [mode, tool, radius, strength, falloff, paintLayer, foliageErase, terrainBrush, eventEmitter]);

    // Regenerating replaces every scattered instance, so confirm before discarding work — and report what
    // happened either way. The old version returned a boolean nobody read, which made a mis-set-up terrain
    // (no foliage-bearing material on any layer) look identical to a working one that placed nothing.
    const generateFoliage = () => {
        if (!node) return;
        const existing = node.terrain.foliage.reduce((n, f) => n + f.count, 0);
        if (existing > 0 && !window.confirm(
            `Replace ${existing.toLocaleString()} existing foliage instances across this terrain?`)) return;

        const result = node.terrain.generateFoliageEverywhere();
        if (result.reason === 'no-rules')
            setFoliageStatus('No foliage placed: no terrain material assigned to a paint layer defines any foliage. Add foliage under the “Terrain Mat.” tab, then assign that material to a layer.');
        else if (result.reason === 'no-coverage')
            setFoliageStatus('No foliage placed: no painted region is dominated by a layer whose material includes foliage (or every candidate point was excluded).');
        else
            setFoliageStatus(
                `Placed ${result.placed.toLocaleString()} instances across ${result.layers} layer(s).` +
                (result.reason === 'clipped' ? ' Hit the 200,000-instance ceiling — lower the density.' : ''));
        eventEmitter.emit('SCENE_CHANGED');
    };

    const label = 'text-xs text-gray-300';
    const modeBtn = (m: TerrainBrushMode, text: string) =>
        <button className={`flex-1 rounded px-2 py-1 text-xs ${mode === m ? 'bg-selected' : 'bg-control hover:bg-control-hover'}`} onClick={() => setMode(m)}>{text}</button>;

    if (!node) {
        return (
            <div data-cleo-overlay className="absolute top-2 left-2 z-20 w-64 rounded-md border border-control bg-surface-raised/95 p-3 text-white shadow-lg">
                <Hint>No landscape in this scene. Add one from the scene tree’s Add menu.</Hint>
            </div>
        );
    }

    return (
        <div data-cleo-overlay className="absolute top-2 left-2 z-20 w-64 max-h-[85%] overflow-y-auto bg-surface-raised/95 border border-control rounded-md p-3 text-white shadow-lg select-none">
            <div className="font-semibold text-sm mb-2">Landscape</div>

            {landscapes.length > 1 && (
                <Select
                    className="text-xs mb-2"
                    value={node.id}
                    onChange={(e) => select(e.target.value)}
                    title="Which landscape the brush edits"
                >
                    {landscapes.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </Select>
            )}

            <div className="grid grid-cols-3 gap-1 mb-2">{modeBtn('sculpt', 'Sculpt')}{modeBtn('paint', 'Paint')}{modeBtn('foliage', 'Foliage')}</div>

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
                    <TerrainLayerSlot landscape={node} layerIndex={paintLayer} />
                </div>
            )}

            {mode === 'foliage' && (
                <div className="mb-2 space-y-2">
                    <div className="flex items-center justify-between">
                        <span className={label}>Erase mode</span>
                        <Toggle checked={foliageErase} onChange={setFoliageErase} />
                    </div>
                    <button className="w-full bg-success hover:bg-success-hover rounded px-2 py-1 text-xs" onClick={generateFoliage}>Generate Foliage (whole terrain)</button>
                    {foliageStatus && <p className="text-[10px] text-gray-300 bg-surface/60 rounded px-1.5 py-1">{foliageStatus}</p>}
                    <p className="text-[10px] text-gray-400">
                        The brush scatters each painted material’s foliage (and skips excluded types), and so
                        does the Paint tool. Define a material’s foliage in the “Terrain Mat.” tab, then paint
                        that material here.
                    </p>
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

            <Hint className="mt-2">
                Size, resolution and the heightmap live on the Landscape node. Move it with the gizmo in
                Scene mode.
            </Hint>
        </div>
    );
}
