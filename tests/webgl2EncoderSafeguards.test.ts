import { describe, it, expect, beforeEach } from 'vitest';
import { setGLContext } from '../src/graphics/rhi/webgl2/glContext';
import { GLState } from '../src/graphics/rhi/webgl2/glState';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { BufferUsage } from '../src/graphics/rhi/types';

/**
 * WebGL2 keeps global state that WebGPU does not have, and three pieces of it used to make an RHI call
 * mean something different depending on what ran before it. The backend now owns each one, so render
 * code never has to restore anything:
 *
 * - a CLEAR is masked by `colorMask`/`depthMask` (WebGPU's `loadOp: 'clear'` is not), and a bare
 *   `gl.clear` reads the standing `clearColor` — so a clear forces the masks and always names its value;
 * - an INDEX-buffer upload binds ELEMENT_ARRAY_BUFFER, which is VAO state — so it binds with no VAO, or
 *   it would rewrite the index binding of whichever cached VAO the last draw left current;
 * - a texture UPLOAD binds the texture to a unit — so every mutation unbinds it when done.
 */
const C: Record<string, number> = {
    COLOR: 0x1800, DEPTH: 0x1801, ELEMENT_ARRAY_BUFFER: 0x8893, ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8, TEXTURE0: 0x84c0, TEXTURE_3D: 0x806f, TEXTURE_2D: 0x0de1, FRAMEBUFFER: 0x8d40,
    MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d, NO_ERROR: 0, LINEAR: 0x2601, REPEAT: 0x2901, RGBA8: 0x8058,
    RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x100,
};

let calls: { name: string; args: unknown[] }[];
let device: WebGL2Device;

beforeEach(() => {
    calls = [];
    let n = 0;
    const gl = new Proxy({}, {
        get: (_t, key: string) => {
            if (key in C) return C[key];
            return (...args: unknown[]) => {
                calls.push({ name: key, args });
                if (key.startsWith('create')) return { id: ++n };
                if (key === 'getParameter') return 16;
                if (key === 'getError') return 0;
                if (key === 'getExtension') return null;
                return undefined;
            };
        },
    });
    setGLContext(gl as never);
    GLState.reset();
    device = new WebGL2Device(gl as unknown as WebGL2RenderingContext);
    calls = [];
});

const fakeTarget = () => ({ bind() {}, framebuffer: null, depthTexture: null, colorCount: 1 }) as never;
const named = (name: string) => calls.filter(c => c.name === name);

describe('WebGL2 clears', () => {
    it('force the colour mask a colour-less pipeline left off, then clear to the named value', () => {
        GLState.colorMask(false, false, false, false);   // what a depth-prepass pipeline leaves behind
        calls = [];
        device.beginRenderPass(fakeTarget(), {
            colorAttachments: [{ target: 0, loadOp: 'clear', storeOp: 'store', clearValue: [0.1, 0.2, 0.3, 1] }],
        });
        const mask = calls.findIndex(c => c.name === 'colorMask');
        const clear = calls.findIndex(c => c.name === 'clearBufferfv');
        expect(calls[mask].args).toEqual([true, true, true, true]);
        expect(mask).toBeLessThan(clear);
        expect(Array.from(calls[clear].args[2] as number[])).toEqual([0.1, 0.2, 0.3, 1]);
    });

    it('never read the standing clear colour: no value means (0, 0, 0, 1), and depth 1', () => {
        device.beginRenderPass(fakeTarget(), {
            colorAttachments: [{ target: 0, loadOp: 'clear', storeOp: 'store' }],
            depthAttachment: { loadOp: 'clear', storeOp: 'store' },
        });
        expect(named('clear')).toEqual([]);
        const [colour, depth] = named('clearBufferfv');
        expect(colour.args[0]).toBe(C.COLOR);
        expect(Array.from(colour.args[2] as number[])).toEqual([0, 0, 0, 1]);
        expect(depth.args[0]).toBe(C.DEPTH);
        expect(Array.from(depth.args[2] as number[])).toEqual([1]);
    });

    it('leave the masks alone for a pass that only loads', () => {
        GLState.colorMask(false, false, false, false);
        calls = [];
        device.beginRenderPass(fakeTarget(), {
            colorAttachments: [{ target: 0, loadOp: 'load', storeOp: 'store' }],
        });
        expect(named('colorMask')).toEqual([]);
        expect(named('clearBufferfv')).toEqual([]);
    });
});

describe('WebGL2 index-buffer uploads', () => {
    it('unbind the current VAO first, so its index binding survives', () => {
        const indices = device.createBuffer({ label: 'i', size: 0, usage: BufferUsage.INDEX | BufferUsage.COPY_DST });
        GLState.bindVAO({ vao: 1 } as never);   // the VAO the last recorded draw left bound
        calls = [];
        device.reallocateBuffer(indices, new Uint16Array([0, 1, 2]));
        const unbind = calls.findIndex(c => c.name === 'bindVertexArray' && c.args[0] === null);
        const bind = calls.findIndex(c => c.name === 'bindBuffer' && c.args[0] === C.ELEMENT_ARRAY_BUFFER);
        expect(unbind).toBeGreaterThanOrEqual(0);
        expect(unbind).toBeLessThan(bind);
    });

    it('leave the VAO alone for a vertex buffer', () => {
        const vertices = device.createBuffer({ label: 'v', size: 0, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
        GLState.bindVAO({ vao: 1 } as never);
        calls = [];
        device.reallocateBuffer(vertices, new Float32Array([0, 1, 2]));
        expect(named('bindVertexArray')).toEqual([]);
    });
});

describe('WebGL2 texture uploads', () => {
    it('bind on the last unit and release it when done', () => {
        const texture = device.createTexture({ label: 't', format: 'rgba8unorm', dimension: '3d', width: 4, height: 4,
                                               depthOrArrayLayers: 4, usage: 0x04 | 0x10 });
        calls = [];
        texture.allocateVolume(4, 4, 4, 'repeat');
        const binds = named('bindTexture');
        expect(binds.length).toBeGreaterThanOrEqual(2);
        expect(binds[binds.length - 1].args[1]).toBeNull();
        const unit = named('activeTexture')[0].args[0] as number;
        expect(unit - C.TEXTURE0).toBe(15);   // MAX_COMBINED_TEXTURE_IMAGE_UNITS (16) - 1, never unit 0
    });
});
