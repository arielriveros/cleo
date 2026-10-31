import { useEffect, useRef } from "react";
import { mat4, quat, vec3 } from "gl-matrix";
import { Raycaster, markEditorOwned, clothBrushDab, clothFillPiece } from "cleo";
import type { ModelNode, SkinnedClothData } from "cleo";
import { useCleoEngine } from "../EngineContext";
import { useHistory } from "../HistoryContext";
import { wireModel } from "../../utils/editorHelpers";
import {
    announceClothEdit, clothHistoryEntry, clothTarget, commitCloth, getClothBrush, setClothBrush, storedCloth,
    subscribeClothBrush, workingCopy,
} from "./clothBrushStore";

interface Props {
    viewportRef: React.RefObject<HTMLDivElement>;
}

/** A dab at strength 1 for one second at 60 dabs moves this much of the way. */
const FLOW_PER_SECOND = 10;
const RING_SEGMENTS = 48;
const RING_COLOR: [number, number, number] = [1, 0.85, 0.3];
const ERASE_COLOR: [number, number, number] = [0.4, 0.75, 1];

/** A unit circle in the XY plane, for the brush ring (scaled to the radius, turned to the surface). */
function ringLines() {
    const positions: [number, number, number][] = [];
    const indices: number[] = [];
    for (let i = 0; i < RING_SEGMENTS; i++) {
        const a = (i / RING_SEGMENTS) * Math.PI * 2;
        positions.push([Math.cos(a), Math.sin(a), 0]);
        indices.push(i, (i + 1) % RING_SEGMENTS);
    }
    // A tick along the normal, so the ring reads as standing on the surface.
    positions.push([0, 0, 0], [0, 0, 0.5]);
    indices.push(RING_SEGMENTS, RING_SEGMENTS + 1);
    return { positions, indices };
}

/** World metres to the mesh's own units (an unscaled FBX can be in centimetres under a 0.01 parent). */
const localRadius = (node: ModelNode, metres: number) => {
    const m = node.worldTransform;
    const scale = Math.hypot(m[0], m[1], m[2]);
    return scale > 1e-9 ? metres / scale : metres;
};

interface Hit { node: ModelNode; point: vec3; normal: vec3; triangle: number }

/**
 * Viewport-mounted cloth weight brush, active in model mode while the Cloth section's Paint is on. Left-
 * drag paints the targeted skinned mesh's cloth weights (clothBrushStore): what simulates, and how freely.
 *
 * The model tab holds the BIND pose (its scene does not animate), so the ray is cast against the mesh's
 * own bind positions — the cursor ray is taken into the mesh's local space and tested on its BVH.
 *
 * Shift erases, Ctrl smooths; `[` / `]` and Ctrl+wheel size the brush. Every stroke is one undo step,
 * recorded as the stored cloth object before and after (each commit makes a new one).
 */
