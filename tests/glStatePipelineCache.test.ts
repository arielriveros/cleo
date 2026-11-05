import { describe, it, expect, beforeEach } from 'vitest';
import { setGLContext } from '../src/graphics/glContext';
import { GLState } from '../src/graphics/systems/glState';

/**
 * WebGL2RenderPipeline.apply used to issue depthFunc, frontFace, blendFuncSeparate, blendEquationSeparate
 * and colorMask raw on every apply — once per draw in a sorted geometry run that never changes them.
 * GLState now caches them like the rest of the pipeline state. What must hold: a repeat is skipped, any
 * difference goes through, and reset() forgets everything (GL was touched behind the cache's back).
 */
function mockGl() {
    const calls: string[] = [];
    const gl = new Proxy({}, {
        get: (_t, key: string) => (...args: unknown[]) => { calls.push(`${key}(${args.join(',')})`); },
    });
    setGLContext(gl as never);
    return calls;
}

describe('GLState pipeline-state cache', () => {
    let calls: string[];
    beforeEach(() => { calls = mockGl(); GLState.reset(); });

    it('skips a repeated depth func, front face, blend func, blend equation and colour mask', () => {
        for (let i = 0; i < 3; i++) {
            GLState.depthFunc(0x0203);
            GLState.frontFace(0x0901);
            GLState.blendFuncSeparate(1, 2, 3, 4);
            GLState.blendEquationSeparate(5, 6);
            GLState.colorMask(true, true, true, false);
        }
        expect(calls).toEqual([
            'depthFunc(515)', 'frontFace(2305)', 'blendFuncSeparate(1,2,3,4)', 'blendEquationSeparate(5,6)',
            'colorMask(true,true,true,false)',
        ]);
    });

    it('issues any difference, component by component', () => {
        GLState.blendFuncSeparate(1, 2, 3, 4);
        GLState.blendFuncSeparate(1, 2, 3, 5);
        GLState.blendEquationSeparate(5, 6);
        GLState.blendEquationSeparate(6, 6);
        GLState.colorMask(true, true, true, true);
        GLState.colorMask(true, true, true, false);
        GLState.depthFunc(0x0203);
        GLState.depthFunc(0x0207);
        expect(calls.length).toBe(8);
    });

    it('forgets everything on reset', () => {
        GLState.depthFunc(0x0203);
        GLState.colorMask(false, false, false, false);
        GLState.reset();
        GLState.depthFunc(0x0203);
        GLState.colorMask(false, false, false, false);
        expect(calls).toEqual(['depthFunc(515)', 'colorMask(false,false,false,false)',
                               'depthFunc(515)', 'colorMask(false,false,false,false)']);
    });
});
