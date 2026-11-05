import { gl } from './glContext';
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
        // A divisor is VAO state and sticky: the cached VAOs are keyed by pipeline AND buffers, so an
        // instanced layout never shares a VAO with a non-instanced draw.
        if (layout.stepMode === 'instance') gl.vertexAttribDivisor(attribute.shaderLocation, 1);
    }
}