export default function ClothBrush({ viewportRef }: Props) {
    const { instance, editorScene, eventEmitter, editorMode, modelSession, withoutDirty } = useCleoEngine();
    const { push } = useHistory();
    const pushRef = useRef(push);
    pushRef.current = push;

    useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport || !instance || !editorScene || editorMode !== 'model') return;
        const rootId = modelSession?.levelIds[0];
        const root = () => (rootId ? editorScene.getNodeById(rootId) : null);

        // --- cursor ring ------------------------------------------------------------------------------
        let ring: ModelNode | null = null;
        let ringParent: ModelNode | null = null;
        const hideRing = () => {
            if (!ring) return;
            const r = ring, parent = ringParent;
            ring = null; ringParent = null;
            withoutDirty(() => { try { parent?.removeChild(r); } catch { /* gone with the tab */ } });
        };
        const showRing = (h: Hit, erase: boolean) => {
            if (ring && ringParent !== h.node) hideRing();
            if (!ring) {
                const made = markEditorOwned(wireModel('__editor__cloth_brush', ringLines(), erase ? ERASE_COLOR : RING_COLOR));
                withoutDirty(() => h.node.addChild(made));
                ring = made; ringParent = h.node;
            }
            const r = ring;
            const turn = quat.rotationTo(quat.create(), [0, 0, 1], h.normal);
            withoutDirty(() => {
                r.setPosition(vec3.scaleAndAdd(vec3.create(), h.point, h.normal, localRadius(h.node, 0.002)));
                r.setQuaternion(turn);
                r.setUniformScale(localRadius(h.node, getClothBrush().radius));
            });
        };

        // --- picking ----------------------------------------------------------------------------------
        const inverse = mat4.create();
        const hit = (clientX: number, clientY: number): Hit | null => {
            const cam = instance.scene?.activeCamera?.camera;
            const node = clothTarget(root());
            if (!cam || !node) return null;
            const rect = viewport.getBoundingClientRect();
            const ray = Raycaster.screenToRay(clientX - rect.left, clientY - rect.top, rect.width, rect.height, cam);
            if (!mat4.invert(inverse, node.worldTransform)) return null;
            const origin = vec3.transformMat4(vec3.create(), ray.origin, inverse);
            const rotOnly = mat4.clone(inverse);
            rotOnly[12] = 0; rotOnly[13] = 0; rotOnly[14] = 0;
            const direction = vec3.transformMat4(vec3.create(), ray.direction, rotOnly);
            const geometry = node.model.geometry;
            const h = geometry.bvh.raycast(origin, direction);
            if (!h) return null;
            const p = geometry.positions, ix = geometry.indices, t = h.triangle * 3;
            const at = (k: number) => vec3.fromValues(p[ix[t + k] * 3], p[ix[t + k] * 3 + 1], p[ix[t + k] * 3 + 2]);
            const a = at(0), b = at(1), c = at(2);
            const normal = vec3.cross(vec3.create(), vec3.sub(vec3.create(), b, a), vec3.sub(vec3.create(), c, a));
            vec3.normalize(normal, normal);
            // Face the camera: a back face's normal would sink the ring into the mesh.
            if (vec3.dot(normal, direction) > 0) vec3.negate(normal, normal);
            return { node, point: h.point, normal, triangle: h.triangle };
        };

        // --- the stroke -------------------------------------------------------------------------------
        let painting = false;
        let changed = false;
        let stroke: { nodeId: string; before: SkinnedClothData | null } | null = null;
        let raf = 0;
        let last = 0;
        const pointer = { x: 0, y: 0, shift: false, ctrl: false };

        const toolNow = () => {
            const b = getClothBrush();
            if (b.tool === 'fill') return 'fill' as const;
            if (pointer.ctrl) return 'smooth' as const;
            if (pointer.shift) return b.tool === 'erase' ? 'paint' as const : 'erase' as const;
            return b.tool;
        };

        const apply = (dt: number) => {
            const h = hit(pointer.x, pointer.y);
            if (!h) return;
            const b = getClothBrush();
            const tool = toolNow();
            const copy = workingCopy(h.node);
            const geometry = h.node.model.geometry;
            let touched: number[];
            if (tool === 'fill') {
                // Kept inside the material under the cursor: cloth and armour often share a seam.
                const t = h.triangle * 3;
                const range = h.node.model.submeshes.find(s => t >= s.start && t < s.start + s.count);
                const seed = geometry.indices[t];
                touched = clothFillPiece(geometry.indices, copy.twins, copy.weights, seed,
                    pointer.shift ? 0 : b.value, range?.start ?? 0, range?.count ?? geometry.indices.length);
            } else {
                touched = clothBrushDab(geometry.positions, copy.weights, copy.twins, {
                    center: [h.point[0], h.point[1], h.point[2]], radius: localRadius(h.node, b.radius),
                    strength: Math.min(1, b.strength * dt * FLOW_PER_SECOND), falloff: b.falloff,
                    mode: tool, value: b.value,
                }, tool === 'smooth' ? copy.neighbours : null);
            }
            if (touched.length) { changed = true; commitCloth(copy); }
            showRing(h, tool === 'erase');
        };

        const tick = () => {
            raf = 0;
            if (!painting) return;
            const now = performance.now();
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            // A held, still brush keeps flowing (so a soft brush builds up), as the landscape brush can.
            apply(dt);
            raf = requestAnimationFrame(tick);
        };

        const inOverlay = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('[data-cleo-overlay]');

        const onDown = (e: MouseEvent) => {
            if (!getClothBrush().painting || e.button !== 0 || inOverlay(e.target)) return;
            Object.assign(pointer, { x: e.clientX, y: e.clientY, shift: e.shiftKey, ctrl: e.ctrlKey });
            const h = hit(e.clientX, e.clientY);
            if (!h) return;
            e.preventDefault();
            e.stopPropagation();
            const node = h.node;
            stroke = { nodeId: node.id, before: storedCloth(node) };
            painting = true;
            changed = false;
            last = performance.now();
            eventEmitter.emit('GIZMO_DRAG_START', { axis: 'cloth', nodeId: node.id });
            if (getClothBrush().tool === 'fill') { apply(1); onUp(); return; }
            apply(1 / 60);
            if (!raf) raf = requestAnimationFrame(tick);
        };

        const onMove = (e: MouseEvent) => {
            if (!getClothBrush().painting) { hideRing(); return; }
            Object.assign(pointer, { x: e.clientX, y: e.clientY, shift: e.shiftKey, ctrl: e.ctrlKey });
            if (painting) return; // the stroke loop applies
            if (inOverlay(e.target)) { hideRing(); return; }
            const h = hit(e.clientX, e.clientY);
            if (h) showRing(h, toolNow() === 'erase'); else hideRing();
        };

        const onUp = () => {
            if (!painting) return;
            painting = false;
            if (raf) { cancelAnimationFrame(raf); raf = 0; }
            const s = stroke;
            stroke = null;
            if (changed && s) {
                const node = editorScene.getNodeById(s.nodeId) as ModelNode | null;
                const after = node ? storedCloth(node) : null;
                pushRef.current(clothHistoryEntry(editorScene, eventEmitter, s.nodeId, 'Paint cloth', s.before, after));
                announceClothEdit(eventEmitter, s.nodeId);
            }
            changed = false;
            eventEmitter.emit('GIZMO_DRAG_END', { axis: null, nodeId: null });
        };

        const typing = (t: EventTarget | null) => {
            const el = t as HTMLElement | null;
            return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
        };
        const resize = (factor: number) => {
            const r = getClothBrush().radius;
            setClothBrush({ radius: Math.min(2, Math.max(0.005, +(r * factor).toFixed(4))) });
        };
        const onKey = (e: KeyboardEvent) => {
            if (!getClothBrush().painting || typing(e.target) || e.altKey || e.metaKey || e.ctrlKey) return;
            if (e.key === '[' || e.key === ']') { resize(e.key === ']' ? 1.15 : 1 / 1.15); e.preventDefault(); }
            else if (e.key === 'Escape') { setClothBrush({ painting: false }); e.preventDefault(); }
        };
        const onWheel = (e: WheelEvent) => {
            if (!getClothBrush().painting || !e.ctrlKey) return;
            e.preventDefault();
            e.stopPropagation();
            resize(e.deltaY < 0 ? 1.1 : 1 / 1.1);
        };
        // The ring follows the radius as it is changed in the panel, and goes when painting is turned off.
        const offBrush = subscribeClothBrush(() => {
            const b = getClothBrush();
            if (!b.painting || b.preview) hideRing();
            else if (ring && ringParent) { const r = ring, n = ringParent; withoutDirty(() => r.setUniformScale(localRadius(n, b.radius))); }
        });

        viewport.addEventListener('mousedown', onDown, true);
        viewport.addEventListener('wheel', onWheel, { capture: true, passive: false });
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        window.addEventListener('keydown', onKey);
        return () => {
            offBrush();
            viewport.removeEventListener('mousedown', onDown, true);
            viewport.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            window.removeEventListener('keydown', onKey);
            onUp();
            hideRing();
        };
    }, [instance, editorScene, eventEmitter, editorMode, modelSession, viewportRef, withoutDirty]);

    return null;
}
