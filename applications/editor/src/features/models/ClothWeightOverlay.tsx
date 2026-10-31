import { useEffect } from "react";
import { Geometry, Material, Model, ModelNode, markEditorOwned } from "cleo";
import { useCleoEngine } from "../EngineContext";
import { clothTarget, getClothBrush, subscribeClothBrush, subscribeClothPaint, workingCopy } from "./clothBrushStore";

/** Weight bands the heat map is drawn in: one mesh each, so a stroke rebuilds a handful of small meshes. */
const BUCKETS = 8;
/** How far the heat map stands off the surface, in metres (taken into the mesh's own units). */
const LIFT = 0.0015;
const PREFIX = '__editor__cloth_weights_';

/** Blue (barely free) through green to red (fully free). */
function bandColor(band: number): [number, number, number] {
    const t = (band + 0.5) / BUCKETS;
    if (t < 0.5) { const k = t / 0.5; return [0.15, 0.35 + 0.5 * k, 1 - 0.75 * k]; }
    const k = (t - 0.5) / 0.5;
    return [0.15 + 0.85 * k, 0.85 - 0.6 * k, 0.25 - 0.1 * k];
}

/**
 * The Cloth brush's heat map: the painted mesh's cloth weights drawn over it while Paint is on. Each
 * triangle with any weight lands in one of eight bands by the mean weight of its corners; unpainted
 * triangles get nothing, so the model shows through. The bands are editor-owned children of the mesh, so
 * they follow it and are never saved.
 */
export default function ClothWeightOverlay() {
    const { editorScene, editorMode, modelSession, withoutDirty } = useCleoEngine();

    useEffect(() => {
        if (!editorScene || editorMode !== 'model') return;
        const rootId = modelSession?.levelIds[0];
        let shown: { parent: ModelNode; nodes: ModelNode[] } | null = null;
        let raf = 0;

        const clear = () => {
            if (!shown) return;
            const { parent, nodes } = shown;
            shown = null;
            withoutDirty(() => { for (const n of nodes) { try { parent.removeChild(n); } catch { /* gone */ } } });
        };

        const build = () => {
            raf = 0;
            clear();
            const b = getClothBrush();
            if (!b.painting || b.preview) return;
            const node = clothTarget(rootId ? editorScene.getNodeById(rootId) : null);
            if (!node) return;
            const { weights } = workingCopy(node);
            const g = node.model.geometry;
            const pos = g.positions, nor = g.normals, ix = g.indices;
            const m = node.worldTransform;
            const scale = Math.hypot(m[0], m[1], m[2]) || 1;
            const lift = LIFT / scale;
            const bands: number[][] = Array.from({ length: BUCKETS }, () => []);
            for (let t = 0; t + 2 < ix.length; t += 3) {
                const w = (weights[ix[t]] + weights[ix[t + 1]] + weights[ix[t + 2]]) / 3;
                if (w <= 0.001) continue;
                const band = bands[Math.min(BUCKETS - 1, Math.floor(w * BUCKETS))];
                for (let k = 0; k < 3; k++) {
                    const v = ix[t + k] * 3;
                    const hasNormal = nor.length > v + 2;
                    band.push(
                        pos[v] + (hasNormal ? nor[v] * lift : 0),
                        pos[v + 1] + (hasNormal ? nor[v + 1] * lift : 0),
                        pos[v + 2] + (hasNormal ? nor[v + 2] * lift : 0));
                }
            }
            const nodes: ModelNode[] = [];
            withoutDirty(() => {
                bands.forEach((flat, i) => {
                    if (!flat.length) return;
                    const count = flat.length / 3;
                    const positions = new Float32Array(flat);
                    const normals = new Float32Array(count * 3);
                    for (let v = 0; v < count; v++) normals[v * 3 + 1] = 1;
                    const indices = new Uint32Array(count);
                    for (let v = 0; v < count; v++) indices[v] = v;
                    const geometry = new Geometry(positions, normals, new Float32Array(count * 2), undefined, undefined, indices, false);
                    const material = Material.Basic({ color: bandColor(i), opacity: 0.65 },
                        { transparent: true, castShadow: false, side: 'double', depthNudge: 1e-4 });
                    const band = markEditorOwned(new ModelNode(`${PREFIX}${i}`, new Model(geometry, material)));
                    node.addChild(band);
                    nodes.push(band);
                });
            });
            shown = { parent: node, nodes };
        };
        // One rebuild per frame however many dabs land in it.
        const schedule = () => { if (!raf) raf = requestAnimationFrame(build); };

        schedule();
        const offPaint = subscribeClothPaint(schedule);
        // Only what changes the picture: not the radius or the strength.
        const keyOf = () => { const b = getClothBrush(); return `${b.painting}|${b.preview}|${b.targetId}`; };
        let key = keyOf();
        const offBrush = subscribeClothBrush(() => { const k = keyOf(); if (k !== key) { key = k; schedule(); } });
        return () => {
            offPaint();
            offBrush();
            if (raf) cancelAnimationFrame(raf);
            clear();
        };
    }, [editorScene, editorMode, modelSession, withoutDirty]);

    return null;
}
