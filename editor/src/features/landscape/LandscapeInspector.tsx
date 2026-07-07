import { useEffect, useState } from "react";
import { Terrain, LandscapeNode, TextureManager, FoliageLayer, Model } from "cleo";
import { useCleoEngine, TerrainTool, TerrainBrushMode } from "../EngineContext";

const TOOLS: { id: TerrainTool; label: string }[] = [
    { id: 'raise', label: 'Raise' },
    { id: 'lower', label: 'Lower' },
    { id: 'smooth', label: 'Smooth' },
    { id: 'flatten', label: 'Flatten' },
];

type LayerUI = { textureId: string; tiling: number; auto: boolean; hMin: number; hMax: number; sMin: number; sMax: number };
const defaultLayer = (): LayerUI => ({ textureId: '', tiling: 20, auto: false, hMin: 0, hMax: 100, sMin: 0, sMax: 1 });

/** Floating panel shown while landscape mode is active: create/import terrain, sculpt, and paint layers. */
export default function LandscapeInspector() {
    const { editorScene, eventEmitter, terrainBrush } = useCleoEngine();

    const [size, setSize] = useState(200);
    const [resolution, setResolution] = useState(129);
    const [amplitude, setAmplitude] = useState(30);
    const [mode, setMode] = useState<TerrainBrushMode>(terrainBrush.current.mode);
    const [tool, setTool] = useState<TerrainTool>(terrainBrush.current.tool);
    const [radius, setRadius] = useState(terrainBrush.current.radius);
    const [strength, setStrength] = useState(terrainBrush.current.strength);
    const [falloff, setFalloff] = useState(terrainBrush.current.falloff);
    const [hasTerrain, setHasTerrain] = useState(false);
    const [paintLayer, setPaintLayer] = useState(0);
    const [layers, setLayers] = useState<LayerUI[]>([defaultLayer(), defaultLayer(), defaultLayer(), defaultLayer()]);
    const [textureIds, setTextureIds] = useState<string[]>([]);
    const [foliageLayer, setFoliageLayer] = useState(0);
    const [foliageErase, setFoliageErase] = useState(false);
    const [newFoliageTex, setNewFoliageTex] = useState('');
    const [foliageVersion, setFoliageVersion] = useState(0); // bump to re-read terrain.foliage

    // Keep the shared brush ref in sync with the UI.
    useEffect(() => {
        const b = terrainBrush.current;
        b.mode = mode; b.tool = tool; b.radius = radius; b.strength = strength; b.falloff = falloff;
        b.paintLayer = paintLayer; b.foliageLayer = foliageLayer; b.foliageErase = foliageErase;
    }, [mode, tool, radius, strength, falloff, paintLayer, foliageLayer, foliageErase, terrainBrush]);

    useEffect(() => {
        const refreshTerrain = () => setHasTerrain(Array.from(editorScene.landscapes).length > 0);
        const refreshTextures = () => setTextureIds(
            Array.from(TextureManager.Instance.textures.keys()).filter(id => !id.startsWith('__editor__') && !id.startsWith('__debug__'))
        );
        refreshTerrain(); refreshTextures();
        eventEmitter.on('SCENE_CHANGED', refreshTerrain);
        eventEmitter.on('TEXTURES_CHANGED', refreshTextures);
        return () => { eventEmitter.off('SCENE_CHANGED', refreshTerrain); eventEmitter.off('TEXTURES_CHANGED', refreshTextures); };
    }, [editorScene, eventEmitter]);

    const activeLandscape = (): LandscapeNode | null => {
        const list = Array.from(editorScene.landscapes) as LandscapeNode[];
        const id = terrainBrush.current.activeLandscapeId;
        if (id) { const n = list.find(l => l.id === id); if (n) return n; }
        return list[0] || null;
    };

    const createTerrain = () => {
        const terrain = new Terrain({ size, resolution });
        const node = new LandscapeNode('Landscape', terrain);
        editorScene.addNode(node);
        terrainBrush.current.activeLandscapeId = node.id;
        eventEmitter.emit('SCENE_CHANGED');
        eventEmitter.emit('SELECT_NODE', node.id);
        setHasTerrain(true);
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

    const addBillboardFoliage = () => {
        const node = activeLandscape();
        if (!node) { alert('Create a terrain first.'); return; }
        if (!newFoliageTex) { alert('Pick a texture for the grass billboard.'); return; }
        node.terrain.addFoliage(FoliageLayer.Billboard(`grass_${node.terrain.foliage.length}`, newFoliageTex));
        setFoliageLayer(node.terrain.foliage.length - 1);
        setFoliageVersion(v => v + 1);
    };
    const addMeshFoliage = (files: FileList | null) => {
        const node = activeLandscape();
        if (!node) { alert('Create a terrain first.'); return; }
        if (!files || files.length === 0) return;
        Model.fromFile({ files: Array.from(files) }).then(models => {
            if (!models.length) return;
            node.terrain.addFoliage(FoliageLayer.Mesh(models[0].name, models[0].model));
            setFoliageLayer(node.terrain.foliage.length - 1);
            setFoliageVersion(v => v + 1);
        }).catch(err => console.error(err));
    };

    const commitLayer = (index: number, next: LayerUI) => {
        const node = activeLandscape();
        if (!node) return;
        node.terrain.setLayer(index, {
            textureId: next.textureId || null,
            tiling: next.tiling,
            auto: next.auto,
            hRange: [next.hMin, next.hMax],
            sRange: [next.sMin, next.sMax],
        });
    };
    const updateLayer = (index: number, patch: Partial<LayerUI>) => {
        setLayers(prev => {
            const nextLayers = prev.slice();
            const next = { ...nextLayers[index], ...patch };
            nextLayers[index] = next;
            commitLayer(index, next);
            return nextLayers;
        });
    };

    const label = 'text-xs text-gray-300';
    const num = 'w-14 bg-[#2b2b2b] text-white border border-[#444] rounded px-1 py-[2px] text-xs';
    const modeBtn = (m: TerrainBrushMode, text: string) =>
        <button className={`flex-1 rounded px-2 py-1 text-xs ${mode === m ? 'bg-[#2c2cff]' : 'bg-[#3b3b3b] hover:bg-[#4a4a4a]'}`} onClick={() => setMode(m)}>{text}</button>;

    return (
        <div className="absolute top-2 left-2 z-20 w-64 max-h-[85%] overflow-y-auto bg-[#252525]/95 border border-[#3b3b3b] rounded-md p-3 text-white shadow-lg select-none">
            <div className="font-semibold text-sm mb-2">Landscape</div>

            <div className="mb-3 border-b border-[#3b3b3b] pb-3">
                <div className="flex items-center justify-between mb-1">
                    <span className={label}>Size</span>
                    <input type="number" className={num} value={size} min={10} onChange={e => setSize(Number(e.target.value))} />
                </div>
                <div className="flex items-center justify-between mb-2">
                    <span className={label}>Resolution</span>
                    <input type="number" className={num} value={resolution} min={8} max={513} onChange={e => setResolution(Number(e.target.value))} />
                </div>
                <button className="w-full bg-[#2c7a2c] hover:bg-[#358535] rounded px-2 py-1 text-xs" onClick={createTerrain}>Create Terrain</button>
            </div>

            <div className="flex gap-1 mb-2">{modeBtn('sculpt', 'Sculpt')}{modeBtn('paint', 'Paint')}{modeBtn('foliage', 'Foliage')}</div>

            {mode === 'sculpt' && (
                <div className="mb-2">
                    <div className={`${label} mb-1`}>Tool</div>
                    <div className="grid grid-cols-2 gap-1">
                        {TOOLS.map(t => (
                            <button key={t.id}
                                className={`rounded px-2 py-1 text-xs ${tool === t.id ? 'bg-[#2c2cff]' : 'bg-[#3b3b3b] hover:bg-[#4a4a4a]'}`}
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
                                className={`rounded px-2 py-1 text-xs ${paintLayer === i ? 'bg-[#2c2cff]' : 'bg-[#3b3b3b] hover:bg-[#4a4a4a]'}`}
                                onClick={() => setPaintLayer(i)}>{i}</button>
                        ))}
                    </div>
                    {(() => {
                        const L = layers[paintLayer];
                        return (
                            <div className="space-y-1 border border-[#3b3b3b] rounded p-2">
                                <div className="flex items-center justify-between">
                                    <span className={label}>Texture</span>
                                    <select className={`${num} w-32`} value={L.textureId} onChange={e => updateLayer(paintLayer, { textureId: e.target.value })}>
                                        <option value="">(none)</option>
                                        {textureIds.map(id => <option key={id} value={id}>{id.length > 18 ? id.slice(0, 17) + '…' : id}</option>)}
                                    </select>
                                </div>
                                <div className="flex items-center justify-between">
                                    <span className={label}>Tiling</span>
                                    <input type="number" className={num} value={L.tiling} onChange={e => updateLayer(paintLayer, { tiling: Number(e.target.value) })} />
                                </div>
                                <label className="flex items-center justify-between cursor-pointer">
                                    <span className={label}>Auto (height/slope)</span>
                                    <input type="checkbox" checked={L.auto} onChange={e => updateLayer(paintLayer, { auto: e.target.checked })} />
                                </label>
                                {L.auto && <>
                                    <div className="flex items-center justify-between">
                                        <span className={label}>Height min/max</span>
                                        <span className="flex gap-1">
                                            <input type="number" className={num} value={L.hMin} onChange={e => updateLayer(paintLayer, { hMin: Number(e.target.value) })} />
                                            <input type="number" className={num} value={L.hMax} onChange={e => updateLayer(paintLayer, { hMax: Number(e.target.value) })} />
                                        </span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <span className={label}>Slope min/max</span>
                                        <span className="flex gap-1">
                                            <input type="number" step={0.05} className={num} value={L.sMin} onChange={e => updateLayer(paintLayer, { sMin: Number(e.target.value) })} />
                                            <input type="number" step={0.05} className={num} value={L.sMax} onChange={e => updateLayer(paintLayer, { sMax: Number(e.target.value) })} />
                                        </span>
                                    </div>
                                </>}
                            </div>
                        );
                    })()}
                </div>
            )}

            {mode === 'foliage' && (() => {
                const node = activeLandscape();
                const list = node ? node.terrain.foliage : [];
                const active = list[foliageLayer];
                return (
                    <div className="mb-2 space-y-2" data-version={foliageVersion}>
                        <div className="border border-[#3b3b3b] rounded p-2 space-y-1">
                            <div className={label}>Add grass billboard</div>
                            <div className="flex gap-1">
                                <select className={`${num} flex-1`} value={newFoliageTex} onChange={e => setNewFoliageTex(e.target.value)}>
                                    <option value="">(texture)</option>
                                    {textureIds.map(id => <option key={id} value={id}>{id.length > 16 ? id.slice(0, 15) + '…' : id}</option>)}
                                </select>
                                <button className="bg-[#2c7a2c] hover:bg-[#358535] rounded px-2 text-xs" onClick={addBillboardFoliage}>+</button>
                            </div>
                            <label className="block bg-[#3b3b3b] hover:bg-[#4a4a4a] rounded px-2 py-1 text-xs text-center cursor-pointer">
                                Add mesh prop (import)
                                <input type="file" className="hidden" accept=".obj,.gltf,.glb" multiple onChange={e => addMeshFoliage(e.target.files)} />
                            </label>
                        </div>

                        {list.length > 0 && (
                            <div>
                                <div className={`${label} mb-1`}>Layers</div>
                                <div className="flex flex-wrap gap-1 mb-2">
                                    {list.map((f, i) => (
                                        <button key={i} className={`rounded px-2 py-1 text-xs ${foliageLayer === i ? 'bg-[#2c2cff]' : 'bg-[#3b3b3b] hover:bg-[#4a4a4a]'}`} onClick={() => setFoliageLayer(i)}>{f.name}</button>
                                    ))}
                                </div>
                                {active && (
                                    <div className="border border-[#3b3b3b] rounded p-2 space-y-1">
                                        <div className="flex items-center justify-between">
                                            <span className={label}>Density</span>
                                            <input type="number" className={num} value={active.params.density} onChange={e => { active.params.density = Number(e.target.value); setFoliageVersion(v => v + 1); }} />
                                        </div>
                                        <div className="flex items-center justify-between">
                                            <span className={label}>Scale min/max</span>
                                            <span className="flex gap-1">
                                                <input type="number" step={0.1} className={num} value={active.params.minScale} onChange={e => { active.params.minScale = Number(e.target.value); setFoliageVersion(v => v + 1); }} />
                                                <input type="number" step={0.1} className={num} value={active.params.maxScale} onChange={e => { active.params.maxScale = Number(e.target.value); setFoliageVersion(v => v + 1); }} />
                                            </span>
                                        </div>
                                        <label className="flex items-center justify-between cursor-pointer">
                                            <span className={label}>Erase mode</span>
                                            <input type="checkbox" checked={foliageErase} onChange={e => setFoliageErase(e.target.checked)} />
                                        </label>
                                        <div className="text-[10px] text-gray-400">Instances: {active.count}</div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                );
            })()}

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

            <div className="mt-3 border-t border-[#3b3b3b] pt-3">
                <div className="flex items-center justify-between mb-1">
                    <span className={label}>Amplitude</span>
                    <input type="number" className={num} value={amplitude} onChange={e => setAmplitude(Number(e.target.value))} />
                </div>
                <div className="flex gap-1">
                    <label className="flex-1 bg-[#3b3b3b] hover:bg-[#4a4a4a] rounded px-2 py-1 text-xs text-center cursor-pointer">
                        Import
                        <input type="file" className="hidden" accept=".png,.jpg,.jpeg,.bmp" onChange={e => importHeightmap(e.target.files)} />
                    </label>
                    <button className="flex-1 bg-[#3b3b3b] hover:bg-[#4a4a4a] rounded px-2 py-1 text-xs" onClick={exportHeightmap}>Export</button>
                </div>
            </div>

            {!hasTerrain && <div className="text-[10px] text-gray-400 mt-2">Create a terrain, then left-drag in the viewport to sculpt or paint.</div>}
        </div>
    );
}
