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
    }
    const value: WgslProgram;
    export default value;
}
