import { useCallback, useEffect, useRef, useState } from 'react';
import { Node, UINode, UIRootNode } from 'cleo';
import { useCleoEngine } from '../EngineContext';

/**
 * Direct manipulation for the selected UI element: drag to move, eight grips to resize.
 *
 * Everything is expressed as a delta on `offsetMin` / `offsetMax`, which works out simpler than it sounds.
 * The solve is
 *
 *     minX = parent.x + anchorMin.x * parent.width + offsetMin.x
 *
 * and the anchors, the parent rect and the root scale are all fixed for the duration of a drag — so a
 * change in an edge's position IS the change in its offset, on a pinned and a stretched axis alike. There
 * is no per-mode branch anywhere below.
 */

/** Which edges a grip moves. `null` on an axis means "leave it alone". */
type Grip = { key: string; x: 'min' | 'max' | null; y: 'min' | 'max' | null; cursor: string };

const GRIPS: Grip[] = [
    { key: 'nw', x: 'min', y: 'min', cursor: 'nwse-resize' },
    { key: 'n', x: null, y: 'min', cursor: 'ns-resize' },
    { key: 'ne', x: 'max', y: 'min', cursor: 'nesw-resize' },
    { key: 'w', x: 'min', y: null, cursor: 'ew-resize' },
    { key: 'e', x: 'max', y: null, cursor: 'ew-resize' },
    { key: 'sw', x: 'min', y: 'max', cursor: 'nesw-resize' },
    { key: 's', x: null, y: 'max', cursor: 'ns-resize' },
    { key: 'se', x: 'max', y: 'max', cursor: 'nwse-resize' },
];

/** Screen pixels within which a dragged edge snaps to a guide. */
const SNAP_PX = 6;

const GRIP_SIZE = 8;

/** The root that owns this element's coordinate space, and therefore its scale. */
function rootOf(node: UINode): UIRootNode | null {
    for (let n: Node | null = node; n; n = n.parent) if (n instanceof UIRootNode) return n as UIRootNode;
    return null;
}

/** Snap `value` to the nearest guide within `tolerance`, else return it unchanged. */
function snap(value: number, guides: number[], tolerance: number): number {
    let best = value;
    let bestDist = tolerance;
    for (const g of guides) {
        const d = Math.abs(value - g);
        if (d < bestDist) { bestDist = d; best = g; }
    }
    return best;
}

