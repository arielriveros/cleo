// What the engine asks of a shader program: the seam that lets a second backend exist. The two
// implementations share this shape and no code.

/**
 * A reflected attribute's `vertexAttribPointer` arguments. WebGL2-shaped — `type` is a GL enum — and
 * left undefined by a WebGPU program, which carries vertex formats on the pipeline instead.
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
    /** WebGL2 only — see {@link ReflectedAttributeLayout}. Absent on a WebGPU program. */
    layout?: ReflectedAttributeLayout;
}

/**
 * Everything either backend needs to build a program; a `.wgsl` import carries all of it. The halves
 * are optional because the backends need disjoint ones, and each throws when its own is missing.
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

    /** Make this program current. A real call on WebGL2; bookkeeping on WebGPU. */
    use(): void;

    /**
     * Write a uniform BY NAME. A name this program does not declare is silently ignored — the
     * renderer sets uniforms only some programs have, and every call site relies on that.
     */
    setUniform(name: string, value: any): void;

    hasUniform(name: string): boolean;

    /** Upload whatever uniform writes are pending. Call immediately before a draw, not per `setUniform`. */
    flushUniformBlocks(): void;


    dispose(): void;
}
