import { forwardRef, useImperativeHandle, useRef } from 'react';
import type { ReadonlyMat4 } from 'gl-matrix';
import { uiProjectToScreen } from 'cleo';
import type { GizmoOverlayColor, GizmoOverlayModel } from './gizmoDrag';
import { AXIS_CSS_COLORS, CENTRE_CSS_COLOR } from './gizmoHandles';

/**
 * The reference lines and numeric readout drawn while a gizmo handle is being dragged.
 *
 * DOM/SVG rather than scene geometry, for two reasons: the numbers need real text at real weight, which
 * no in-world mesh gives you; and drawing here keeps the readout off the scene graph entirely, so it
 * cannot mark the project dirty or land in an undo snapshot.
 *
 * The component never re-renders during a drag. `draw()` writes attributes on a pooled set of elements,
 * the same imperative-per-frame approach `gameUi/uiSync.ts` uses, so a 60 Hz drag costs no reconciliation.
 */

export interface GizmoOverlayView {
    /** `projection * view`. */
    viewProj: ReadonlyMat4;
    width: number;
    height: number;
}

export interface GizmoOverlayHandle {
    /** Draw one frame, or clear everything when the model is null. */
    draw(model: GizmoOverlayModel | null, view: GizmoOverlayView | null): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Overlay colours come from the same palette as the 3D handles, so the two can never drift apart. */
const COLORS: Record<GizmoOverlayColor, string> = {
    x: AXIS_CSS_COLORS[0],
    y: AXIS_CSS_COLORS[1],
    z: AXIS_CSS_COLORS[2],
    neutral: CENTRE_CSS_COLOR,
    muted: 'rgb(255 255 255 / 0.35)',
};

const LABEL_CLASS =
    'absolute -translate-y-1/2 translate-x-2 whitespace-nowrap rounded border border-control ' +
    'bg-surface-raised/95 px-1.5 py-0.5 text-[10px] font-medium tabular-nums shadow-lg select-none';

const GizmoDragOverlay = forwardRef<GizmoOverlayHandle>((_props, ref) => {
    const svgRef = useRef<SVGSVGElement>(null);
    const labelsRef = useRef<HTMLDivElement>(null);
    const polylines = useRef<SVGPolylineElement[]>([]);
    const labelNodes = useRef<HTMLDivElement[]>([]);

    useImperativeHandle(ref, (): GizmoOverlayHandle => ({
        draw(model, view) {
            const svg = svgRef.current;
            const labelHost = labelsRef.current;
            if (!svg || !labelHost) return;

            let usedLines = 0;
            let usedLabels = 0;

            if (model && view) {
                const project = (p: ArrayLike<number>) =>
                    uiProjectToScreen(view.viewProj, p as never, view.width, view.height);

                for (const line of model.lines) {
                    // A polyline crossing the camera plane is split into its visible runs rather than
                    // dropped: an axis guide 40 gizmo-widths long routinely starts behind the viewer.
                    let run: string[] = [];
                    const flush = () => {
                        if (run.length >= 2) {
                            const el = polylineAt(svg, polylines.current, usedLines++);
                            el.setAttribute('points', run.join(' '));
                            el.setAttribute('stroke', COLORS[line.color]);
                            el.setAttribute('stroke-dasharray', line.dashed ? '5 4' : 'none');
                            el.style.display = '';
                        }
                        run = [];
                    };

                    for (const point of line.points) {
                        const s = project(point);
                        if (!s.inFront) { flush(); continue; }
                        run.push(`${s.x.toFixed(1)},${s.y.toFixed(1)}`);
                    }
                    flush();
                }

                for (const label of model.labels) {
                    const s = project(label.at);
                    if (!s.inFront) continue;
                    const el = labelAt(labelHost, labelNodes.current, usedLabels++);
                    el.textContent = label.text;
                    el.style.color = COLORS[label.color];
                    el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`;
                    el.style.display = '';
                }
            }

            // The pools only grow; the unused tail is hidden rather than torn down, so a long drag never
            // allocates after its first frame.
            for (let i = usedLines; i < polylines.current.length; i++) polylines.current[i].style.display = 'none';
            for (let i = usedLabels; i < labelNodes.current.length; i++) labelNodes.current[i].style.display = 'none';
        },
    }), []);

    return (
        <div data-cleo-overlay className='pointer-events-none absolute inset-0 z-20 overflow-hidden'>
            <svg ref={svgRef} className='absolute inset-0 h-full w-full' />
            <div ref={labelsRef} className='absolute left-0 top-0' />
        </div>
    );
});

function polylineAt(svg: SVGSVGElement, pool: SVGPolylineElement[], index: number): SVGPolylineElement {
    let el = pool[index];
    if (!el) {
        el = document.createElementNS(SVG_NS, 'polyline');
        el.setAttribute('fill', 'none');
        el.setAttribute('stroke-width', '1.5');
        el.setAttribute('stroke-linecap', 'round');
        el.setAttribute('vector-effect', 'non-scaling-stroke');
        svg.appendChild(el);
        pool[index] = el;
    }
    return el;
}

function labelAt(host: HTMLDivElement, pool: HTMLDivElement[], index: number): HTMLDivElement {
    let el = pool[index];
    if (!el) {
        el = document.createElement('div');
        el.className = LABEL_CLASS;
        host.appendChild(el);
        pool[index] = el;
    }
    return el;
}

GizmoDragOverlay.displayName = 'GizmoDragOverlay';
export default GizmoDragOverlay;
