import { shaderOptimizerStats } from './stats';

/**
 * Keeps material parameters from being re-sent to the GPU when they are already there.
 *
 * ## What it replaces
 *
 * Every draw wrote every property of its material into its program's material block by name —
 * `setUniform(\`u_material.${name}\`)` per property, a fresh string each — plus the per-view values that
 * ride in the same block (camera position, sun direction, view-projection, specular AA), and the dirty
 * block then uploaded whole. Two consecutive draws of the same material on the same program (a model's
 * submeshes, the chunks of a terrain, a row of identical props) paid all of it for bytes that had not
 * changed.
 *
 * ## The rule
 *
 * A program's material block still holds what was last written into it. So the write is skipped when the
 * program's last write was the SAME material, in the SAME frame, with the SAME view values. Nothing is
 * dirtied, so WebGL2 uploads nothing and WebGPU keeps its uniform slot and bind group.
 *
 * - **Same frame**, not a material version: properties are a plain Map and the editor mutates colour
 *   arrays in place, so a version counter would miss edits. Edits only ever happen between frames (input
 *   handlers), so within one frame a material is immutable — which is all this needs.
 * - **Same view values**, compared element by element rather than tracked by an epoch: a probe capture
 *   turns ONE camera object through six faces, and an epoch bumped at every place a view can change is a
 *   bug waiting for the next place. 23 compares is cheaper than the writes it saves.
 *
 * Anything that writes `u_material.*` by hand must call {@link invalidate} for the program it wrote, or
 * the next draw of the remembered material would skip over the foreign values.
 */
export const MATERIAL_VIEW_SIZE = 23;

interface Last { material: object; frame: number; view: Float64Array }

export class MaterialSync {
    private _frame = 0;
    private _last = new WeakMap<object, Last>();
    /** Uniform names by property name: built once each instead of a template string per write. */
    private _names = new Map<string, string>();

    /** Start a frame: nothing written in an earlier frame may be trusted (see the class comment). */
    public beginFrame(): void {
        this._frame++;
    }

    /**
     * Whether `material` must be written into `program`'s material block now, given the per-view values
     * that ride along with it (`view`, {@link MATERIAL_VIEW_SIZE} numbers). Records the write when it
     * must, so the next identical draw this frame skips it.
     */
    public needsWrite(program: object | null, material: object, view: ArrayLike<number>): boolean {
        if (!program) return true;
        const last = this._last.get(program);
        if (last && last.material === material && last.frame === this._frame && sameView(last.view, view)) {
            shaderOptimizerStats.materialSkips++;
            return false;
        }
        if (last) {
            last.material = material;
            last.frame = this._frame;
            for (let i = 0; i < MATERIAL_VIEW_SIZE; i++) last.view[i] = view[i];
        } else {
            const copy = new Float64Array(MATERIAL_VIEW_SIZE);
            for (let i = 0; i < MATERIAL_VIEW_SIZE; i++) copy[i] = view[i];
            this._last.set(program, { material, frame: this._frame, view: copy });
        }
        shaderOptimizerStats.materialWrites++;
        return true;
    }

    /** Forget what `program`'s block holds: something other than a material wrote into it. */
    public invalidate(program: object | null): void {
        if (program) this._last.delete(program);
    }

    /** `u_material.<name>`, interned. */
    public uniformName(property: string): string {
        let name = this._names.get(property);
        if (name === undefined) {
            name = `u_material.${property}`;
            this._names.set(property, name);
        }
        return name;
    }
}

function sameView(a: Float64Array, b: ArrayLike<number>): boolean {
    for (let i = 0; i < MATERIAL_VIEW_SIZE; i++) if (a[i] !== b[i]) return false;
    return true;
}
