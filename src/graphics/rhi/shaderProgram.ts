/**
 * What the engine actually asks of a shader program.
 *
 * `graphics/shader.ts` is 500 lines of WebGL2 — linking, reflection, `gl.uniform*` dispatch — and the
 * engine uses six things from it. Writing those six down is what lets a second backend exist: WebGPU
 * has no `useProgram` (a pipeline carries its own module) and no uniform reflection (a buffer is bytes
 * at offsets computed from the WGSL layout rules), so its implementation shares no code with this one
 * — only this shape.
 *
 * The shape is deliberately the EXISTING one rather than an improved one. ~330 call sites in
 * `renderer.ts` write uniforms by name and 59 more construct programs; a migration that also
 * redesigned the API would be two changes at once, and only one of them would be verifiable against
 * the pixel gate.
 */

/**
 * A reflected attribute's vertex-pointer arguments, as WebGL2 needs them.
 *
 * WebGL2-shaped on purpose, and named so: `type` is a GL enum. It is here because `Mesh` has a
 * fallback path for attributes outside the canonical model layout, and that path calls
 * `vertexAttribPointer` with exactly these four numbers. WebGPU carries vertex formats on the
 * pipeline instead and has no use for it, so a WebGPU program leaves it undefined rather than
 * inventing a meaning.
 */
export interface ReflectedAttributeLayout {
    size: number;
    /** A GL enum. See the note above. */
    type: number;
    normalized: boolean;
    stride: number;
    offset: number;
}

/** One vertex attribute, as a linked program reports it. */
export interface AttributeInfo {
    name: string;
    /** Human-readable type name, e.g. `vec3`. */
    type: string;
    byteSize: number;
    location: number;
    /**
     * WebGL2 only — see {@link ReflectedAttributeLayout}.
     *
     * Optional because a WebGPU program genuinely has none, and saying so in the type is what keeps
     * the one consumer (`Mesh`'s reflected-attribute fallback) from silently reading undefined.
     */
    layout?: ReflectedAttributeLayout;
}

/**
 * Everything either backend needs to build a program.
 *
 * A `.wgsl` import already carries all of it, so the usual call is
 * `device.createShaderProgram({ label: 'present', ...PresentProgram })`. The halves are optional
 * because the two backends need disjoint ones, and because one caller has only half: custom
 * materials assemble GLSL from a user's source at RUNTIME, so they have no WGSL and no build-time
 * layout. Each backend throws when its own half is missing, which is the right outcome there — a
 * user shader that cannot run on WebGPU should say so, not render something else.
 */
export interface ShaderProgramDescriptor {
    readonly label: string;
    /** GLSL ES 300 vertex stage. What WebGL2 links. */
    readonly vertex?: string;
    readonly fragment?: string;
    /** The composed WGSL. What WebGPU compiles. */
    readonly wgsl?: string;
    /** Vertex inputs, for the backend that cannot reflect them off a linked program. */
    readonly vertexInputs?: readonly { name: string; location: number; type: string }[];
    /** Uniform-block layouts, for the backend that has no uniform reflection. */
    readonly uniformBlocks?: readonly unknown[];
}

export interface ShaderProgram {
    /** Reflected vertex attributes. Read by every VAO build and every vertex layout. */
    readonly attributes: AttributeInfo[];

    /**
     * Make this program current.
     *
     * A real GPU call on WebGL2 (`useProgram` plus rebinding the block binding points, which are
     * global and therefore hold another program's blocks while it is current). Bookkeeping on WebGPU,
     * where the pipeline carries the module and there is nothing to switch.
     */
    use(): void;

    /**
     * Write a uniform BY NAME. A name this program does not declare is silently ignored — the
     * renderer sets uniforms only some programs have, and every call site relies on that.
     */
    setUniform(name: string, value: any): void;

    hasUniform(name: string): boolean;

    /**
     * Upload whatever uniform writes are pending.
     *
     * Called immediately before a draw rather than on every `setUniform`, so a pass that sets a dozen
     * members costs one upload instead of a dozen. Both backends buffer on the CPU and upload once.
     */
    flushUniformBlocks(): void;

    /** The uniform-block layout as the BACKEND sees it, for `harness:uniforms`. Empty when there is none. */
    describeBlockLayout(): unknown[];

    dispose(): void;
}
