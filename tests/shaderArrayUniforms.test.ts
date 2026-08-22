import { describe, it, expect, beforeEach } from 'vitest';
import { setGLContext } from '../src/graphics/glContext';
import { Shader } from '../src/graphics/shader';

/**
 * Array uniforms, reachable by their bare name.
 *
 * GL names an array uniform `u_cascadeMatrices[0]`, and that is the only name `getUniformLocation`
 * accepts. `storeUniforms` therefore filed it under that name, and `setUniform('u_cascadeMatrices', …)`
 * found nothing and silently did nothing — so the renderer cached raw locations for its arrays instead.
 *
 * That workaround is what made the WGSL migration dangerous: `getUniformLocation` returns null for a
 * member of a std140 block, which is the *same* value an unused uniform returns, so the `if (loc)`
 * guards could not tell "this shader has no bones" from "the bones moved into a block". SSAO shipped a
 * frame of uniformly-unoccluded output that way, and seven more sites had the same shape.
 *
 * Both halves of the fix fail silently if they regress, which is why they are pinned here: an alias that
 * stops being registered makes every array set a no-op, and a `uniform1f` used where `uniform1fv` is
 * needed writes only the first element and leaves the rest stale.
 */

const GL = {
    COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
    ACTIVE_UNIFORMS: 0x8b86, ACTIVE_ATTRIBUTES: 0x8b89, ACTIVE_UNIFORM_BLOCKS: 0x8a36,
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
    FLOAT: 0x1406, FLOAT_VEC2: 0x8b50, FLOAT_MAT4: 0x8b5c, INT: 0x1404,
};

/** What the fake program reports from `getActiveUniform`. */
const UNIFORMS = [
    { name: 'u_cascadeMatrices[0]', type: GL.FLOAT_MAT4, size: 4 },
    { name: 'u_cascadeSplits[0]', type: GL.FLOAT, size: 4 },
    { name: 'u_spotShadowLayer[0]', type: GL.INT, size: 8 },
    { name: 'u_exposure', type: GL.FLOAT, size: 1 },
    { name: 'u_shadowTexel', type: GL.FLOAT_VEC2, size: 1 },
];

let calls: { fn: string; location: string; value: unknown }[] = [];

function install() {
    calls = [];
    const locations = new Map<string, string>();

    const api: Record<string, unknown> = {
        ...GL,
        createShader: () => ({}),
        createProgram: () => ({}),
        shaderSource: () => undefined,
        compileShader: () => undefined,
        attachShader: () => undefined,
        linkProgram: () => undefined,
        getShaderParameter: () => true,
        getProgramParameter: (_p: unknown, name: number) => {
            if (name === GL.LINK_STATUS) return true;
            if (name === GL.ACTIVE_UNIFORMS) return UNIFORMS.length;
            return 0;   // no attributes, no uniform blocks
        },
        getActiveUniform: (_p: unknown, i: number) => UNIFORMS[i],
        // Only the exact reported name resolves — the whole point of the alias is that the engine can
        // ask for a name GL itself would reject.
        getUniformLocation: (_p: unknown, name: string) => {
            if (!UNIFORMS.some(u => u.name === name)) return null;
            if (!locations.has(name)) locations.set(name, name);
            return locations.get(name);
        },
        useProgram: () => undefined,
    };

    const record = (fn: string) => (location: string, a: unknown, b?: unknown) =>
        calls.push({ fn, location, value: fn.startsWith('uniformMatrix') ? b : a });
    for (const fn of ['uniform1f', 'uniform1fv', 'uniform1i', 'uniform1iv', 'uniform2fv',
                      'uniformMatrix4fv']) api[fn] = record(fn);

    const gl = new Proxy(api, { get: (t, key: string) => (key in t ? t[key] : () => undefined) });
    setGLContext(gl as unknown as WebGL2RenderingContext);
    return new Shader().create('/* vs */', '/* fs */');
}

let shader: Shader;
beforeEach(() => { shader = install(); });

const lastCall = () => calls[calls.length - 1];

describe('Shader — array uniforms by bare name', () => {
    it('registers both the reported name and the stripped one', () => {
        expect(shader.hasUniform('u_cascadeMatrices[0]')).toBe(true);
        expect(shader.hasUniform('u_cascadeMatrices')).toBe(true);
        expect(shader.hasUniform('u_cascadeSplits')).toBe(true);
        expect(shader.hasUniform('u_spotShadowLayer')).toBe(true);
    });

    it('leaves a non-array uniform with exactly one name', () => {
        expect(shader.hasUniform('u_exposure')).toBe(true);
        expect(shader.hasUniform('u_exposure[0]')).toBe(false);
    });

    it('sends a bare-name set to the same location as the [0] name', () => {
        const data = new Float32Array(64);
        shader.setUniform('u_cascadeMatrices', data);
        const bare = lastCall();
        shader.setUniform('u_cascadeMatrices[0]', data);
        expect(lastCall().location).toBe(bare.location);
        expect(bare.location).toBe('u_cascadeMatrices[0]');
    });

    it('uses the vector call for a float ARRAY, not the scalar one', () => {
        // uniform1f would write only the first split and leave cascades 1..3 stale — which reads as
        // shadows that are correct in the nearest cascade and wrong everywhere beyond it.
        shader.setUniform('u_cascadeSplits', new Float32Array([1, 2, 3, 4]));
        expect(lastCall().fn).toBe('uniform1fv');
    });

    it('uses the vector call for an int ARRAY', () => {
        shader.setUniform('u_spotShadowLayer', new Int32Array(8));
        expect(lastCall().fn).toBe('uniform1iv');
    });

    it('still uses the scalar call for a scalar', () => {
        shader.setUniform('u_exposure', 2);
        expect(lastCall().fn).toBe('uniform1f');
        expect(lastCall().value).toBe(2);
    });

    it('passes a matrix array straight through, since uniformMatrix4fv already takes any length', () => {
        const data = new Float32Array(64);
        shader.setUniform('u_cascadeMatrices', data);
        expect(lastCall().fn).toBe('uniformMatrix4fv');
        expect(lastCall().value).toBe(data);
    });

    it('does nothing, and does not throw, for a name the program does not have', () => {
        const before = calls.length;
        expect(() => shader.setUniform('u_notAThing', 1)).not.toThrow();
        expect(calls.length).toBe(before);
    });
});
