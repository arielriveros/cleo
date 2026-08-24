// A `.wgsl` import is one PROGRAM, not one stage.
//
// GLSL imports are strings because a `.vs`/`.fs` file is a single stage. WGSL is different by
// necessity: naga generates varying names (`_vs2fs_location0`) from a module's location numbers, so the
// two stages only line up when they came from the same module. One module therefore holds both entry
// points, and the loader hands back the translated GLSL for each alongside the original WGSL.
//
// The WGSL is carried through unchanged so the WebGPU backend can consume the same import.
declare module '*.wgsl' {
    interface WgslProgram {
        /** The composed WGSL, includes already expanded. What the WebGPU backend will use directly. */
        readonly wgsl: string;
        /** GLSL ES 300 for the vertex stage, when the module declares an `@vertex` entry point. */
        readonly vertex?: string;
        /** GLSL ES 300 for the fragment stage, when the module declares a `@fragment` entry point. */
        readonly fragment?: string;
        /** GLSL ES 300 for the compute stage. WebGL2 has no compute; present for completeness. */
        readonly compute?: string;
        /** Entry-point function names by stage, as declared in the module. */
        readonly entryPoints: { vertex?: string; fragment?: string; compute?: string };
        /**
         * Every `@group(G) @binding(B)` the module declares.
         *
         * This is what lets a `BindGroup` be satisfied on either backend. WebGPU binds by group and
         * binding directly; WebGL2 has neither concept, so its device assigns a texture unit and sets
         * the combined sampler uniform named by `glslName` — which is why the reflection carries the
         * GLSL name rather than only the WGSL one. A texture/sampler pair shares one `glslName`
         * (`u_x_texture` + `u_x_sampler` -> `u_x`), so the WebGL2 side acts on the texture entry and
         * ignores its sampler.
         */
        readonly resources: readonly {
            readonly group: number;
            readonly binding: number;
            /** The identifier as written in WGSL. */
            readonly name: string;
            readonly kind: 'texture' | 'sampler' | 'uniform' | 'storage' | 'other';
            /** The WGSL type, e.g. `texture_2d<f32>`, `sampler_comparison`, or a struct name. */
            readonly type: string;
            /** The name the generated GLSL uses; a texture/sampler pair collapses onto one. */
            readonly glslName: string;
        }[];
        /**
         * The uniform-buffer resources, with the full byte layout of the struct each points at.
         *
         * WebGL2 ignores these and asks the driver instead; WebGPU has no reflection and needs them.
         * Verified against a real driver by `tools/harness/uniformLayoutCheck.js`.
         */
        /**
         * The vertex stage's `@location(N)` inputs, with the engine's `a_` prefix.
         *
         * WebGL2 reflects these off the linked program; WebGPU has no such call and is handed its
         * vertex layout up front, so a WebGPU program reports this list instead. Read from the same
         * declaration the translator renames, so the two cannot disagree about a name or a location.
         */
        readonly vertexInputs: readonly {
            /** With the `a_` prefix — `a_position`, not `position`. */
            readonly name: string;
            readonly location: number;
            /** The WGSL type, e.g. `vec3<f32>`. */
            readonly type: string;
        }[];

        readonly uniformBlocks: readonly {
            readonly group: number;
            readonly binding: number;
            readonly name: string;
            readonly struct: string;
            /** Bytes the block occupies — the size its uniform buffer must be allocated at. */
            readonly size: number;
            readonly members: readonly {
                readonly name: string;
                readonly type: string;
                /** Byte offset within the block. */
                readonly offset: number;
                readonly size: number;
                readonly align: number;
                /** Bytes between array elements. Absent for a non-array. */
                readonly arrayStride?: number;
                /** Bytes between matrix columns. Absent for a non-matrix. */
                readonly matrixStride?: number;
            }[];
        }[];
        /**
         * The module's GLSL, reduced to a pasteable chunk — structs, uniforms, globals and functions,
         * with `#version`, `precision`, the fragment output and `main()` stripped.
         *
         * Present only for a module carrying the `// @glsl-chunk` directive. It exists for
         * `systems/customShaders.ts`, which assembles user GLSL at runtime and needs the shadow library
         * as text; generating that half means the library is authored once, in WGSL, instead of being
         * maintained as two copies that drift.
         */
        readonly glslChunk?: string;
    }
    const value: WgslProgram;
    export default value;
}
