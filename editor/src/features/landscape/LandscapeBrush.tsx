import { useEffect, useRef } from "react";
import { useCleoEngine } from "../EngineContext";
import { useHistory } from "../HistoryContext";
import { Raycaster, LandscapeNode, Logger, unionRegion } from "cleo";
import type { Terrain, SculptTool, SculptParams, BrushSpec, GridRegion, MaskGrid, MaskPatch, MaskRegion, Scene } from "cleo";
import { BrushCursor } from "./brushCursor";
import { lookFromSettings } from "./brushDecal";
import {
    getBrush, setBrush, subscribeBrush, activeStrength, setActiveStrength, strengthSpec,
    type LandscapeBrushSettings,
} from "./landscapeBrushStore";
import { toolForHotkey, modeForHotkey } from "./landscapeTools";
import { getStamp } from "./stampStore";

// ArrayLike, not `Float32Array | number[]`: gl-matrix's `vec3` is `[number, number, number] |
// IndexedCollection`, and IndexedCollection is assignable to neither of those.
type Vec3Like = ArrayLike<number>;

interface Props {
    viewportRef: React.RefObject<HTMLDivElement>;
}

/** Tools whose strength is a RATE (metres per second); the rest move toward a result. */
const RATE_TOOLS: ReadonlySet<SculptTool> = new Set<SculptTool>(['raise', 'lower', 'stamp', 'noise']);
/** A blend strength of 1 applied for one second at 60 dabs moves this much of the way. */
const BLEND_PER_SECOND = 10;

/** Everything a stroke changed, saved as it was before, so one undo step restores it. */
interface StrokeRecord {
    nodeId: string;
    label: string;
    heightsBefore: Float32Array | null;
    heightRegion: GridRegion | null;
    masksBefore: MaskGrid | null;
    maskRegion: MaskRegion | null;
}

/**
 * Viewport-mounted landscape tool, active only in landscape mode. Left-drag ray-casts the active
 * LandscapeNode's terrain and applies the brush the tools panel set up (landscapeBrushStore). The hovered
 * point is marked by a decal projected onto the ground: a gradient of the brush's own weight curve,
 * coloured by tool and as opaque as the strength (see BrushCursor and brushDecal.ts).
 *
 * Modifiers, as Unreal and Unity have them: Shift inverts (raise/lower, paint/erase), Ctrl smooths — or,
 * with Flatten or Set Height, Ctrl+click PICKS the height under the cursor. `[` / `]` size the brush,
 * Shift+`[` / `]` its strength, Ctrl+wheel sizes it too; Q/W/E pick the mode and the digits a tool.
 *
 * Every stroke is ONE undo step: a region diff of the heights and masks it touched (foliage is not
 * recorded). The stroke's dirty signal is the payload-less SCENE_CHANGED on release — see onUp.
 */
