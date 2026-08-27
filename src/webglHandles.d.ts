// Make WebGL's opaque handle types actually opaque. `lib.dom.d.ts` declares them as empty interfaces,
// so under structural typing EVERY object is assignable to one — including the RHI's own wrappers.
// The merged brand is never read and never assigned: these values only come from `gl.create*()`.
//
// Only the three handles the RHI wraps are branded; each brand is a compatibility risk for third-party
// typings, so do not widen this without reason.

interface WebGLBuffer {
    readonly __brand: 'WebGLBuffer';
}

interface WebGLTexture {
    readonly __brand: 'WebGLTexture';
}

interface WebGLFramebuffer {
    readonly __brand: 'WebGLFramebuffer';
}
