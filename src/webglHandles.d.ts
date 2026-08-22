// Make WebGL's opaque handle types actually opaque.
//
// `lib.dom.d.ts` declares them as completely empty interfaces — `interface WebGLBuffer {}` — which under
// structural typing means EVERY object is assignable to one. That is not a theoretical hole: while the
// RHI was being introduced, `gl.bindBuffer(gl.ARRAY_BUFFER, this._boneIndicesBuffer)` kept compiling
// after `_boneIndicesBuffer` became a `WebGL2Buffer` wrapper, and the mistake only surfaced at runtime,
// on a skinned mesh, as "parameter 2 is not of type 'WebGLBuffer'".
//
// Declaration-merging a required brand closes it. The brand is never read and never assigned: values of
// these types only ever come from `gl.create*()`, whose declared return type carries it, so real code is
// unaffected. A wrapper object that merely *looks* like a handle no longer type-checks as one.
//
// Only the three the RHI wraps are branded. Widening this to every WebGL handle would be easy and is
// deliberately not done — each brand is a small compatibility risk for third-party typings, and these
// three are where the engine actually holds a wrapper next to a raw handle.

interface WebGLBuffer {
    readonly __brand: 'WebGLBuffer';
}

interface WebGLTexture {
    readonly __brand: 'WebGLTexture';
}

interface WebGLFramebuffer {
    readonly __brand: 'WebGLFramebuffer';
}