export default function LandscapeBrush({ viewportRef }: Props) {
    const { instance, editorScene, eventEmitter, editorMode, terrainBrush, withoutDirty } = useCleoEngine();
    const { push } = useHistory();
    const paintingRef = useRef(false);
    // Whether the open stroke has changed the terrain yet. See onUp.
    const strokeEditedRef = useRef(false);
    const lastTimeRef = useRef(0);
    const cursorRef = useRef<BrushCursor | null>(null);
    // When and where foliage was last scattered during the current stroke; read by foliageDue.
    const lastFoliageRef = useRef({ t: 0, x: NaN, z: NaN });
    const strokeRef = useRef<StrokeRecord | null>(null);
    // The height a Flatten stroke levels to, locked where the stroke starts.
    const flattenTargetRef = useRef<number | null>(null);
    // A Ramp is laid on release, from where the stroke started to where it ends.
    const rampStartRef = useRef<{ x: number; y: number; z: number } | null>(null);
    const pointerRef = useRef({ x: 0, y: 0, moved: false, shift: false, ctrl: false });
    const rafRef = useRef(0);
    /** Mouse buttons currently held, anywhere. Read by the hotkeys — see onKey. */
    const buttonsRef = useRef(0);
    const pushRef = useRef(push);
    pushRef.current = push;

    // One cursor per scene. It is editor-owned and keeps every rule of that itself — see BrushCursor —
    // and disposing it removes the decal from the scene it was built in. Without this every entry into
    // landscape mode left one more hidden cursor behind.
    useEffect(() => {
        if (!editorScene) return;
        const cursor = new BrushCursor(editorScene, withoutDirty);
        cursorRef.current = cursor;
        return () => {
            if (cursorRef.current === cursor) cursorRef.current = null;
            cursor.dispose();
        };
    }, [editorScene]);

    useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport || !instance) return;

        const activeLandscape = (): LandscapeNode | null => {
            const list = Array.from(editorScene.landscapes) as LandscapeNode[];
            const id = terrainBrush.current.activeLandscapeId;
            if (id) { const n = list.find(l => l.id === id); if (n) return n; }
            return list[0] || null;
        };

        const hit = (clientX: number, clientY: number): { node: LandscapeNode, point: Vec3Like } | null => {
            const cam = instance.scene?.activeCamera?.camera;
            if (!cam) return null;
            const rect = viewport.getBoundingClientRect();
            const ray = Raycaster.screenToRay(clientX - rect.left, clientY - rect.top, rect.width, rect.height, cam);
            const node = activeLandscape();
            if (!node) return null;
            const p = node.terrain.raycast(ray.origin, ray.direction);
            return p ? { node, point: p } : null;
        };

        const showCursor = (node: LandscapeNode, point: Vec3Like) =>
            cursorRef.current?.show(node.terrain, point, lookFromSettings(getBrush()));
        const hideCursor = () => cursorRef.current?.hide();
        // A setting moved in the tools panel: re-fit the cursor where it stands, not on the next mouse move.
        const offBrush = subscribeBrush(() => cursorRef.current?.restyle(lookFromSettings(getBrush())));

        // Foliage scatter/erase re-buckets the whole spatial grid, so it is rate-limited while paint is
        // not: due when either enough wall-clock has passed OR the cursor has covered enough ground.
        const FOLIAGE_MIN_MS = 120;
        const FOLIAGE_MIN_TRAVEL = 0.35; // fraction of the brush radius
        const foliageDue = (point: Vec3Like, radius: number): boolean => {
            const now = performance.now(), s = lastFoliageRef.current;
            const moved = Math.hypot(point[0] - s.x, point[2] - s.z) >= radius * FOLIAGE_MIN_TRAVEL;
            if (isFinite(s.x) && now - s.t < FOLIAGE_MIN_MS && !moved) return false;
            s.t = now; s.x = point[0]; s.z = point[2];
            return true;
        };

        // Every terrain write reports whether it changed anything; one that did makes the stroke an edit.
        const edited = (changed: unknown) => { if (changed) strokeEditedRef.current = true; };
        const recordHeights = (region: GridRegion | null) => {
            const s = strokeRef.current;
            if (region && s) s.heightRegion = unionRegion(s.heightRegion, region);
            return region;
        };
        const recordMasks = (region: MaskRegion | null) => {
            const s = strokeRef.current;
            if (region && s) s.maskRegion = unionRegion(s.maskRegion, region);
            return region;
        };

        /** The brush's shape as the terrain takes it. */
        const shapeOf = (b: LandscapeBrushSettings): Omit<BrushSpec, 'x' | 'z'> => ({
            radius: b.radius, falloff: b.falloff, curve: b.curve, shape: b.shape, rotation: b.rotation,
            stamp: b.mode === 'sculpt' && b.sculptTool === 'stamp' ? (getStamp()?.alpha ?? null) : null,
        });

        /** The tool a modifier turns the chosen one into, for this dab. */
        const effectiveTool = (b: LandscapeBrushSettings): SculptTool => {
            const { shift, ctrl } = pointerRef.current;
            if (ctrl && b.sculptTool !== 'flatten' && b.sculptTool !== 'setHeight') return 'smooth';
            if (shift && b.sculptTool === 'raise') return 'lower';
            if (shift && b.sculptTool === 'lower') return 'raise';
            return b.sculptTool;
        };

        const sculpt = (terrain: Terrain, point: Vec3Like, dt: number) => {
            const b = getBrush();
            const tool = effectiveTool(b);
            if (tool === 'ramp') return; // laid on release
            if (tool === 'stamp' && !getStamp()) return;
            const strength = tool === b.sculptTool ? activeStrength(b) : (b.strengths[tool] ?? strengthSpec(tool).initial);
            const rate = RATE_TOOLS.has(tool);
            let amount = rate ? strength * dt : Math.min(1, strength * dt * BLEND_PER_SECOND);
            if (tool === 'stamp' && pointerRef.current.shift) amount = -amount;
            const params: SculptParams = {
                tool, amount,
                target: tool === 'setHeight' ? b.setHeight : (flattenTargetRef.current ?? 0),
                flattenMode: b.flattenMode,
                noiseScale: b.noiseScale, noiseSeed: b.noiseSeed,
                terraceStep: b.terraceStep, terraceSharpness: b.terraceSharpness,
                talusDegrees: b.talusDegrees, iterations: b.erosionIterations,
            };
            edited(recordHeights(terrain.sculptWith(point, shapeOf(b), params)));
        };

        const paint = (node: LandscapeNode, point: Vec3Like, dt: number) => {
            const b = getBrush();
            const terrain = node.terrain;
            const shape = shapeOf(b);
            const flow = Math.min(1, activeStrength(b) * dt * BLEND_PER_SECOND);
            const tool = b.paintTool === 'paint' && pointerRef.current.shift ? 'erase' : b.paintTool;
            if (tool === 'clearToBase') {
                edited(recordMasks(terrain.clearLayersAt(point, shape, flow)));
            } else {
                const layers = terrain.layerStack.paintLayers;
                const layer = layers.find(l => l.id === b.paintLayerId) ?? layers[layers.length - 1];
                if (!layer) {
                    Logger.warn('Add a paint layer in the Layers panel first; there is nothing to paint into.', 'Editor');
                    paintingRef.current = false;
                    return;
                }
                edited(recordMasks(terrain.paintLayerMask(layer.id, point, shape, flow, tool === 'erase' ? 0 : b.targetOpacity)));
            }
            if (foliageDue(point, b.radius)) {
                // Erase FIRST, then scatter: the other order removes what this stroke just placed. Keep only
                // the foliage of whichever layer now dominates under the brush centre.
                const lx = point[0] - terrain.origin[0], lz = point[2] - terrain.origin[2];
                const w = terrain.layerWeightsAt(lx, lz);
                let best = w.base, material = terrain.layerStack.base.material;
                terrain.layerStack.paintLayers.forEach((L, i) => { if (w.paint[i] > best) { best = w.paint[i]; material = L.material; } });
                edited(terrain.eraseFoliageExcept(point as any, b.radius, material ? material.foliageInclude.map(r => r.name) : []));
                edited(terrain.scatterFoliageFromMaterials(point as any, b.radius));
            }
        };

        const apply = (clientX: number, clientY: number, dt: number) => {
            const h = hit(clientX, clientY);
            if (!h) return;
            const b = getBrush();
            if (b.mode === 'paint') paint(h.node, h.point, dt);
            else if (b.mode === 'foliage') {
                if (foliageDue(h.point, b.radius)) {
                    if (b.foliageErase || pointerRef.current.shift) edited(h.node.terrain.eraseAllFoliage(h.point as any, b.radius));
                    else edited(h.node.terrain.scatterFoliageFromMaterials(h.point as any, b.radius));
                }
            }
            else sculpt(h.node.terrain, h.point, dt);
            // After the edit, so the cursor's box is fitted to the ground the stroke just moved.
            showCursor(h.node, h.point);
        };

        // The stroke loop: one dab per frame while the button is held, at the real frame time. Moving the
        // mouse only moves the pointer; with "Hold to apply" off, a frame without movement applies nothing.
        const tick = () => {
            rafRef.current = 0;
            if (!paintingRef.current) return;
            const now = performance.now();
            const dt = Math.min(0.05, (now - lastTimeRef.current) / 1000);
            lastTimeRef.current = now;
            const p = pointerRef.current;
            if (getBrush().continuous || p.moved) apply(p.x, p.y, dt);
            p.moved = false;
            rafRef.current = requestAnimationFrame(tick);
        };

        // Listeners are capture-phase on the viewport, the floating panels' ancestor, so clicks on a panel
        // control must be filtered out here or they start a stroke and never reach the control.
        const inOverlay = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('[data-cleo-overlay]');

        const onDown = (e: MouseEvent) => {
            if (editorMode !== 'landscape' || e.button !== 0) return;
            if (inOverlay(e.target)) return;
            const h = hit(e.clientX, e.clientY);
            if (!h) return;
            const b = getBrush();
            const terrain = h.node.terrain;
            const lx = h.point[0] - terrain.origin[0], lz = h.point[2] - terrain.origin[2];
            e.preventDefault();
            e.stopPropagation();

            // Ctrl+click with a height tool PICKS the height under the cursor; it is not a stroke.
            if (b.mode === 'sculpt' && e.ctrlKey && (b.sculptTool === 'flatten' || b.sculptTool === 'setHeight')) {
                const y = +terrain.heightAt(lx, lz).toFixed(3);
                setBrush({ setHeight: y, ...(b.sculptTool === 'flatten' ? { sculptTool: 'setHeight' as SculptTool } : {}) });
                Logger.info(`Target height ${y} m — Set Height levels to it`, 'Editor');
                return;
            }

            paintingRef.current = true;
            strokeEditedRef.current = false;
            lastTimeRef.current = performance.now();
            // NaN x/z makes the first sample of a fresh stroke always due.
            lastFoliageRef.current = { t: 0, x: NaN, z: NaN };
            pointerRef.current = { x: e.clientX, y: e.clientY, moved: true, shift: e.shiftKey, ctrl: e.ctrlKey };
            flattenTargetRef.current = terrain.heightAt(lx, lz);
            rampStartRef.current = b.mode === 'sculpt' && b.sculptTool === 'ramp'
                ? { x: h.point[0], y: terrain.heightAt(lx, lz), z: h.point[2] } : null;
            // What the undo step will need. Sculpt snapshots the height field, paint the masks — both
            // whole, since a stroke's extent is not known until it ends; only the touched rectangle is kept.
            strokeRef.current = {
                nodeId: h.node.id,
                label: b.mode === 'paint' ? 'Paint landscape' : b.mode === 'foliage' ? 'Foliage' : `Sculpt (${b.sculptTool})`,
                heightsBefore: b.mode === 'sculpt' ? terrain.heights.slice() : null,
                heightRegion: null,
                masksBefore: b.mode === 'paint' ? terrain.layerStack.masks.clone() : null,
                maskRegion: null,
            };
            // Reuses the gizmo suppression so camera + click-selection ignore this drag.
            eventEmitter.emit('GIZMO_DRAG_START', { axis: 'terrain', nodeId: h.node.id });
            if (!rampStartRef.current) apply(e.clientX, e.clientY, 1 / 60);
            if (!rafRef.current) rafRef.current = requestAnimationFrame(tick);
        };

        const onMove = (e: MouseEvent) => {
            if (editorMode !== 'landscape') return;
            if (!paintingRef.current && inOverlay(e.target)) { hideCursor(); return; }
            const p = pointerRef.current;
            p.x = e.clientX; p.y = e.clientY; p.moved = true; p.shift = e.shiftKey; p.ctrl = e.ctrlKey;
            if (paintingRef.current) {
                if (rampStartRef.current) { const h = hit(e.clientX, e.clientY); if (h) showCursor(h.node, h.point); }
                return; // the stroke loop applies
            }
            const h = hit(e.clientX, e.clientY);
            if (h) showCursor(h.node, h.point); else hideCursor();
        };

        /** Lay a ramp from where the stroke started to where it ended. */
        const layRamp = () => {
            const start = rampStartRef.current;
            rampStartRef.current = null;
            if (!start) return;
            const h = hit(pointerRef.current.x, pointerRef.current.y);
            if (!h) return;
            const terrain = h.node.terrain, o = terrain.origin;
            const endY = terrain.heightAt(h.point[0] - o[0], h.point[2] - o[2]);
            const b = getBrush();
            edited(recordHeights(terrain.sculptWith(h.point, shapeOf(b), {
                tool: 'ramp', amount: Math.min(1, activeStrength(b)),
                rampFrom: { x: start.x - o[0], z: start.z - o[2], h: start.y },
                rampTo: { x: h.point[0] - o[0], z: h.point[2] - o[2], h: endY },
            })));
        };

        /** Push the finished stroke as one undo step: the touched rectangle, before and after. */
        const recordStroke = () => {
            const s = strokeRef.current;
            strokeRef.current = null;
            if (!s || (!s.heightRegion && !s.maskRegion)) return;
            const node = editorScene.getNodeById(s.nodeId) as LandscapeNode | null;
            if (!node) return;
            const terrain = node.terrain, R = terrain.resolution;
            let heights: { region: GridRegion; before: Float32Array; after: Float32Array } | null = null;
            if (s.heightRegion && s.heightsBefore) {
                const reg = s.heightRegion;
                const before = new Float32Array((reg.c1 - reg.c0 + 1) * (reg.r1 - reg.r0 + 1));
                const w = reg.c1 - reg.c0 + 1;
                for (let r = reg.r0; r <= reg.r1; r++)
                    before.set(s.heightsBefore.subarray(r * R + reg.c0, r * R + reg.c1 + 1), (r - reg.r0) * w);
                heights = { region: reg, before, after: terrain.readHeights(reg) };
            }
            let masks: { before: MaskPatch[]; after: MaskPatch[] } | null = null;
            if (s.maskRegion && s.masksBefore) {
                const channels = terrain.layerStack.paintLayers.map(l => l.channel);
                const snapshot = s.masksBefore;
                masks = {
                    before: channels.filter(c => c < snapshot.capacity).map(c => snapshot.readPatch(c, s.maskRegion!)),
                    after: terrain.layerStack.readMaskPatches(s.maskRegion),
                };
            }
            const scene: Scene = editorScene;
            const put = (side: 'before' | 'after') => {
                // By id when it runs: an undo of an unrelated edit can re-parse the landscape node.
                const n = scene.getNodeById(s.nodeId) as LandscapeNode | null;
                if (!n) return;
                if (heights) n.terrain.writeHeights(heights.region, heights[side]);
                if (masks) n.terrain.layerStack.writeMaskPatches(masks[side]);
                eventEmitter.emit('SCENE_CHANGED');
                eventEmitter.emit('TERRAIN_EDITED', s.nodeId);
            };
            pushRef.current({ label: s.label, undo: () => put('before'), redo: () => put('after') });
        };

        const onUp = () => {
            if (!paintingRef.current) return;
            paintingRef.current = false;
            if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
            if (rampStartRef.current) layRamp();
            // The stroke's only dirty signal. Height, mask and foliage writes emit nothing, and the one
            // node that does move while painting is the cursor, which is editor chrome and rightly ignored.
            // Payload-less, the established "something changed" form: it marks the active tab unsaved
            // without opening a snapshot interaction — the stroke records its own undo step instead.
            if (strokeEditedRef.current) eventEmitter.emit('SCENE_CHANGED');
            const strokeNodeId = strokeRef.current?.nodeId;
            if (strokeEditedRef.current) {
                recordStroke();
                // The history keeps a per-node baseline for its snapshot diffs; without a refresh the next
                // rename or move of this landscape would record a diff whose undo also reverts the stroke.
                if (strokeNodeId) eventEmitter.emit('TERRAIN_EDITED', strokeNodeId);
            } else strokeRef.current = null;
            strokeEditedRef.current = false;
            eventEmitter.emit('GIZMO_DRAG_END', { axis: null, nodeId: null });
        };

        // --- keyboard -----------------------------------------------------------------------------
        const typing = (t: EventTarget | null) => {
            const el = t as HTMLElement | null;
            return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
        };
        const onKey = (e: KeyboardEvent) => {
            if (editorMode !== 'landscape' || typing(e.target) || e.altKey || e.metaKey) return;
            const b = getBrush();
            if (e.key === 'Escape' && rampStartRef.current) {
                rampStartRef.current = null;
                onUp();
                Logger.info('Ramp cancelled', 'Editor');
                return;
            }
            if (e.ctrlKey) return; // Ctrl+Z and friends belong to the editor
            if (e.key === '[' || e.key === ']') {
                const up = e.key === ']';
                if (e.shiftKey) {
                    const spec = strengthSpec(b.mode === 'sculpt' ? b.sculptTool : b.mode === 'paint' ? b.paintTool : 'foliage');
                    setActiveStrength(activeStrength(b) + (up ? 1 : -1) * Math.max(spec.step, (spec.max - spec.min) / 20));
                } else setBrush({ radius: Math.min(250, Math.max(0.5, +(b.radius * (up ? 1.15 : 1 / 1.15)).toFixed(2))) });
                e.preventDefault();
                return;
            }
            // Q / W / E and the digits only while NO mouse button is held. The editor camera flies on
            // WASD + Q/E gated on the left button (see EDITOR_CAMERA_MAP), and a left-drag that started
            // off the terrain never opened a stroke — so without this, flying forward switched to Paint.
            if (buttonsRef.current) return;
            const mode = modeForHotkey(e.key);
            if (mode && !e.shiftKey) { setBrush({ mode }); e.preventDefault(); return; }
            const tool = toolForHotkey(b.mode, e.key);
            if (tool) {
                setBrush(b.mode === 'sculpt' ? { sculptTool: tool as SculptTool } : { paintTool: tool as LandscapeBrushSettings['paintTool'] });
                e.preventDefault();
            }
        };
        // Ctrl+wheel sizes the brush. Capture phase on the viewport, and stopped there, so the camera's
        // wheel zoom on the canvas below never sees it (and the page zoom never runs).
        const onWheel = (e: WheelEvent) => {
            if (editorMode !== 'landscape' || !e.ctrlKey) return;
            e.preventDefault();
            e.stopPropagation();
            const b = getBrush();
            setBrush({ radius: Math.min(250, Math.max(0.5, +(b.radius * (e.deltaY < 0 ? 1.1 : 1 / 1.1)).toFixed(2))) });
        };

        if (editorMode !== 'landscape') hideCursor();

        const trackButtons = (e: MouseEvent) => { buttonsRef.current = e.buttons; };

        viewport.addEventListener('mousedown', onDown, true);
        window.addEventListener('mousedown', trackButtons, true);
        window.addEventListener('mouseup', trackButtons, true);
        viewport.addEventListener('wheel', onWheel, { capture: true, passive: false });
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        window.addEventListener('keydown', onKey);
        return () => {
            offBrush();
            viewport.removeEventListener('mousedown', onDown, true);
            viewport.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            window.removeEventListener('mousedown', trackButtons, true);
            window.removeEventListener('mouseup', trackButtons, true);
            // Unmounted mid-stroke (the mode changed with the button held): the mouseup this was waiting
            // for will never arrive, so close the stroke here — its edits still count, and the camera
            // must get its input back.
            onUp();
        };
    }, [instance, editorScene, eventEmitter, editorMode, terrainBrush, viewportRef]);

    return null;
}
