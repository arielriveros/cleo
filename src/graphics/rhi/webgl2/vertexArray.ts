import { gl } from '../../glContext';
import { glVertexFormat } from './glEnums';
import type { VertexBufferLayout } from '../types';

/**
 * Bind one vertex buffer's attributes into the currently bound VAO. The caller owns binding the VAO, so
 * several layouts can be applied in turn to build one out of several buffers.
 */
export function applyVertexLayout(layout: VertexBufferLayout, buffer: WebGLBuffer): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    for (const attribute of layout.attributes) {
        const { size, type, normalized, integer } = glVertexFormat(attribute.format);
        gl.enableVertexAttribArray(attribute.shaderLocation);
        if (integer) {
            // Integer attributes MUST use vertexAttribIPointer: the float entry point converts the
            // bits rather than reinterpreting them, skinning every vertex to joint 0.
            gl.vertexAttribIPointer(attribute.shaderLocation, size, type, layout.arrayStride, attribute.offset);
        } else {
            gl.vertexAttribPointer(attribute.shaderLocation, size, type, normalized,
                                   layout.arrayStride, attribute.offset);
        }
        // A divisor is VAO state and it is sticky — see {@link clearVertexLayout}.
        if (layout.stepMode === 'instance') gl.vertexAttribDivisor(attribute.shaderLocation, 1);
    }
}

/**
 * Undo {@link applyVertexLayout} for an instanced layout. Required: a divisor outlives the draw, and
 * left set on a shared mesh VAO it corrupts the next non-instanced draw of that mesh.
 */
export function clearVertexLayout(layout: VertexBufferLayout): void {
    for (const attribute of layout.attributes) {
        if (layout.stepMode === 'instance') gl.vertexAttribDivisor(attribute.shaderLocation, 0);
        gl.disableVertexAttribArray(attribute.shaderLocation);
    }
}

/**
 * Bind one attribute from a linked program's REFLECTED layout, for attributes the declared layouts do
 * not describe. WebGL2-only: `layout.type` is a raw GL enum with no `VertexFormat` to name it.
 */
export function applyReflectedAttribute(
    location: number, layout: { size: number; type: number; stride: number; offset: number },
): void {
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, layout.size, layout.type, false, layout.stride, layout.offset);
}