export default function UIEditorTools() {
    const { editorScene, eventEmitter, selectedNode } = useCleoEngine();
    // Bumped when the tracked rect moves; see the rAF below.
    const [, setTick] = useState(0);
    const dragRef = useRef<{
        grip: Grip | null;
        startX: number;
        startY: number;
        offsetMin: [number, number];
        offsetMax: [number, number];
        scale: number;
        guidesX: number[];
        guidesY: number[];
        rectX: number;
        rectY: number;
        rectW: number;
        rectH: number;
    } | null>(null);

    const node = selectedNode ? editorScene?.getNodeById(selectedNode) : null;
    // Roots are excluded: a screen root IS the viewport, and a world root is placed by its scene transform
    // (which keeps the ordinary 3D gizmo).
    const target = node instanceof UINode && !(node instanceof UIRootNode) ? node : null;

    // The handles read `screenRect`, which the layout pass rewrites every frame. Without a per-frame
    // re-render they would lag the element during a drag, and drift away entirely when a world-space
    // ancestor moves.
    useEffect(() => {
        if (!target) return;
        let raf = 0;
        let lastKey = '';
        const tick = () => {
            // Re-render only when the rect actually moved. The handles must track a dragging or
            // camera-driven element, but a settled selection is the common case and should cost nothing —
            // an unconditional setState here would re-render every frame for the entire session.
            const r = target.screenRect;
            const key = `${r.x},${r.y},${r.width},${r.height}`;
            if (key !== lastKey) { lastKey = key; setTick(t => t + 1); }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [target]);

    const onPointerDown = useCallback((e: React.PointerEvent, grip: Grip | null) => {
        if (!target) return;
        e.stopPropagation();
        e.preventDefault();

        const root = rootOf(target);
        const scale = root && root.scaleFactor > 0 ? root.scaleFactor : 1;
        const parent = target.parent instanceof UINode ? target.parent : null;
        const pr = parent ? parent.rect : root ? root.rect : { x: 0, y: 0, width: 0, height: 0 };

        dragRef.current = {
            grip,
            startX: e.clientX,
            startY: e.clientY,
            offsetMin: [...target.offsetMin] as [number, number],
            offsetMax: [...target.offsetMax] as [number, number],
            scale,
            // Guides in the same absolute reference space the rects live in: the parent's edges and centre.
            guidesX: [pr.x, pr.x + pr.width / 2, pr.x + pr.width],
            guidesY: [pr.y, pr.y + pr.height / 2, pr.y + pr.height],
            rectX: target.rect.x,
            rectY: target.rect.y,
            rectW: target.rect.width,
            rectH: target.rect.height,
        };

        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }, [target]);

    const onPointerMove = useCallback((e: React.PointerEvent) => {
        const drag = dragRef.current;
        if (!drag || !target) return;
        e.stopPropagation();

        // Screen pixels to reference units. Everything below is in reference units.
        let dx = (e.clientX - drag.startX) / drag.scale;
        let dy = (e.clientY - drag.startY) / drag.scale;
        const tol = e.altKey ? 0 : SNAP_PX / drag.scale;

        const { grip } = drag;
        const min: [number, number] = [...drag.offsetMin] as [number, number];
        const max: [number, number] = [...drag.offsetMax] as [number, number];

        if (!grip) {
            // Body drag: snap whichever edge lands on a guide first, then move both by the same amount so
            // the element translates rather than resizes.
            const left = snap(drag.rectX + dx, drag.guidesX, tol);
            const right = snap(drag.rectX + drag.rectW + dx, drag.guidesX, tol);
            dx = Math.abs(left - (drag.rectX + dx)) <= Math.abs(right - (drag.rectX + drag.rectW + dx))
                ? left - drag.rectX
                : right - (drag.rectX + drag.rectW);

            const top = snap(drag.rectY + dy, drag.guidesY, tol);
            const bottom = snap(drag.rectY + drag.rectH + dy, drag.guidesY, tol);
            dy = Math.abs(top - (drag.rectY + dy)) <= Math.abs(bottom - (drag.rectY + drag.rectH + dy))
                ? top - drag.rectY
                : bottom - (drag.rectY + drag.rectH);

            min[0] += dx; max[0] += dx;
            min[1] += dy; max[1] += dy;
        } else {
            if (grip.x === 'min') min[0] += snap(drag.rectX + dx, drag.guidesX, tol) - drag.rectX;
            if (grip.x === 'max') max[0] += snap(drag.rectX + drag.rectW + dx, drag.guidesX, tol) - (drag.rectX + drag.rectW);
            if (grip.y === 'min') min[1] += snap(drag.rectY + dy, drag.guidesY, tol) - drag.rectY;
            if (grip.y === 'max') max[1] += snap(drag.rectY + drag.rectH + dy, drag.guidesY, tol) - (drag.rectY + drag.rectH);
        }

        target.offsetMin = min;
        target.offsetMax = max;
    }, [target]);

    const onPointerUp = useCallback((e: React.PointerEvent) => {
        if (!dragRef.current) return;
        dragRef.current = null;
        try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already gone */ }
        // Close the history interaction explicitly. HistoryContext brackets a drag on this event rather
        // than leaving it to the idle timer, so the whole drag undoes in one step — the same signal the
        // landscape and tilemap brushes send.
        eventEmitter.emit('GIZMO_DRAG_END', { axis: null, nodeId: target?.id ?? null });
    }, [eventEmitter, target]);

    if (!target) return null;

    const rect = target.screenRect;
    const half = GRIP_SIZE / 2;

    return (
        <div data-cleo-overlay className='absolute inset-0 pointer-events-none'>
            <div
                className='absolute'
                style={{
                    left: rect.x, top: rect.y, width: rect.width, height: rect.height,
                    // Only the frame itself is hittable, so a click on empty space still reaches the
                    // UI layer underneath and clears the selection.
                    pointerEvents: 'auto',
                    cursor: 'move',
                    outline: '1px solid rgb(var(--node-ui))',
                }}
                onPointerDown={e => onPointerDown(e, null)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
            />
            {GRIPS.map(grip => {
                const gx = grip.x === 'min' ? rect.x : grip.x === 'max' ? rect.x + rect.width : rect.x + rect.width / 2;
                const gy = grip.y === 'min' ? rect.y : grip.y === 'max' ? rect.y + rect.height : rect.y + rect.height / 2;
                return (
                    <div
                        key={grip.key}
                        className='absolute rounded-[1px] border border-white bg-node-ui'
                        style={{
                            left: gx - half, top: gy - half, width: GRIP_SIZE, height: GRIP_SIZE,
                            pointerEvents: 'auto', cursor: grip.cursor,
                        }}
                        onPointerDown={e => onPointerDown(e, grip)}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                        onPointerCancel={onPointerUp}
                    />
                );
            })}
        </div>
    );
}
