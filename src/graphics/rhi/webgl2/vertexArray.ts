import { gl } from '../../glContext';
import { glVertexFormat } from './glEnums';
import type { VertexBufferLayout } from '../types';

/**
 * Bind one vertex buffer's attributes into the currently bound VAO, from a declared layout.
 *
 * This is the whole of what a WebGL2 VAO is for, and it existed in four hand-rolled copies: the packed
 * path and the skinned path in `Mesh`, the instance-matrix path next to them, and an entirely separate
 * one in `TileMesh`. Each spelled out its own `enableVertexAttribArray` / `vertexAttribPointer` pair
 * with stride and offset arithmetic inline, and each had to remember on its own that bone indices need
 * the integer entry point and that instance attributes need a divisor.
 *
 * Under WebGPU there is no VAO at all — the same {@link VertexBufferLayout} is handed to the pipeline
 * at creation. So this function is precisely the WebGL2-shaped half of a description both backends
 * share, which is why it lives in `rhi/webgl2/` rather than next to the layouts themselves.
 *
 * The caller owns binding the VAO; this only touches `ARRAY_BUFFER` and the attribute state, so several
 * layouts can be applied in turn to build one VAO out of several buffers (the skinned mesh does exactly
 * that with its separate bone-index and bone-weight buffers).
 */
export function applyVertexLayout(layout: VertexBufferLayout, buffer: WebGLBuffer): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    for (const attribute of layout.attributes) {
        const { size, type, normalized, integer } = glVertexFormat(attribute.format);
        gl.enableVertexAttribArray(attribute.shaderLocation);
        if (integer) {
            // Integer attributes MUST go through vertexAttribIPointer. Routing them through the float
            // entry point converts the bits rather than reinterpreting them, which for bone indices
            // means every vertex silently skins to joint 0.
            gl.vertexAttribIPointer(attribute.shaderLocation, size, type, layout.arrayStride, attribute.offset);
        } else {
            gl.vertexAttribPointer(attribute.shaderLocation, size, type, normalized,
                                   layout.arrayStride, attribute.offset);
        }
        // A divisor of 1 advances the attribute once per instance instead of once per vertex. It is VAO
        // state and it is sticky: see clearVertexLayout for why that matters.
        if (layout.stepMode === 'instance') gl.vertexAttribDivisor(attribute.shaderLocation, 1);
    }
}

/**
 * Undo {@link applyVertexLayout} for an instanced layout: reset the divisors and disable the slots.
 *
 * Necessary because a divisor is VAO state that outlives the draw. Leaving locations 5..8 enabled with
 * divisor 1 on a mesh VAO that other nodes share corrupts the next NON-instanced draw of that same
 * mesh — it keeps reading whatever instance buffer happened to be bound.
 */
export function clearVertexLayout(layout: VertexBufferLayout): void {
    for (const attribute of layout.attributes) {
        if (layout.stepMode === 'instance') gl.vertexAttribDivisor(attribute.shaderLocation, 0);
        gl.disableVertexAttribArray(attribute.shaderLocation);
    }
}

/**
 * Bind one attribute straight from a linked program's REFLECTED layout, bypassing the declared one.
 *
 * The fallback path in `Mesh`, for an attribute the engine's own vertex layouts do not describe — a
 * custom material declaring something the standard model vertex has no name for. `layout.type` is a raw
 * GL enum read back from `getActiveAttrib`, which is exactly why this cannot go through
 * {@link applyVertexLayout}: there is no `VertexFormat` to name it with.
 *
 * It has no WebGPU counterpart and cannot get one — a pipeline there must declare every attribute's
 * format up front. An attribute reached this way is therefore WebGL2-only by construction, and saying so
 * here is better than the two hand-inlined copies that used to sit in mesh.ts saying nothing.
 */
export function applyReflectedAttribute(
    location: number, layout: { size: number; type: number; stride: number; offset: number },
): void {
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, layout.size, layout.type, false, layout.stride, layout.offset);
}
