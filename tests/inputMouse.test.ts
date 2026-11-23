import { describe, it, expect } from "vitest";
import { DeviceSampler } from "../src/input/deviceSampler";

/** A canvas stand-in: the sampler only needs listeners, a rect and a style. */
function fakeCanvas() {
    const handlers = new Map<string, (e: any) => void>();
    return {
        style: { cursor: '' },
        addEventListener: (type: string, fn: (e: any) => void) => { handlers.set(type, fn); },
        getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100 }),
        fire: (type: string, e: any) => handlers.get(type)?.(e),
    };
}

function setup() {
    const win = new Map<string, (e: any) => void>();
    (globalThis as any).window = { addEventListener: (t: string, f: any) => win.set(t, f) };
    (globalThis as any).document = { addEventListener: () => {}, activeElement: null };
    const canvas = fakeCanvas();
    const sampler = new DeviceSampler();
    sampler.initialize(canvas as unknown as HTMLElement);
    return { canvas, sampler, up: (button: number) => win.get('mouseup')?.({ button }) };
}

describe('mouse edges and position', () => {
    it('reports pressed on the frame a button goes down only', () => {
        const { canvas, sampler } = setup();
        canvas.fire('mousedown', { button: 0, clientX: 60, clientY: 70 });
        expect(sampler.sample(0.016).mousePressed.has('left')).toBe(true);
        sampler.endFrame();
        const next = sampler.sample(0.016);
        expect(next.mousePressed.has('left')).toBe(false);
        expect(next.mouseButtons.has('left')).toBe(true);
    });

    it('reports a press and release inside one frame as both', () => {
        const { canvas, sampler, up } = setup();
        canvas.fire('mousedown', { button: 0, clientX: 0, clientY: 0 });
        up(0);
        const snap = sampler.sample(0.016);
        expect(snap.mousePressed.has('left')).toBe(true);
        expect(snap.mouseReleased.has('left')).toBe(true);
        expect(snap.mouseButtons.has('left')).toBe(false);
    });

    it('does not repeat pressed for a button already held', () => {
        const { canvas, sampler } = setup();
        canvas.fire('mousedown', { button: 2, clientX: 0, clientY: 0 });
        sampler.sample(0.016); sampler.endFrame();
        canvas.fire('mousedown', { button: 2, clientX: 0, clientY: 0 });
        expect(sampler.sample(0.016).mousePressed.has('right')).toBe(false);
    });

    it('accumulates held seconds and drops them on release', () => {
        const { canvas, sampler, up } = setup();
        canvas.fire('mousedown', { button: 0, clientX: 0, clientY: 0 });
        sampler.sample(0.5); sampler.endFrame();
        sampler.sample(0.25);
        expect(sampler.heldSeconds('left')).toBeCloseTo(0.75);
        up(0);
        sampler.sample(0.1);
        expect(sampler.heldSeconds('left')).toBe(0);
    });

    it('gives the position in canvas pixels and normalized', () => {
        const { canvas, sampler } = setup();
        canvas.fire('mousemove', { clientX: 110, clientY: 70, movementX: 3, movementY: -2 });
        const p = sampler.sample(0.016).pointer;
        expect(p.px).toBe(100);
        expect(p.py).toBe(50);
        expect(p.x).toBeCloseTo(0.5);
        expect(p.y).toBeCloseTo(0.5);
    });

    it('sets and clears the cursor style on the canvas', () => {
        const { canvas, sampler } = setup();
        sampler.setCursor('crosshair');
        expect(canvas.style.cursor).toBe('crosshair');
        sampler.dispose();
        expect(canvas.style.cursor).toBe('');
    });
});
