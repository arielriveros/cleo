import { vi } from 'vitest';
import { InputSystem } from '../../src/input/inputSystem';

/**
 * Scripted input for headless play: spies on the input system's action reads, so a Player Controller and a
 * script's `Input.pressed(...)` read buttons a test presses. A press is a STARTED edge for exactly one frame
 * (call `endFrame()` after each `scene.update`), held until released -- the input system's own contract.
 */
export interface FakeInput {
    /** The `Move` vector (x right, y up). */
    setMove(x: number, y?: number): void;
    press(action: string): void;
    release(action: string): void;
    /** A press and its release a frame later: `press` now, released by the next `endFrame`. */
    tap(action: string): void;
    /** Spend this frame's edges. */
    endFrame(): void;
    restore(): void;
}

export function fakeInput(moveAction: string = 'Move'): FakeInput {
    const held = new Set<string>();
    const edges = new Set<string>();
    const tapped = new Set<string>();
    const move: [number, number] = [0, 0];
    const sys = InputSystem.instance;
    const spies = [
        vi.spyOn(sys, 'vector').mockImplementation((action: string) => action === moveAction ? [move[0], move[1]] : [0, 0]),
        vi.spyOn(sys, 'pressed').mockImplementation((action: string) => held.has(action)),
        vi.spyOn(sys, 'started').mockImplementation((action: string) => edges.has(action)),
    ];
    return {
        setMove(x, y = 0) { move[0] = x; move[1] = y; },
        press(action) { if (!held.has(action)) edges.add(action); held.add(action); },
        release(action) { held.delete(action); },
        tap(action) { this.press(action); tapped.add(action); },
        endFrame() {
            edges.clear();
            for (const action of tapped) held.delete(action);
            tapped.clear();
        },
        restore() { for (const s of spies) s.mockRestore(); },
    };
}
