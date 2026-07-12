import { useEffect, useRef } from "react";
import { useCleoEngine } from "../EngineContext";
import { Raycaster, ModelNode, Model, Geometry, Material, LandscapeNode } from "cleo";

type Vec3Like = Float32Array | number[];

interface Props {
    viewportRef: React.RefObject<HTMLDivElement>;
}

/**
 * Viewport-mounted terrain sculpting tool (modelled on PositionGizmo). Active only in landscape mode.
 * Owns pointer listeners: left-drag ray-casts the active LandscapeNode's terrain and applies the current
 * brush, suppressing camera movement + selection via the existing GIZMO_DRAG_* events. Shows a wireframe
 * ring cursor at the hovered surface point.
 */
export default function LandscapeBrush({ viewportRef }: Props) {
    const { instance, editorScene, eventEmitter, editorMode, terrainBrush } = useCleoEngine();
    const paintingRef = useRef(false);
    const lastTimeRef = useRef(0);
    const cursorRef = useRef<ModelNode | null>(null);

    // A flat wireframe ring (unit radius) built as a line loop. Uses calculateTangents=false to avoid the
    // buggy tangent path in Geometry.Circle, and needs no tangents for a Basic wireframe material anyway.
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

    // Lazily create the ring cursor once; keep it out of selection/serialization via the __editor__ prefix.
    const ensureCursor = (): ModelNode | null => {
        if (!editorScene) return null;
        if (cursorRef.current) return cursorRef.current;
        const ring = new ModelNode(
            '__editor__terrainBrush',
            new Model(buildRingGeometry(48), Material.Basic({ color: [1, 0.9, 0.2] }, { wireframe: true, castShadow: false }))
        );
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
            return p ? { node, point: p as Vec3Like } : null;
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

        const apply = (clientX: number, clientY: number, dt: number) => {
            const h = hit(clientX, clientY);
            if (!h) return;
            const b = terrainBrush.current;
            if (b.mode === 'paint')
                h.node.terrain.paint(h.point as any, { radius: b.radius, strength: b.strength, falloff: b.falloff, layer: b.paintLayer }, dt);
            else if (b.mode === 'foliage') {
                // Material-driven: scatter each painted material's included foliage; erase clears all near the point.
                if (b.foliageErase) h.node.terrain.eraseAllFoliage(h.point as any, b.radius);
                else h.node.terrain.scatterFoliageFromMaterials(h.point as any, b.radius);
            }
            else
                h.node.terrain.sculpt(h.point as any, { radius: b.radius, strength: b.strength, falloff: b.falloff, mode: b.tool }, dt);
            showCursor(h.point);
        };

        // The brush listens in the capture phase on the viewport (the panel's ancestor), so a click on a
        // floating panel control would otherwise start a stroke and never reach the control. Bail on those.
        const inOverlay = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('[data-cleo-overlay]');

        const onDown = (e: MouseEvent) => {
            if (editorMode !== 'landscape' || e.button !== 0) return;
            if (inOverlay(e.target)) return;
            const h = hit(e.clientX, e.clientY);
            if (!h) return;
            paintingRef.current = true;
            lastTimeRef.current = performance.now();
            // Reuse the gizmo suppression so camera + click-selection ignore this drag.
            eventEmitter.emit('GIZMO_DRAG_START', { axis: 'terrain', nodeId: h.node.id });
            apply(e.clientX, e.clientY, 1 / 60);
            e.preventDefault();
            e.stopPropagation();
        };

        const onMove = (e: MouseEvent) => {
            if (editorMode !== 'landscape') return;
            // While hovering a floating panel (and not mid-stroke), don't preview/apply the brush.
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
