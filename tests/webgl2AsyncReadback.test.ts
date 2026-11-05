import { describe, it, expect, beforeEach } from 'vitest';
import { setGLContext } from '../src/graphics/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';

/**
 * WebGL2 `readPixels` must not stall the main thread: the copy goes into a pixel-pack buffer with a fence
 * behind it, and the bytes are taken only once the fence has signalled — polled from a timer, so the
 * frames in between keep running. Auto-exposure reads back every few frames; a synchronous
 * `gl.readPixels` into client memory drained the whole GPU queue each time.
 *
 * A stub context records the calls and lets each test decide when the fence signals.
 */
const C = {
    PIXEL_PACK_BUFFER: 0x88eb, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, STREAM_READ: 0x88e1,
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117, ALREADY_SIGNALED: 0x911a, TIMEOUT_EXPIRED: 0x911b,
    CONDITION_SATISFIED: 0x911c, WAIT_FAILED: 0x911d, FRAMEBUFFER: 0x8d40, COLOR_ATTACHMENT0: 0x8ce0,
    TEXTURE_2D: 0x0de1, NONE: 0,
};

interface Stub {
    calls: { name: string; args: unknown[] }[];
    signalled: boolean;
    lost: boolean;
    buffersCreated: number;
}

let stub: Stub;
let device: WebGL2Device;

function makeContext(): Stub {
    const s: Stub = { calls: [], signalled: false, lost: false, buffersCreated: 0 };
    const impl: Record<string, (...args: any[]) => unknown> = {
        createBuffer: () => ({ buffer: ++s.buffersCreated }),
        createFramebuffer: () => ({ framebuffer: 1 }),
        fenceSync: () => ({ sync: 1 }),
        clientWaitSync: () => (s.signalled ? C.ALREADY_SIGNALED : C.TIMEOUT_EXPIRED),
        isContextLost: () => s.lost,
        getExtension: () => null,
        getParameter: () => 4096,
        getBufferSubData: (_target: number, _offset: number, out: Uint8Array) => {
            for (let i = 0; i < out.length; i++) out[i] = (i * 7 + 3) & 255;
        },
    };
    const gl = new Proxy({}, {
        get: (_t, key: string) => {
            if (key in C) return (C as Record<string, number>)[key];
            return (...args: unknown[]) => {
                s.calls.push({ name: key, args });
                return impl[key]?.(...args);
            };
        },
    });
    setGLContext(gl as never);
    device = new WebGL2Device(gl as unknown as WebGL2RenderingContext);
    return s;
}

const view = (format = 'rgba8unorm') =>
    ({ texture: { format, dimension: '2d', handle: { texture: 1 } }, baseMipLevel: 0, baseArrayLayer: 0 }) as never;
const names = () => stub.calls.map(c => c.name);
const until = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i++) await new Promise(r => setTimeout(r, 2));
};

beforeEach(() => { stub = makeContext(); });

describe('WebGL2 readPixels', () => {
    it('reads into a pixel-pack buffer behind a fence, and waits for the fence before taking the bytes', async () => {
        let result: Uint8Array | null = null;
        const read = device.readPixels(view(), 0, 0, 2, 1).then(px => { result = px; });

        const readCall = stub.calls.find(c => c.name === 'readPixels')!;
        expect(readCall.args).toEqual([0, 0, 2, 1, C.RGBA, C.UNSIGNED_BYTE, 0]);   // offset into the bound buffer
        const order = names();
        expect(order.indexOf('fenceSync')).toBeGreaterThan(order.indexOf('readPixels'));
        expect(order.indexOf('flush')).toBeGreaterThan(order.indexOf('fenceSync'));

        // Not signalled: several polls go by and nothing is read out.
        await new Promise(r => setTimeout(r, 20));
        expect(result).toBeNull();
        expect(names()).not.toContain('getBufferSubData');
        expect(names().filter(n => n === 'clientWaitSync').length).toBeGreaterThan(1);

        stub.signalled = true;
        await read;
        expect(Array.from(result!)).toEqual([3, 10, 17, 24, 31, 38, 45, 52]);
        expect(names()).toContain('deleteSync');
    });

    it('reuses the pack buffer of a finished read, growing it only when a larger read needs it', async () => {
        stub.signalled = true;
        await device.readPixels(view(), 0, 0, 1, 1);
        await device.readPixels(view(), 0, 0, 1, 1);
        expect(stub.buffersCreated).toBe(1);
        const sized = () => stub.calls.filter(c => c.name === 'bufferData').map(c => c.args[1]);
        expect(sized()).toEqual([4]);
        await device.readPixels(view(), 0, 0, 4, 4);
        expect(stub.buffersCreated).toBe(1);
        expect(sized()).toEqual([4, 64]);
    });

    it('returns the target as it stood at the call: the copy is queued before readPixels returns', async () => {
        const pending = device.readPixels(view(), 0, 0, 1, 1);
        const order = names();
        // Attached, copied into the bound pack buffer, detached — all before the promise settles.
        const read = order.indexOf('readPixels');
        expect(order.lastIndexOf('bindBuffer', read)).toBeGreaterThan(-1);
        const detach = stub.calls.findIndex((c, i) => i > read && c.name === 'framebufferTexture2D' && c.args[3] === null);
        expect(detach).toBeGreaterThan(read);
        stub.signalled = true;
        await pending;
    });

    it('rejects a depth target or a non-8-bit target without touching the context', async () => {
        await expect(device.readPixels(view('depth24plus'), 0, 0, 1, 1)).rejects.toThrow(/depth/);
        await expect(device.readPixels(view('rgba16float'), 0, 0, 1, 1)).rejects.toThrow(/8-bit/);
        expect(names()).not.toContain('readPixels');
    });

    it('rejects when the context is lost before the fence signals', async () => {
        const read = device.readPixels(view(), 0, 0, 1, 1);
        stub.lost = true;
        await expect(read).rejects.toThrow(/lost/);
        await until(() => names().includes('deleteSync'));
        expect(names()).not.toContain('getBufferSubData');
    });
});
