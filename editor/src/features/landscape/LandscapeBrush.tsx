import { useEffect, useRef } from "react";
import { useCleoEngine } from "../EngineContext";
import { Raycaster, ModelNode, Model, Geometry, Material, LandscapeNode, markEditorOnly } from "cleo";

// ArrayLike, not `Float32Array | number[]`: gl-matrix's `vec3` is `[number, number, number] |
// IndexedCollection`, and IndexedCollection is assignable to neither of those.
type Vec3Like = ArrayLike<number>;

interface Props {
    viewportRef: React.RefObject<HTMLDivElement>;
}

/**
 * Viewport-mounted terrain sculpt/paint tool, active only in landscape mode. Left-drag ray-casts the
 * active LandscapeNode's terrain and applies the current brush; a wireframe ring marks the hovered point.
 */
export default function LandscapeBrush({ viewportRef }: Props) {
    const { instance, editorScene, eventEmitter, editorMode, terrainBrush } = useCleoEngine();
    const paintingRef = useRef(false);
    const lastTimeRef = useRef(0);
    const cursorRef = useRef<ModelNode | null>(null);
    // When and where foliage was last scattered during the current stroke; read by foliageDue.
    const lastFoliageRef = useRef({ t: 0, x: NaN, z: NaN });

    // Unit-radius line loop. calculateTangents must stay false: Geometry.Circle's tangent path is broken.
    const buildRingGeometry = (segments = 48): Geometry => {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];
        for (let i = 0; i < segments; i++) {
            const a = (i / segments) * Math.PI * 2;
            positions.push([Math.cos(a), Math.sin(a), 0]);
            normals.push([0, 0, 1]);
            uvs.push([0, 0]);
        }
        for (let i = 0; i < segments; i++) indices.push(i, (i + 1) % segments);
        return new Geometry(positions, normals, uvs, [], [], indices, false);
    };

    // The `__editor__` name prefix keeps the cursor out of selection and serialization.
    const ensureCursor = (): ModelNode | null => {
        if (!editorScene) return null;
        if (cursorRef.current) return cursorRef.current;
        const ring = new ModelNode(
            '__editor__terrainBrush',
            new Model(buildRingGeometry(48), Material.Basic({ color: [1, 0.9, 0.2] }, { wireframe: true, castShadow: false }))
        );
        // Chrome: this routes the cursor into the renderer's overlay layer, past the post chain, so
        // the brush ring cannot bloom or smear into depth of field. The name prefix does not do this.
        markEditorOnly(ring);
        ring.setRotation([-90, 0, 0]); // lie flat on the ground (XZ)
        ring.visible = false;
        editorScene.addNode(ring);
        cursorRef.current = ring;
        return ring;
    };

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

        const showCursor = (point: Vec3Like) => {
            const c = ensureCursor();
            if (!c) return;
            c.visible = true;
            c.setPosition([point[0], point[1] + 0.05, point[2]]);
            const r = terrainBrush.current.radius;
            c.setScale([r, r, r]);
        };
        const hideCursor = () => { if (cursorRef.current) cursorRef.current.visible = false; };

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

        const apply = (clientX: number, clientY: number, dt: number) => {
            const h = hit(clientX, clientY);
            if (!h) return;
            const b = terrainBrush.current;
            if (b.mode === 'paint') {
                h.node.terrain.paint(h.point as any, { radius: b.radius, strength: b.strength, falloff: b.falloff, layer: b.paintLayer }, dt);
                if (foliageDue(h.point, b.radius)) {
                    // Erase FIRST, then scatter: the other order removes what this stroke just placed.
                    const m = h.node.terrain.layers[b.paintLayer]?.material;
                    h.node.terrain.eraseFoliageExcept(h.point as any, b.radius, m ? m.foliageInclude.map(r => r.name) : []);
                    h.node.terrain.scatterFoliageFromMaterials(h.point as any, b.radius);
                }
            }
            else if (b.mode === 'foliage') {
                if (foliageDue(h.point, b.radius)) {
                    if (b.foliageErase) h.node.terrain.eraseAllFoliage(h.point as any, b.radius);
                    else h.node.terrain.scatterFoliageFromMaterials(h.point as any, b.radius);
                }
            }
            else
                h.node.terrain.sculpt(h.point as any, { radius: b.radius, strength: b.strength, falloff: b.falloff, mode: b.tool }, dt);
            showCursor(h.point);
        };

        // Listeners are capture-phase on the viewport, the floating panels' ancestor, so clicks on a panel
        // control must be filtered out here or they start a stroke and never reach the control.
        const inOverlay = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('[data-cleo-overlay]');

        const onDown = (e: MouseEvent) => {
            if (editorMode !== 'landscape' || e.button !== 0) return;
            if (inOverlay(e.target)) return;
            const h = hit(e.clientX, e.clientY);
            if (!h) return;
            paintingRef.current = true;
            lastTimeRef.current = performance.now();
            // NaN x/z makes the first sample of a fresh stroke always due.
            lastFoliageRef.current = { t: 0, x: NaN, z: NaN };
            // Reuses the gizmo suppression so camera + click-selection ignore this drag.
            eventEmitter.emit('GIZMO_DRAG_START', { axis: 'terrain', nodeId: h.node.id });
            apply(e.clientX, e.clientY, 1 / 60);
            e.preventDefault();
            e.stopPropagation();
        };

        const onMove = (e: MouseEvent) => {
            if (editorMode !== 'landscape') return;
            if (!paintingRef.current && inOverlay(e.target)) { hideCursor(); return; }
            const now = performance.now();
            const dt = Math.min(0.05, (now - lastTimeRef.current) / 1000);
            lastTimeRef.current = now;
            if (paintingRef.current) apply(e.clientX, e.clientY, dt);
            else { const h = hit(e.clientX, e.clientY); if (h) showCursor(h.point); else hideCursor(); }
        };

        const onUp = () => {
            if (!paintingRef.current) return;
            paintingRef.current = false;
            eventEmitter.emit('GIZMO_DRAG_END', { axis: null, nodeId: null });
        };

        if (editorMode === 'landscape') ensureCursor();
        else hideCursor();

        viewport.addEventListener('mousedown', onDown, true);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            viewport.removeEventListener('mousedown', onDown, true);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [instance, editorScene, eventEmitter, editorMode, terrainBrush, viewportRef]);

    return null;
}
