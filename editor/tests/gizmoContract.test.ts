import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { handleSpecs, HANDLE_NAME_PREFIX } from '../src/features/gizmo/gizmoHandles';
import type { GizmoMode } from '../src/features/engineContextTypes';

/**
 * Structural contracts the gizmo depends on that no type can express.
 *
 * Each one below failed, or would fail, silently: a renamed handle quietly marks every project unsaved,
 * a parented handle quietly inherits the selection's scale, and an unwrapped scene mutation quietly fills
 * the undo stack with gizmo movement. None of them produce an error anywhere.
 */

const CONTROLLER = readFileSync(join(__dirname, '../src/features/gizmo/TransformGizmo.tsx'), 'utf8');
const MODES: GizmoMode[] = ['position', 'rotation', 'scale'];

describe('handle naming', () => {
    it('keeps `__editor__` in every name, which is what stops the scene going dirty', () => {
        // EngineProvider's dirty guard (`EngineContext.tsx`, the `mark()` helper) drops any SCENE_CHANGED
        // whose node name contains `__editor__`. The handles are re-placed every animation frame and each
        // placement emits one, so without the substring, selecting a node and orbiting would mark the
        // project unsaved for the rest of the session.
        for (const mode of MODES)
            for (const spec of handleSpecs(mode))
                expect(spec.name, `${mode}/${spec.id}`).toContain('__editor__');
    });

    it('keeps `gizmo` in every name, which is what keeps raycast membership unchanged', () => {
        // `Raycaster.raycast` skips `__editor__*` nodes UNLESS the name contains `gizmo`. The gizmo now
        // picks its handles analytically and no longer needs to be raycastable, but dropping the
        // substring would change which nodes that loop walks — a separate change, not this one.
        for (const mode of MODES)
            for (const spec of handleSpecs(mode))
                expect(spec.name, `${mode}/${spec.id}`).toContain('gizmo');
        expect(HANDLE_NAME_PREFIX).toContain('__editor__');
        expect(HANDLE_NAME_PREFIX).toContain('gizmo');
    });

    it('gives every mode at least three handles with distinct node names', () => {
        for (const mode of MODES) {
            const specs = handleSpecs(mode);
            expect(specs.length, mode).toBeGreaterThanOrEqual(3);
            expect(new Set(specs.map(s => s.name)).size, `${mode} names`).toBe(specs.length);
        }
    });

    it('gives rotation three rings and the other modes axes, planes and a centre', () => {
        expect(handleSpecs('rotation').map(s => s.shape)).toEqual(['ring', 'ring', 'ring']);
        for (const mode of ['position', 'scale'] as const) {
            const shapes = handleSpecs(mode).map(s => s.shape);
            expect(shapes.filter(s => s === 'quad')).toHaveLength(3);
            expect(shapes.filter(s => s === 'sphere')).toHaveLength(1);
            expect(shapes.filter(s => s === 'arrow' || s === 'arm')).toHaveLength(3);
        }
    });
});

describe('the controller', () => {
    it('adds handles to the scene root and never parents them to the selection', () => {
        // Parenting the gizmo to the selected node inherits its rotation and scale, so the handles on a
        // node scaled 0.01 are invisible and the ones on a node scaled 100 fill the screen. The handles
        // copy the selection's world position instead.
        expect(CONTROLLER).toContain('editorScene.addNodes(');
        expect(CONTROLLER).not.toContain('.addChild(');
    });

    it('wraps every scene mutation in withoutDirty', () => {
        // The handles live in the user's scene, so adding, removing, showing or moving one is
        // indistinguishable from an edit unless dirty-marking is suppressed around it.
        for (const token of ['editorScene.addNodes(', 'editorScene.removeNode(', 'placeHandles(']) {
            for (const at of occurrences(CONTROLLER, token))
                expect(insideWithoutDirty(CONTROLLER, at), `${token} at index ${at}`).toBe(true);
        }
    });

    it('ends the drag on every exit path, including unmount', () => {
        // GIZMO_DRAG_START disables the EditorCamera input map and takes the pointer lock; a missed END
        // leaves the editor camera dead for the rest of the session. This used to happen on a tab switch.
        for (const listener of ['mouseup', 'pointerlockchange', 'keydown', 'blur'])
            expect(CONTROLLER, listener).toContain(`'${listener}'`);
        // The effect cleanup calls it too, which is the unmount path.
        expect(CONTROLLER).toMatch(/viewport\.style\.cursor = '';\s*\n[\s\S]{0,200}?endDrag\(\);/);
    });
});

/** Every index at which `token` starts in `source`. */
function occurrences(source: string, token: string): number[] {
    const out: number[] = [];
    for (let at = source.indexOf(token); at !== -1; at = source.indexOf(token, at + 1)) out.push(at);
    expect(out.length, `${token} should appear at least once`).toBeGreaterThan(0);
    return out;
}

/**
 * True when `index` falls inside the argument list of some `withoutDirty(` call. Brace-matched rather
 * than line-matched, so a multi-line callback counts.
 */
function insideWithoutDirty(source: string, index: number): boolean {
    for (let at = source.indexOf('withoutDirty('); at !== -1; at = source.indexOf('withoutDirty(', at + 1)) {
        const open = source.indexOf('(', at);
        let depth = 0;
        for (let i = open; i < source.length; i++) {
            if (source[i] === '(') depth++;
            else if (source[i] === ')') {
                depth--;
                if (depth === 0) {
                    if (index > open && index < i) return true;
                    break;
                }
            }
        }
    }
    return false;
}
