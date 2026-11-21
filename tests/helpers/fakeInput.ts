import { vi } from 'vitest';
import { InputSystem } from '../../src/input/inputSystem';
import { idleState } from '../../src/input/actionMap';
import type { ActionChange } from '../../src/input/resolveActions';

/**
 * Scripted input for headless play: spies on the input system's action reads, so a Player Controller and a
 * script's `Input.pressed(...)` read buttons a test presses. A press is a STARTED edge for exactly one frame
 * (call `endFrame()` after each `scene.update`), held until released -- the input system's own contract. That
 * frame the press is also among the frame's changes, so an `@onAction` method (and a node's `onAction`) gets it.
 */
export interface FakeInput {
    /** The `Move` vector (x right, y up): every action named as a move action reads it. */
    setMove(x: number, y?: number): void;
    press(action: string): void;
    release(action: string): void;
    /** A press and its release a frame later: `press` now, released by the next `endFrame`. */
    tap(action: string): void;
    /** Spend this frame's edges. */
    endFrame(): void;
    restore(): void;
}

/** `moveActions`: the vector actions `setMove` sets (the Sandbox's car drives on its own, Drive). */
export function fakeInput(moveActions: string | string[] = 'Move'): FakeInput {
    const moves = new Set(Array.isArray(moveActions) ? moveActions : [moveActions]);
    const held = new Set<string>();
    const edges = new Set<string>();
    const tapped = new Set<string>();
    const move: [number, number] = [0, 0];
    const sys = InputSystem.instance;
    const spies = [
        vi.spyOn(sys, 'vector').mockImplementation((action: string) => moves.has(action) ? [move[0], move[1]] : [0, 0]),
        vi.spyOn(sys, 'pressed').mockImplementation((action: string) => held.has(action)),
        vi.spyOn(sys, 'started').mockImplementation((action: string) => edges.has(action)),
        vi.spyOn(sys, 'changedThisFrame', 'get').mockImplementation((): ActionChange[] => [...edges].map(action => ({
            map: '', action,
            state: { ...idleState('button'), value: 1, pressed: true, started: true, phase: 'performed', device: 'key' },
        }))),
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
