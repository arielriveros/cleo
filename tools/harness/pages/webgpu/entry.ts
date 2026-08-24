// Device-tier checks for the WebGPU backend, run against a real driver.
//
// Everything here goes through the RHI — `acquireWebGPUDevice` and the `Device` interface — rather than
// touching `navigator.gpu` directly, because the thing under test is the abstraction, not the API. If a
// check can only be written by reaching past the interface, the interface is wrong and that is worth
// finding out now rather than at M6 with the renderer already ported on top of it.
//
// Two of the shaders are the engine's OWN `.wgsl` modules, imported through the same webpack loader the
// engine ships. That is the part a hand-written test triangle cannot do: it proves the composed,
// include-expanded source the renderer will hand to WebGPU actually compiles and draws.

import { acquireWebGPUDevice, type WebGPUDevice } from '../../../../src/graphics/rhi/webgpu/webgpuDevice';
import { BufferUsage, TextureUsage, ShaderStage, type VertexBufferLayout } from '../../../../src/graphics/rhi/types';
import { UniformSet, ProgramUniforms } from '../../../../src/graphics/rhi/uniformSet';
import { WebGPUShaderProgram } from '../../../../src/graphics/rhi/webgpu/webgpuShaderProgram';
import { ShaderManager } from '../../../../src/graphics/systems/shaderManager';
import type { Texture, TextureView, ShaderModule, BindGroup, RenderPipeline } from '../../../../src/graphics/rhi/resources';
import type { RenderPassEncoder, BindGroupEntry } from '../../../../src/graphics/rhi/device';
import ScreenProgram from '../../../../src/graphics/shaders/wgsl/screen.wgsl';
import PresentProgram from '../../../../src/graphics/shaders/wgsl/present.wgsl';
import OutlineProgram from '../../../../src/graphics/shaders/wgsl/outline.wgsl';
import CloudNoiseBakeProgram from '../../../../src/graphics/shaders/wgsl/cloudNoiseBake.wgsl';
import CloudNoiseBakeComputeProgram from '../../../../src/graphics/shaders/wgsl/cloudNoiseBakeCompute.wgsl';

interface CheckResult { name: string; pass: boolean; detail: string; }

const SIZE = 64;
/** The swap-chain canvas starts here and is resized to prove the surface follows. */
const SURFACE_W = 80, SURFACE_H = 48;

/**
 * A screen-filling quad in clip space, with UVs oriented for WebGPU.
 *
 * WebGPU's framebuffer origin is top-left and clip-space +Y is the top of the screen, so the vertex at
 * NDC (-1, +1) is the top-left pixel and must carry uv (0, 0) for a pass-through shader to reproduce
 * its input exactly. Getting this backwards still renders — it renders the image flipped, which an
 * eyeball check on a symmetric test pattern would happily accept. Hence an asymmetric pattern below.
 */
/** The three attributes `outline` declares, packed: position, normal, uv — 32 bytes. */
const OUTLINE_VERTEX_LAYOUT: VertexBufferLayout = {
    arrayStride: 32, stepMode: 'vertex',
    attributes: [
        { name: 'a_position', shaderLocation: 0, offset: 0,  format: 'float32x3' },
        { name: 'a_normal',   shaderLocation: 1, offset: 12, format: 'float32x3' },
        { name: 'a_texCoord', shaderLocation: 2, offset: 24, format: 'float32x2' },
    ],
};

const QUAD = new Float32Array([
    -1, +1, 0,   0, 0,
    -1, -1, 0,   0, 1,
    +1, +1, 0,   1, 0,
    +1, -1, 0,   1, 1,
]);

const QUAD_LAYOUT: VertexBufferLayout = {
    arrayStride: 20,
    stepMode: 'vertex',
    attributes: [
        { name: 'position', shaderLocation: 0, offset: 0, format: 'float32x3' },
        { name: 'texCoord', shaderLocation: 1, offset: 12, format: 'float32x2' },
    ],
};

/**
 * A deterministic, asymmetric RGBA8 pattern.
 *
 * Asymmetric in both axes so a flip or a transpose fails the comparison rather than passing it, and
 * derived from the coordinates so the expected bytes need no second copy to compare against.
 */
function testPattern(size: number): Uint8Array {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            data[i + 0] = (x * 4) & 0xff;
            data[i + 1] = (y * 3) & 0xff;
            data[i + 2] = (x + y * 2) & 0xff;
            data[i + 3] = 255;
        }
    }
    return data;
}

/** The CPU twin of `chunks/tonemap.wgsl`, for checking the shader against something independent. */
function cpuTonemap(channel: number, exposure: number): number {
    const x = channel * exposure;
    const a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    const mapped = Math.min(1, Math.max(0, (x * (a * x + b)) / (x * (c * x + d) + e)));
    return Math.pow(mapped, 1 / 2.2);
}

/**
 * The CPU twin of `chunks/cloudNoiseField.wgsl`, in single precision.
 *
 * Every arithmetic step goes through `Math.fround`, and that is not fussiness. `hashCell` ends in
 * `fract((c.x + c.y) * c.z)` over a value of order 18000, where an f32 ULP is about 0.002 — so a twin
 * computed in JS's native f64 lands on the other side of an integer boundary now and then and the
 * fract result differs by nearly 1.0 for that cell. Emulating f32 keeps the two on the same side of
 * those boundaries, which is what makes a tight per-texel tolerance meaningful rather than lucky.
 */
const f = Math.fround;
const fract = (x: number) => f(x - Math.floor(x));

function hashCell(cx: number, cy: number, cz: number): number {
    let x = fract(f(cx * 0.1031)), y = fract(f(cy * 0.1031)), z = fract(f(cz * 0.1031));
    // dot(c, c.zyx + 31.32)
    const d = f(f(f(x * f(z + 31.32)) + f(y * f(y + 31.32))) + f(z * f(x + 31.32)));
    x = f(x + d); y = f(y + d); z = f(z + d);
    return fract(f(f(x + y) * z));
}

/** WGSL `%` on floats is the remainder, which for the non-negative values here is a plain fmod. */
const rem = (x: number, y: number) => f(x - f(y * Math.trunc(f(x / y))));

function valueNoiseTiled(px: number, py: number, pz: number, period: number): number {
    const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
    let fx = fract(px), fy = fract(py), fz = fract(pz);
    const smooth = (t: number) => f(f(t * t) * f(3 - f(2 * t)));
    fx = smooth(fx); fy = smooth(fy); fz = smooth(fz);

    const i0 = [rem(ix, period), rem(iy, period), rem(iz, period)];
    const i1 = [rem(ix + 1, period), rem(iy + 1, period), rem(iz + 1, period)];

    const n000 = hashCell(i0[0], i0[1], i0[2]);
    const n100 = hashCell(i1[0], i0[1], i0[2]);
    const n010 = hashCell(i0[0], i1[1], i0[2]);
    const n110 = hashCell(i1[0], i1[1], i0[2]);
    const n001 = hashCell(i0[0], i0[1], i1[2]);
    const n101 = hashCell(i1[0], i0[1], i1[2]);
    const n011 = hashCell(i0[0], i1[1], i1[2]);
    const n111 = hashCell(i1[0], i1[1], i1[2]);

    // WGSL `mix(a, b, t)` is `a + t * (b - a)`, and the spelling matters at this precision.
    const mix = (a: number, b: number, t: number) => f(a + f(t * f(b - a)));
    const nx00 = mix(n000, n100, fx), nx10 = mix(n010, n110, fx);
    const nx01 = mix(n001, n101, fx), nx11 = mix(n011, n111, fx);
    return mix(mix(nx00, nx10, fy), mix(nx01, nx11, fy), fz);
}

function fbmTiled(px: number, py: number, pz: number, period: number, octaves: number): number {
    let sum = 0, amp = 0.5, norm = 0, per = period;
    for (let i = 0; i < 6; i++) {
        if (i >= octaves) break;
        const scale = f(per / period);
        sum = f(sum + f(amp * valueNoiseTiled(f(px * scale), f(py * scale), f(pz * scale), per)));
        norm = f(norm + amp);
        per = f(per * 2);
        amp = f(amp * 0.5);
    }
    return f(sum / Math.max(norm, 1e-5));
}

/** The twin of `cloudNoiseTexel`, hardcoded 3/3/2 detail branch and all. */
function cloudNoiseTexel(px: number, py: number, pz: number,
                                period: number, octaves: number, detail: number): number[] {
    if (detail !== 0) {
        return [
            fbmTiled(px, py, pz, period, 3),
            fbmTiled(f(px * 2), f(py * 2), f(pz * 2), f(period * 2), 3),
            fbmTiled(f(px * 4), f(py * 4), f(pz * 4), f(period * 4), 2),
            1.0,
        ];
    }
    return [
        fbmTiled(px, py, pz, period, octaves),
        fbmTiled(f(px * 2), f(py * 2), f(pz * 2), f(period * 2), 3),
        fbmTiled(f(px * 4), f(py * 4), f(pz * 4), f(period * 4), 3),
        valueNoiseTiled(f(px * 2), f(py * 2), f(pz * 2), f(period * 2)),
    ];
}

function makeModule(device: WebGPUDevice, program: { wgsl: string; entryPoints: any }, label: string): ShaderModule {
    return device.createShaderModule({
        label,
        stage: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
        source: program.wgsl,
        entryPoints: program.entryPoints,
    });
}

/** Upload an RGBA8 texture that can be sampled and copied from. */
function uploadTexture(device: WebGPUDevice, data: Uint8Array, size: number, label: string): Texture {
    const texture = device.createTexture({
        label, format: 'rgba8unorm', dimension: '2d', width: size, height: size,
        usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
    });
    device.writeTexture(texture, data, size, size);
    return texture;
}

/** A colour target that can be both drawn into and read back. */
/**
 * The bind-group entry for one uniform block, AT THE SLOT IT IS CURRENTLY WRITTEN TO.
 *
 * A `UniformSet` is an arena of slots, not a struct — see `rhi/uniformSet.ts`. Naming the buffer alone
 * would bind slot 0, which is right for the first draw of a pass and wrong for every one after it.
 */
function uniformEntry(set: UniformSet): BindGroupEntry {
    return { binding: set.layout.binding, buffer: set.buffer,
             offset: set.byteOffset, size: set.layout.size };
}

function makeTarget(device: WebGPUDevice, size: number, label: string): { texture: Texture; view: TextureView } {
    const texture = device.createTexture({
        label, format: 'rgba8unorm', dimension: '2d', width: size, height: size,
        usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC,
    });
    return { texture, view: device.createTextureView(texture) };
}

async function run(): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    const check = (name: string, pass: boolean, detail: string = '') =>
        results.push({ name, pass, detail });

    // A real canvas, so the surface half of the interface is exercised rather than skipped.
    //
    // Every other check here draws into a texture it made itself, which never touches the swap chain —
    // and the swap chain is the one resource the engine cannot substitute, since it is the only path to
    // the screen. It is in the DOM because a detached canvas has no presentation path at all on some
    // implementations, and the point is to test the one the editor will use.
    const surfaceCanvas = document.createElement('canvas');
    surfaceCanvas.width = SURFACE_W;
    surfaceCanvas.height = SURFACE_H;
    surfaceCanvas.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(surfaceCanvas);

    const device = await acquireWebGPUDevice({ powerPreference: 'high-performance', canvas: surfaceCanvas });
    if (!device) {
        check('device acquired', false, 'acquireWebGPUDevice returned null');
        return results;
    }

    const caps = device.capabilities;
    check('device acquired', device.backend === 'webgpu', `backend=${device.backend}`);
    check('capabilities are real limits',
          caps.maxTextureSize >= 8192 && caps.maxColorAttachments >= 4 && caps.hasCompute,
          `maxTexture=${caps.maxTextureSize} colorAttachments=${caps.maxColorAttachments} ` +
          `samplers=${caps.maxSamplersPerStage} float32Filterable=${caps.floatFilterable} ` +
          `timestamps=${caps.hasTimestampQuery} canvasFormat=${caps.preferredCanvasFormat}`);

    const quad = device.createBuffer({
        label: 'quad', size: QUAD.byteLength, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    device.writeBuffer(quad, 0, QUAD);

    const nearest = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
    const pattern = testPattern(SIZE);

    // -- 1. the engine's own screen.wgsl must reproduce its input exactly ------------------------
    {
        const module = makeModule(device, ScreenProgram, 'screen.wgsl');
        const pipeline = device.createRenderPipeline({
            label: 'screen',
            vertex: module, fragment: module,
            vertexLayouts: [QUAD_LAYOUT],
            primitive: { topology: 'triangle-strip', cullMode: 'none', frontFace: 'ccw' },
            colorTargets: [{ format: 'rgba8unorm' }],
        });

        const source = uploadTexture(device, pattern, SIZE, 'source');
        const target = makeTarget(device, SIZE, 'screen-out');
        const bindGroup = device.createBindGroup({
            layout: pipeline.bindGroupLayouts[0],
            entries: [
                { binding: 0, textureView: device.createWholeTextureView(source) },
                { binding: 1, sampler: nearest },
            ],
        });

        const renderTarget = device.createRenderTarget({ colorViews: [target.view] });
        const encoder = device.createCommandEncoder('screen');
        const pass = encoder.beginRenderPass(renderTarget, {
            label: 'screen',
            colorAttachments: [{ target: 0, loadOp: 'clear', storeOp: 'store', clearValue: [1, 0, 1, 1] }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.setVertexBuffer(0, quad);
        pass.draw(4);
        pass.end();
        encoder.finish();

        const read = await device.readPixels(target.view, 0, 0, SIZE, SIZE);
        let mismatches = 0;
        let firstBad = '';
        for (let i = 0; i < pattern.length; i++) {
            if (read[i] !== pattern[i]) {
                if (!mismatches) {
                    const px = Math.floor(i / 4);
                    firstBad = `first at px(${px % SIZE},${Math.floor(px / SIZE)}) ch${i % 4} ` +
                               `expected ${pattern[i]} got ${read[i]}`;
                }
                mismatches++;
            }
        }
        check('screen.wgsl is a bit-exact blit', mismatches === 0,
              mismatches ? `${mismatches}/${pattern.length} bytes differ; ${firstBad}` : 'all 16384 bytes match');
    }

    // -- 2. present.wgsl: uniform buffer in a second bind group ---------------------------------
    {
        const module = makeModule(device, PresentProgram, 'present.wgsl');
        const pipeline = device.createRenderPipeline({
            label: 'present',
            vertex: module, fragment: module,
            vertexLayouts: [QUAD_LAYOUT],
            primitive: { topology: 'triangle-strip', cullMode: 'none', frontFace: 'ccw' },
            colorTargets: [{ format: 'rgba8unorm' }],
        });

        check('present.wgsl declares two bind groups', pipeline.bindGroupLayouts.length === 2,
              `groups=[${pipeline.bindGroupLayouts.map(l => l.group).join(',')}]`);

        // A flat mid-grey input, so the expected output is one number rather than a per-pixel model.
        const flat = new Uint8Array(SIZE * SIZE * 4);
        for (let i = 0; i < flat.length; i += 4) { flat[i] = 128; flat[i + 1] = 128; flat[i + 2] = 128; flat[i + 3] = 255; }
        const source = uploadTexture(device, flat, SIZE, 'hdr');
        // A REAL depth texture, empty. `u_coverageDepth` is declared `texture_depth_2d` — a depth
        // format is the only thing that satisfies that binding, and an rgba8 stand-in is refused
        // ("None of the supported sample types (Float|UnfilterableFloat) ... match the expected sample
        // types (Depth)"), which invalidates the bind group and with it the whole command buffer, so
        // the pass does not even clear and the target reads back as zeros. Its CONTENTS do not matter
        // here: the draw below sets `u_alphaFromDepth` to 0, so nothing samples it.
        const depth = device.createTexture({
            label: 'coverage', format: 'depth24plus', dimension: '2d', width: SIZE, height: SIZE,
            usage: TextureUsage.TEXTURE_BINDING | TextureUsage.RENDER_ATTACHMENT,
        });

        // The uniform buffer is sized and addressed entirely from the BUILD-TIME layout — no hand-
        // written offsets, no `new Float32Array([exposure, 0])` that happens to match the struct.
        const block = PresentProgram.uniformBlocks[0];
        // The set owns its own ARENA now - one buffer holding many slots - because a draw reads the
        // slot it was given rather than whatever the last write left at offset 0. Nothing here has to
        // know how many slots there are; it asks the set where its current value is.
        const uniformSet = new UniformSet(block, device, 256, 'present');
        check('the present block layout arrived with the shader',
              block.size >= 8 && block.flat.length === 2,
              `size=${block.size} members=[${block.flat.map(m => m.name + '@' + m.offset).join(', ')}]`);

        const group0 = device.createBindGroup({
            layout: pipeline.bindGroupLayouts[0],
            entries: [
                { binding: 0, textureView: device.createWholeTextureView(source) },
                { binding: 1, sampler: nearest },
                { binding: 2, textureView: device.createWholeTextureView(depth) },
                { binding: 3, sampler: nearest },
            ],
        });

        const draw = async (exposure: number): Promise<Uint8Array> => {
            // BY NAME, through the alias the renderer actually uses — the layout knows this member as
            // `u_present.u_exposure`. This is the whole chain under test: name -> offset -> buffer ->
            // what the shader reads.
            if (!uniformSet.set('u_exposure', exposure)) throw new Error('u_exposure did not resolve');
            uniformSet.set('u_alphaFromDepth', 0);
            uniformSet.flush(device);
            // Built AFTER the flush, over the slot the flush just claimed. This is exactly what
            // `WebGPURenderPipeline.uniformGroupsFor` does per draw in the renderer, and the reason
            // it does: a bind group naming offset 0 would read whichever value was written last.
            const group1 = device.createBindGroup({
                layout: pipeline.bindGroupLayouts[1],
                entries: [{ binding: 0, buffer: uniformSet.buffer,
                            offset: uniformSet.byteOffset, size: block.size }],
            });
            const target = makeTarget(device, SIZE, `present-${exposure}`);
            const renderTarget = device.createRenderTarget({ colorViews: [target.view] });
            const encoder = device.createCommandEncoder('present');
            const pass = encoder.beginRenderPass(renderTarget, {
                label: 'present',
                colorAttachments: [{ target: 0, loadOp: 'clear', storeOp: 'store', clearValue: [1, 0, 1, 1] }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group0);
            pass.setBindGroup(1, group1);
            pass.setVertexBuffer(0, quad);
            pass.draw(4);
            pass.end();
            encoder.finish();
            const pixels = await device.readPixels(target.view, 0, 0, SIZE, SIZE);
            target.texture.destroy();
            return pixels;
        };

        const dark = await draw(0);
        check('exposure 0 tonemaps to black, alpha opaque',
              dark[0] === 0 && dark[1] === 0 && dark[2] === 0 && dark[3] === 255,
              `rgba=(${dark[0]},${dark[1]},${dark[2]},${dark[3]})`);

        // The uniform actually reaching the shader is the whole point of this program: it was the first
        // one with scalar uniforms, which is what forced the std140 block work on the WebGL2 side.
        const lit = await draw(1);
        const linear = 128 / 255;
        const expected = Math.round(cpuTonemap(linear, 1) * 255);
        const delta = Math.abs(lit[0] - expected);
        check('a uniform set BY NAME reaches the shader on WebGPU', delta <= 1,
              `u_exposure=1 via UniformSet -> shader=${lit[0]} cpu=${expected} delta=${delta}`);

        // Two different values through the same path, so a buffer that simply held the right bytes by
        // luck (or was never written at all) cannot pass.
        const dim = await draw(0.25);
        const expectedDim = Math.round(cpuTonemap(linear, 0.25) * 255);
        check('a second value writes to the same offset', Math.abs(dim[0] - expectedDim) <= 1,
              `u_exposure=0.25 -> shader=${dim[0]} cpu=${expectedDim}`);
        check('the two exposures differ', dim[0] < lit[0], `${dim[0]} < ${lit[0]}`);
    }

    // -- 3. render into ONE layer of an array texture (the shadow-cascade shape) -----------------
    {
        const solid = device.createShaderModule({
            label: 'solid',
            stage: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
            entryPoints: { vertex: 'vs_main', fragment: 'fs_main' },
            source: `
struct VertexOutput { @builtin(position) position: vec4<f32> };
struct Tint { color: vec4<f32> };
@group(0) @binding(0) var<uniform> u_tint: Tint;
@vertex fn vs_main(@location(0) position: vec3<f32>, @location(1) uv: vec2<f32>) -> VertexOutput {
    var out: VertexOutput;
    out.position = vec4<f32>(position, 1.0);
    return out;
}
@fragment fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> { return u_tint.color; }
`,
        });

        const pipeline = device.createRenderPipeline({
            label: 'solid',
            vertex: solid, fragment: solid,
            vertexLayouts: [QUAD_LAYOUT],
            primitive: { topology: 'triangle-strip', cullMode: 'none', frontFace: 'ccw' },
            colorTargets: [{ format: 'rgba8unorm' }],
        });

        const LAYERS = 4;
        const array = device.createTexture({
            label: 'layers', format: 'rgba8unorm', dimension: '2d-array',
            width: SIZE, height: SIZE, depthOrArrayLayers: LAYERS,
            usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC | TextureUsage.TEXTURE_BINDING,
        });

        const tint = device.createBuffer({ label: 'tint', size: 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
        const tintGroup = device.createBindGroup({
            layout: pipeline.bindGroupLayouts[0], entries: [{ binding: 0, buffer: tint }],
        });

        // Each layer gets a different value, so reading one back proves the view targeted that layer and
        // not simply layer 0 four times — which is exactly what a wrong `baseArrayLayer` looks like.
        for (let layer = 0; layer < LAYERS; layer++) {
            device.writeBuffer(tint, 0, new Float32Array([(layer + 1) / 8, 0, 0, 1]));
            const view = device.createTextureView(array, 0, layer);
            const renderTarget = device.createRenderTarget({ colorViews: [view] });
            const encoder = device.createCommandEncoder(`layer${layer}`);
            const pass = encoder.beginRenderPass(renderTarget, {
                label: `layer${layer}`,
                colorAttachments: [{ target: 0, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, tintGroup);
            pass.setVertexBuffer(0, quad);
            pass.draw(4);
            pass.end();
            encoder.finish();
        }

        const readings: number[] = [];
        for (let layer = 0; layer < LAYERS; layer++) {
            const pixels = await device.readPixels(device.createTextureView(array, 0, layer), 0, 0, 1, 1);
            readings.push(pixels[0]);
        }
        const expected = [0, 1, 2, 3].map(l => Math.round(((l + 1) / 8) * 255));
        const ok = readings.every((value, index) => Math.abs(value - expected[index]) <= 1);
        check('each array layer is targeted independently', ok,
              `read=[${readings.join(',')}] expected=[${expected.join(',')}]`);
    }

    // -- 4. multiple colour attachments (the G-buffer shape) ------------------------------------
    {
        const mrt = device.createShaderModule({
            label: 'mrt',
            stage: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
            entryPoints: { vertex: 'vs_main', fragment: 'fs_main' },
            source: `
struct VertexOutput { @builtin(position) position: vec4<f32> };
struct Targets {
    @location(0) a: vec4<f32>,
    @location(1) b: vec4<f32>,
    @location(2) c: vec4<f32>,
};
@vertex fn vs_main(@location(0) position: vec3<f32>, @location(1) uv: vec2<f32>) -> VertexOutput {
    var out: VertexOutput;
    out.position = vec4<f32>(position, 1.0);
    return out;
}
@fragment fn fs_main(in: VertexOutput) -> Targets {
    var out: Targets;
    out.a = vec4<f32>(1.0, 0.0, 0.0, 1.0);
    out.b = vec4<f32>(0.0, 1.0, 0.0, 1.0);
    out.c = vec4<f32>(0.0, 0.0, 1.0, 1.0);
    return out;
}
`,
        });

        // The `depthStencil` state is NOT optional here, and that is a real constraint on the port
        // rather than a detail of this test. WebGPU validates a pipeline's whole attachment state —
        // colour formats AND depth format — against the pass it is used in, so a pipeline that omits
        // depth cannot draw into a target that has a depth view. WebGL2 never cared: depth testing was
        // global state, and a shader neither knew nor declared whether a depth buffer was attached.
        // Every G-buffer pipeline therefore has to name the depth format the pass provides.
        const pipeline = device.createRenderPipeline({
            label: 'mrt',
            vertex: mrt, fragment: mrt,
            vertexLayouts: [QUAD_LAYOUT],
            primitive: { topology: 'triangle-strip', cullMode: 'none', frontFace: 'ccw' },
            depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
            colorTargets: [
                { format: 'rgba8unorm' }, { format: 'rgba8unorm' }, { format: 'rgba8unorm' },
            ],
        });

        const targets = [0, 1, 2].map(i => makeTarget(device, SIZE, `g${i}`));
        const depthTexture = device.createTexture({
            label: 'gdepth', format: 'depth24plus', dimension: '2d', width: SIZE, height: SIZE,
            usage: TextureUsage.RENDER_ATTACHMENT,
        });

        const renderTarget = device.createRenderTarget({
            colorViews: targets.map(t => t.view),
            depthView: device.createTextureView(depthTexture),
        });
        const encoder = device.createCommandEncoder('mrt');
        const pass = encoder.beginRenderPass(renderTarget, {
            label: 'mrt',
            colorAttachments: [0, 1, 2].map(target => ({
                target, loadOp: 'clear' as const, storeOp: 'store' as const,
                clearValue: [0, 0, 0, 1] as [number, number, number, number],
            })),
            depthAttachment: { loadOp: 'clear', storeOp: 'store', clearValue: 1 },
        });
        pass.setPipeline(pipeline);
        pass.setVertexBuffer(0, quad);
        pass.draw(4);
        pass.end();
        encoder.finish();

        const reads = await Promise.all(targets.map(t => device.readPixels(t.view, 0, 0, 1, 1)));
        const ok = reads[0][0] === 255 && reads[1][1] === 255 && reads[2][2] === 255;
        check('three colour attachments receive distinct output', ok,
              reads.map((r, i) => `g${i}=(${r[0]},${r[1]},${r[2]})`).join(' '));

        // Documented as a check so the constraint is stated where somebody porting a pass will read it:
        // this draw only succeeds because the pipeline above declares the pass's depth format. Dropping
        // `depthStencil` makes the whole command buffer invalid and every attachment reads back black.
        check('the pipeline declares the pass depth format', ok,
              'a depth-less pipeline against a depth target invalidates the command buffer');
    }

    // --- 6. a program with TWO uniform blocks, written by name ------------------------------------
    //
    // `outline` is the cleanest case in the engine: two blocks and no textures at all. One holds the
    // matrices and decides WHERE the triangle lands; the other holds the colour and decides what it
    // looks like — so a name routed to the wrong block does not merely shade differently, it moves the
    // geometry or leaves it black.
    //
    // Both blocks sit in GROUP 1, at bindings 0 and 1. They used to be groups 1 and 2, and this section
    // still said so long after the 6 -> 4 bind-group merge moved every uniform block into one group —
    // which is why it threw rather than failing: `forGroup(2)` is undefined now. A group holding several
    // blocks is the case the renderer actually has, and WebGPU rejects a bind group whose entry count
    // does not match its layout, so the two have to arrive together.
    //
    // This is the piece the renderer needs and did not have: `UniformSet` knows one block, and a
    // program has several.
    {
        const SIZE = 8;
        const module = device.createShaderModule({
            label: 'outline', stage: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
            source: OutlineProgram.wgsl, resources: OutlineProgram.resources,
            entryPoints: OutlineProgram.entryPoints,
        });
        const pipeline = device.createRenderPipeline({
            label: 'outline', vertex: module, fragment: module,
            vertexLayouts: [OUTLINE_VERTEX_LAYOUT],
            primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
            colorTargets: [{ format: 'rgba8unorm' }],
        });

        const program = new ProgramUniforms(device, OutlineProgram.uniformBlocks, 'outline');
        check('the outline program declares two uniform blocks, both in group 1',
              program.blocks.length === 2 && program.blocks.every(b => b.layout.group === 1)
              && new Set(program.blocks.map(b => b.layout.binding)).size === 2,
              program.blocks.map(b => 'g' + b.layout.group + 'b' + b.layout.binding + ':' + b.layout.name).join(' '));

        /** The one bind group `outline` needs: every block it declares, at its current slot. */
        const outlineGroup = (uniforms: ProgramUniforms) => device.createBindGroup({
            layout: pipeline.bindGroupLayouts.find(l => l.group === 1)!,
            entries: uniforms.blocks.map(uniformEntry),
        });

        // A full-viewport triangle in clip space, with identity view/projection.
        const IDENTITY = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
        const verts = new Float32Array([
            -1, -1, 0,  0, 0, 1,  0, 0,
             3, -1, 0,  0, 0, 1,  2, 0,
            -1,  3, 0,  0, 0, 1,  0, 2,
        ]);
        const vbo = device.createBuffer({ label: 'outline-verts', size: verts.byteLength,
                                          usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
        device.writeBuffer(vbo, 0, verts);

        const drawOutline = async (color: number[], scale: number): Promise<Uint8Array> => {
            // Every one of these is routed BY NAME across two blocks, exactly as the renderer writes
            // them — no group numbers, no offsets, no knowledge of which struct holds what.
            const model = [scale,0,0,0, 0,scale,0,0, 0,0,1,0, 0,0,0,1];
            if (!program.set('u_model', model)) throw new Error('u_model did not resolve');
            if (!program.set('u_view', IDENTITY)) throw new Error('u_view did not resolve');
            if (!program.set('u_projection', IDENTITY)) throw new Error('u_projection did not resolve');
            if (!program.set('u_outlineColor', color)) throw new Error('u_outlineColor did not resolve');
            program.flush(device);

            const target = makeTarget(device, SIZE, 'outline');
            const renderTarget = device.createRenderTarget({ colorViews: [target.view] });
            const group1 = outlineGroup(program);
            const encoder = device.createCommandEncoder('outline');
            const pass = encoder.beginRenderPass(renderTarget, {
                label: 'outline',
                colorAttachments: [{ target: 0, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(1, group1);
            pass.setVertexBuffer(0, vbo);
            pass.draw(3);
            pass.end();
            encoder.finish();
            const pixels = await device.readPixels(target.view, 0, 0, SIZE, SIZE);
            target.texture.destroy();
            return pixels;
        };

        // The second block decides the colour.
        const red = await drawOutline([1, 0, 0], 1);
        check('a name routed to the colour block colours the fragment',
              red[0] === 255 && red[1] === 0 && red[2] === 0,
              `rgb=(${red[0]},${red[1]},${red[2]})`);
        const teal = await drawOutline([0, 0.5, 1], 1);
        check('a second colour writes the same member again',
              teal[0] === 0 && Math.abs(teal[2] - 255) <= 1,
              `rgb=(${teal[0]},${teal[1]},${teal[2]})`);

        // The transform block decides the geometry. Scaling the model matrix to a quarter pulls the
        // triangle off the top-right corner, so that texel goes back to the clear colour while the
        // origin stays lit.
        const shrunk = await drawOutline([0, 0.5, 1], 0.25);
        const corner = ((SIZE - 1) * SIZE + (SIZE - 1)) * 4;
        check('a name routed to the transform block moves the geometry',
              shrunk[corner + 2] === 0 && teal[corner + 2] > 200,
              `corner blue: full=${teal[corner + 2]} shrunk=${shrunk[corner + 2]}`);

        // --- the same program, driven through the ShaderProgram INTERFACE ------------------------
        //
        // Everything above used `ProgramUniforms` directly. This is the shape the renderer actually
        // talks to: `setUniform(name, value)` and `flushUniformBlocks()`, the same two calls it makes
        // ~330 times against a WebGL2 `Shader`, reaching a WebGPU program that shares no code with it.
        {
            const gpuProgram = new WebGPUShaderProgram(device, 'outline',
                                                       OutlineProgram.vertexInputs,
                                                       OutlineProgram.uniformBlocks);

            // Attributes are DECLARED on this backend, not reflected off a linked program.
            check('the WebGPU program reports the shader vertex attributes',
                  gpuProgram.attributes.length === 3
                  && gpuProgram.attributes[0].name === 'a_position'
                  && gpuProgram.attributes[0].byteSize === 12
                  && gpuProgram.attributes[2].byteSize === 8,
                  gpuProgram.attributes.map(a => a.location + ':' + a.name + ':' + a.byteSize).join(' '));
            check('it reports no reflected vertexAttribPointer layout',
                  gpuProgram.attributes.every(a => a.layout === undefined),
                  'that shape is WebGL2-only and a WebGPU program must not invent one');

            check('hasUniform answers across both blocks',
                  gpuProgram.hasUniform('u_model') && gpuProgram.hasUniform('u_outlineColor')
                  && !gpuProgram.hasUniform('u_notAThing'),
                  'u_model (group 1), u_outlineColor (group 2), and a name neither declares');

            gpuProgram.use();   // bookkeeping on this backend — proves it is callable, not that it acts
            gpuProgram.setUniform('u_model', [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
            gpuProgram.setUniform('u_view', IDENTITY);
            gpuProgram.setUniform('u_projection', IDENTITY);
            gpuProgram.setUniform('u_outlineColor', [1, 1, 0]);
            gpuProgram.flushUniformBlocks();

            const target = makeTarget(device, SIZE, 'outline-iface');
            const renderTarget = device.createRenderTarget({ colorViews: [target.view] });
            const group1 = outlineGroup(gpuProgram.uniforms);
            const encoder = device.createCommandEncoder('outline-iface');
            const pass = encoder.beginRenderPass(renderTarget, {
                label: 'outline-iface',
                colorAttachments: [{ target: 0, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(1, group1);
            pass.setVertexBuffer(0, vbo);
            pass.draw(3);
            pass.end();
            encoder.finish();
            const px = await device.readPixels(target.view, 0, 0, SIZE, SIZE);
            target.texture.destroy();

            check('a uniform set through the ShaderProgram interface reaches the shader',
                  px[0] === 255 && px[1] === 255 && px[2] === 0,
                  `rgb=(${px[0]},${px[1]},${px[2]}) — set via setUniform + flushUniformBlocks`);

            check('describeBlockLayout reports both blocks with their members',
                  (gpuProgram.describeBlockLayout() as any[]).length === 2,
                  JSON.stringify((gpuProgram.describeBlockLayout() as any[]).map(b => b.name)));

            gpuProgram.dispose();
        }

        // --- TWO DRAWS IN ONE PASS, through the renderer's own path ------------------------------
        //
        // The check this backend was missing, and the reason a complete WebGPU frame rendered a scene
        // with most of its objects absent. `queue.writeBuffer` is ordered against the SUBMIT, not
        // against the commands already recorded, so a pass that wrote `u_model` before each of twenty
        // draws gave all twenty the LAST value. Every single-draw check above passed throughout.
        //
        // Driven through `ShaderManager` + `pass.setPipeline` + `pass.draw` rather than by building
        // bind groups here, because the aliasing lived in `WebGPURenderPassEncoder._flushUniforms` and
        // a check that binds by hand cannot see it.
        {
            const gpuProgram = device.createShaderProgram({ label: 'outline', ...OutlineProgram });
            ShaderManager.Instance.addShader('outline', gpuProgram);

            const target = makeTarget(device, SIZE, 'outline-multidraw');
            const renderTarget = device.createRenderTarget({ colorViews: [target.view] });
            const encoder = device.createCommandEncoder('outline-multidraw');
            const pass = encoder.beginRenderPass(renderTarget, {
                label: 'outline-multidraw',
                colorAttachments: [{ target: 0, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
            });
            pass.setPipeline(pipeline);
            pass.setVertexBuffer(0, vbo);
            // A scissor per draw, so the two land in different halves of the same attachment. The
            // alternative — two model matrices putting the geometry in different places — would test
            // the same thing, but a colour that is simply wrong is easier to read than geometry that
            // is in the wrong place.
            const half = SIZE / 2;
            for (const [x, color] of [[0, [1, 0, 0]], [half, [0, 0, 1]]] as [number, number[]][]) {
                gpuProgram.setUniform('u_model', [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
                gpuProgram.setUniform('u_view', IDENTITY);
                gpuProgram.setUniform('u_projection', IDENTITY);
                gpuProgram.setUniform('u_outlineColor', color);
                pass.setScissor(x, 0, half, SIZE);
                pass.draw(3);
            }
            pass.end();
            encoder.finish();
            const px = await device.readPixels(target.view, 0, 0, SIZE, SIZE);
            target.texture.destroy();

            const left = 0, right = half * 4;
            check('two draws in ONE pass keep their own uniforms',
                  px[left] === 255 && px[left + 2] === 0
                  && px[right] === 0 && px[right + 2] === 255,
                  `left=(${px[left]},${px[left + 1]},${px[left + 2]}) ` +
                  `right=(${px[right]},${px[right + 1]},${px[right + 2]}) — ` +
                  'both blue means every draw in the pass read the LAST uniform write');

            ShaderManager.Instance.removeShader('outline');
            gpuProgram.dispose();
        }

        program.destroy();
        vbo.destroy();
    }

    // --- reallocateBuffer ------------------------------------------------------------------------
    //
    // A GPUBuffer's size is fixed at creation, so growing one means destroying it and making another.
    // The interface returns the buffer to use from now on for exactly that reason, and this is what
    // proves the two cases behave the way the contract claims: a fit reuses the object, a grow does
    // not, and both leave the CONTENTS correct.
    {
        const initial = new Uint32Array([1, 2, 3, 4]);
        const buffer = device.createBuffer({ label: 'realloc', size: initial.byteLength,
                                            usage: BufferUsage.STORAGE | BufferUsage.COPY_DST | BufferUsage.COPY_SRC });
        const same = device.reallocateBuffer(buffer, initial);
        check('reallocateBuffer reuses a buffer the data still fits', same === buffer,
              same === buffer ? 'same object' : 'replaced unnecessarily');

        const bigger = new Uint32Array(64).fill(7);
        const grown = device.reallocateBuffer(same, bigger);
        check('reallocateBuffer replaces a buffer the data outgrows', grown !== buffer,
              grown !== buffer ? 'new object' : 'kept a buffer too small for the data');
        check('the replacement is large enough', (grown as any).size >= bigger.byteLength,
              (grown as any).size + ' >= ' + bigger.byteLength);
        grown.destroy();
    }

    // --- the swap chain --------------------------------------------------------------------------
    //
    // The only resource with no substitute: every other target in this file is a texture the harness
    // allocated, and none of them is the screen. Two things have to hold for the renderer's present
    // pass to work — the surface target must describe the canvas as it is NOW, and drawing into it must
    // actually land in its pixels.
    //
    // The size half is checked across a resize because that is where it can silently go wrong: the
    // renderer resizes its own internal buffers on every viewport change, and if the surface did not
    // follow it would keep presenting at the old size into a target the compositor then rescales —
    // a soft image with nothing anywhere reporting an error.
    {
        const before = device.getCurrentSurfaceTarget();
        check('the surface target describes the canvas',
              before.width === SURFACE_W && before.height === SURFACE_H,
              `${before.width}x${before.height}, canvas ${SURFACE_W}x${SURFACE_H}`);

        // Drawing into the swap chain, not merely acquiring it. The surface is configured COPY_SRC for
        // exactly this — acquiring a target proves nothing about whether a pass can write to it.
        const encoder = device.createCommandEncoder('surface-clear');
        const pass = encoder.beginRenderPass(before, {
            label: 'surface-clear',
            colorAttachments: [{ target: 0, loadOp: 'clear', storeOp: 'store', clearValue: [0, 1, 0, 1] }],
        });
        pass.end();
        encoder.finish();
        const pixels = await device.readPixels(before.colorViews[0], 0, 0, 2, 2);
        // The surface format is the platform's preferred one, which is bgra8unorm on most desktops —
        // so this asserts on the GREEN channel and on opacity, the two that mean the same thing in
        // either channel order, rather than pinning a byte order the platform gets to choose.
        const green = pixels[1] > 240 && pixels[0] < 16 && pixels[3] > 240;
        check('a render pass writes to the swap-chain texture', green,
              `rgba(${pixels[0]},${pixels[1]},${pixels[2]},${pixels[3]}) from a green clear`);

        // MEASURED (2026-08-23, this driver): the resize below passes with the `reconfigureSurface`
        // call commented out. `getCurrentTexture()` reads the canvas's CURRENT width/height, and
        // `configure()` carries no size, so a plain resize needs no reconfiguration — which is what the
        // spec says and the opposite of what this check was first written to assert. Recorded here
        // because the next person to read `Renderer.resize` will wonder, and re-measuring costs a
        // rebuild and a driver run. What the call is actually for is re-establishing configuration
        // after the canvas is re-parented, which the editor does on every mode switch.
        surfaceCanvas.width = SURFACE_W * 2;
        surfaceCanvas.height = SURFACE_H + 17;
        device.reconfigureSurface();
        const after = device.getCurrentSurfaceTarget();
        check('the surface follows a canvas resize',
              after.width === SURFACE_W * 2 && after.height === SURFACE_H + 17,
              `${after.width}x${after.height}, canvas ${surfaceCanvas.width}x${surfaceCanvas.height}`);
    }

    // --- timestamp queries -----------------------------------------------------------------------
    //
    // The GPU-timing tier: `Device.setTimestampCollection` + `Device.collectTimestamps`, exercised
    // through the interface exactly as `gpuProfiler`'s WebGPU backend uses them. Everything else about
    // the profiler is object graphs and is covered in tests/gpuProfiler.test.ts; what needs a driver
    // is whether a `GPUQuerySet` written by `timestampWrites` resolves into readable numbers at all.
    //
    // REPORTED, NEVER ASSERTED ON PRESENCE. `timestamp-query` is an optional feature and an adapter is
    // free to withhold it — Chrome gates it behind a flag on some platforms and it is commonly absent
    // in headless or software configurations. A gate that failed on its absence would be failing on
    // the hardware it ran on, so the availability line is always a pass and only the BEHAVIOUR checks
    // (which run when the feature is there) can fail.
    {
        check('timestamp-query availability (reported, not required)', true,
              caps.hasTimestampQuery ? 'feature present — timing checks below ran'
                                     : 'feature absent on this adapter — timing checks skipped');

        if (caps.hasTimestampQuery) {
            const collected: [string, number][] = [];
            device.setTimestampCollection(true, (label, ms) => collected.push([label, ms]));

            // Two passes of deliberately different cost, on one target, in a known order. `ts.cheap`
            // clears and draws nothing; `ts.expensive` blits over a 512x512 target a thousand times.
            // The ORDER is what makes the labels checkable: were the begin/end query indices paired
            // wrongly, the two costs would swap or blend into each other.
            const LOAD_SIZE = 512, LOAD_DRAWS = 400;
            const module = makeModule(device, ScreenProgram, 'screen.wgsl');
            const pipeline = device.createRenderPipeline({
                label: 'timestamp-load',
                vertex: module, fragment: module,
                vertexLayouts: [QUAD_LAYOUT],
                primitive: { topology: 'triangle-strip', cullMode: 'none', frontFace: 'ccw' },
                colorTargets: [{ format: 'rgba8unorm' }],
            });
            const source = uploadTexture(device, pattern, SIZE, 'timestamp-src');
            const target = makeTarget(device, LOAD_SIZE, 'timestamp-dst');
            const renderTarget = device.createRenderTarget({ colorViews: [target.view] });
            const bindGroup = device.createBindGroup({
                layout: pipeline.bindGroupLayouts[0],
                entries: [
                    { binding: 0, textureView: device.createWholeTextureView(source) },
                    { binding: 1, sampler: nearest },
                ],
            });

            const encoder = device.createCommandEncoder('timestamps');
            const cheap = encoder.beginRenderPass(renderTarget, {
                label: 'ts.cheap',
                colorAttachments: [{ target: 0, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
            });
            cheap.end();

            const expensive = encoder.beginRenderPass(renderTarget, {
                label: 'ts.expensive',
                colorAttachments: [{ target: 0, loadOp: 'load', storeOp: 'store' }],
            });
            expensive.setPipeline(pipeline);
            expensive.setBindGroup(0, bindGroup);
            expensive.setVertexBuffer(0, quad);
            // ~100 megatexels of fill. One blit is nowhere near the browser's timestamp
            // quantisation floor (Chrome rounds to ~100µs without the fine-resolution origin trial),
            // so the difference has to be made out of real work rather than expected from one draw.
            for (let i = 0; i < LOAD_DRAWS; i++) expensive.draw(4);
            expensive.end();
            encoder.finish();

            // Never wait on the GPU — pump the drain the way the profiler does, once per frame, until
            // the results turn up or the budget runs out. `mapAsync` resolves on a task, so this has
            // to yield to the event loop between pumps; a busy loop would spin forever.
            for (let attempt = 0; attempt < 240 && collected.length < 2; attempt++) {
                device.collectTimestamps();
                await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
            }

            check('two timed passes come back, labelled and in the order they were recorded',
                  collected.length === 2 && collected[0][0] === 'ts.cheap'
                      && collected[1][0] === 'ts.expensive',
                  collected.map(([label, ms]) => label + '=' + ms.toFixed(4) + 'ms').join(' ')
                      || 'nothing drained within 240 frames');

            if (collected.length === 2) {
                const cheapMs = collected[0][1], expensiveMs = collected[1][1];
                // Ordered and nonzero at the expensive end. NOT a ratio, and deliberately NOT
                // `cheapMs > 0`: MEASURED here, the empty clear reads back exactly 0.0000ms, because
                // browsers quantise timestamps (Chrome to ~100µs) and both ends of a sub-quantum pass
                // land on the same tick. Zero is the honest report for "below the measurement floor",
                // so the only claim worth asserting is that four hundred fullscreen blits cost
                // strictly more than an empty clear.
                check('the expensive pass costs strictly more than the cheap one',
                      expensiveMs > 0 && expensiveMs > cheapMs,
                      'cheap=' + cheapMs.toFixed(4) + 'ms expensive=' + expensiveMs.toFixed(4)
                          + 'ms — a 0.0000 cheap reading is the quantisation floor, not a lost sample');
            }

            // Switching collection off has to stop it at the DEVICE, not merely at the profiler: a
            // pass recorded afterwards must carry no `timestampWrites` and drain nothing. The sink is
            // deliberately the same appending one, so a device that kept recording would be caught
            // here rather than silently swallowed by a no-op sink.
            device.setTimestampCollection(false, (label, ms) => collected.push([label, ms]));
            collected.length = 0;
            const after = device.createCommandEncoder('timestamps-off');
            after.beginRenderPass(renderTarget, {
                label: 'ts.off',
                colorAttachments: [{ target: 0, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
            }).end();
            after.finish();
            for (let attempt = 0; attempt < 8; attempt++) {
                device.collectTimestamps();
                await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
            }
            check('collection off stops the device recording timestamps', collected.length === 0,
                  collected.length === 0 ? 'nothing drained'
                                         : 'drained ' + collected.length + ' unexpectedly');

            target.texture.destroy();
            source.destroy();
        }
    }

    // -- 9. compute tier: the cloud-noise volume bake --------------------------------------------
    //
    // The one workload in this engine that a render pass cannot express. A WebGPU colour attachment
    // must be a 2D or 2D-array view, and a 3D texture's z-slice is neither, so the WebGL2 bake — a
    // fullscreen draw per slice with `framebufferTextureLayer` re-pointing the attachment — has no
    // WebGPU spelling at all. `cloudNoiseBakeCompute.wgsl` writes the same volume as a
    // `texture_storage_3d` in one dispatch instead.
    //
    // Four claims are under test and they fail in different ways:
    //   a. the RHI compute surface works end to end (module -> pipeline -> storage bind -> dispatch);
    //   b. the compute field matches the RASTER field — the same `cloudNoiseBake.wgsl` the WebGL2
    //      renderer bakes with, run here into an ordinary 2D target, which WebGPU is perfectly happy
    //      to do. That is what "the two backends produce the same clouds" actually means;
    //   c. both match an independent CPU twin, which is the only one of the three that can catch the
    //      two shaders drifting TOGETHER — they share a chunk, so (b) would call that a pass;
    //   d. TWO volumes with different settings, recorded on ONE encoder, each come out with its own
    //      settings. That is not a hypothetical: the renderer's first draft shared a single uniform
    //      buffer between the base and detail dispatches, and because `writeBuffer` is queued and the
    //      encoder is submitted once, BOTH writes landed before either dispatch ran and both volumes
    //      were baked as detail. It is invisible to a one-volume check.
    {
        const V = 16;                       // volume edge; a multiple of the 4x4x4 workgroup
        // The two volumes the renderer bakes, in miniature. Different in every field that matters, so
        // a mixed-up uniform buffer cannot produce a passing result by coincidence.
        const BASE = { period: 4, octaves: 4, detail: 0 };
        const DETAIL = { period: 8, octaves: 3, detail: 1 };
        // Slices to check. 0 and V-1 are where a half-texel offset shows up first: the whole
        // compute-vs-raster question is whether `(gid + 0.5) / size` reproduces the raster path's
        // fragment-centre uv and the renderer's `(z + 0.5) / size` slice uniform.
        const SLICES = [0, 1, V / 2, V - 1];

        interface NoiseSettings { period: number; octaves: number; detail: number; }

        /** The 16-byte uniform block both bake shaders declare: two f32 then two i32, no padding. */
        const noiseUniforms = (first: number, s: NoiseSettings): Uint8Array => {
            const bytes = new ArrayBuffer(16);
            new Float32Array(bytes).set([first, s.period]);
            new Int32Array(bytes, 8).set([s.octaves, s.detail]);
            return new Uint8Array(bytes);
        };

        const computeModule = device.createShaderModule({
            label: 'cloudNoiseBakeCompute.wgsl',
            stage: ShaderStage.COMPUTE,
            source: CloudNoiseBakeComputeProgram.wgsl,
            entryPoints: CloudNoiseBakeComputeProgram.entryPoints,
            resources: CloudNoiseBakeComputeProgram.resources,
        });
        check('the compute module declares a compute stage and no raster stage',
              computeModule.entryPoints.compute === 'cs_main' && !computeModule.entryPoints.vertex
                  && !computeModule.entryPoints.fragment,
              'entryPoints=' + JSON.stringify(computeModule.entryPoints));

        const computePipeline = device.createComputePipeline({
            label: 'cloudNoiseBake', compute: computeModule,
        });
        check('a compute pipeline exposes the one bind group its module declares',
              computePipeline.bindGroupLayouts.length === 1
                  && computePipeline.bindGroupLayouts[0].group === 0,
              'groups=[' + computePipeline.bindGroupLayouts.map(l => l.group).join(',') + ']');

        // Both volumes on ONE encoder, exactly as the renderer records them — see claim (d) above.
        const dispatch = device.createCommandEncoder('cloudNoiseBake');
        const bakeVolume = (label: string, settings: NoiseSettings): Texture => {
            // STORAGE_BINDING and no RENDER_ATTACHMENT — the exclusivity `TextureConfig.storage`
            // encodes: nothing ever draws into one of these.
            const texture = device.createTexture({
                label, format: 'rgba8unorm', dimension: '3d',
                width: V, height: V, depthOrArrayLayers: V,
                usage: TextureUsage.TEXTURE_BINDING | TextureUsage.STORAGE_BINDING,
            });
            const uniforms = device.createBuffer({
                label: label + '-uniforms', size: 16,
                usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
            });
            device.writeBuffer(uniforms, 0, noiseUniforms(V, settings));

            const pass = dispatch.beginComputePass(label);
            pass.setPipeline(computePipeline);
            // The whole-texture view is the load-bearing part. `createTextureView` narrows a 3D
            // texture to a `2d` view of layer 0 and `texture_storage_3d` rejects that — the gap
            // `createWholeTextureView` was promoted onto the `Device` interface to close.
            pass.setBindGroup(0, device.createBindGroup({
                label,
                layout: computePipeline.bindGroupLayouts[0],
                entries: [
                    { binding: 0, buffer: uniforms },
                    { binding: 1, storageTextureView: device.createWholeTextureView(texture) },
                ],
            }));
            pass.dispatchWorkgroups(V / 4, V / 4, V / 4);
            pass.end();
            return texture;
        };
        const baseVolume = bakeVolume('cloudNoise.base', BASE);
        const detailVolume = bakeVolume('cloudNoise.detail', DETAIL);
        dispatch.finish();

        // Reading a 3D texture back: `textureLoad` at the fragment's own integer coordinates, into a
        // VxV 2D target. Deliberately a load and not a sampler — a load is exact, so the RGBA8 that
        // comes back IS the byte that was stored rather than a filtered reconstruction of it, and the
        // comparison below is then about the bake rather than about sampling.
        const READBACK_WGSL = [
            'struct VOut { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };',
            '@vertex fn vs_main(@location(0) p: vec3<f32>, @location(1) uv: vec2<f32>) -> VOut {',
            '    var out: VOut; out.position = vec4<f32>(p, 1.0); out.uv = uv; return out;',
            '}',
            '@group(0) @binding(0) var u_volume: texture_3d<f32>;',
            'struct SliceUniforms { z: i32 };',
            '@group(1) @binding(0) var<uniform> u_slice: SliceUniforms;',
            '@fragment fn fs_main(in: VOut) -> @location(0) vec4<f32> {',
            '    let xy = vec2<i32>(in.position.xy);',
            '    return textureLoad(u_volume, vec3<i32>(xy.x, xy.y, u_slice.z), 0);',
            '}',
        ].join('\n');
        const readbackModule = device.createShaderModule({
            label: 'volume-readback', stage: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
            source: READBACK_WGSL, entryPoints: { vertex: 'vs_main', fragment: 'fs_main' },
        });
        const readbackPipeline = device.createRenderPipeline({
            label: 'volume-readback',
            vertex: readbackModule, fragment: readbackModule,
            vertexLayouts: [QUAD_LAYOUT],
            primitive: { topology: 'triangle-strip', cullMode: 'none', frontFace: 'ccw' },
            colorTargets: [{ format: 'rgba8unorm' }],
        });
        const sliceUniforms = device.createBuffer({
            label: 'slice', size: 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
        });
        const sliceGroup = device.createBindGroup({
            layout: readbackPipeline.bindGroupLayouts.filter(l => l.group === 1)[0],
            entries: [{ binding: 0, buffer: sliceUniforms }],
        });
        const volumeGroup = (texture: Texture) => device.createBindGroup({
            layout: readbackPipeline.bindGroupLayouts.filter(l => l.group === 0)[0],
            entries: [{ binding: 0, textureView: device.createWholeTextureView(texture) }],
        });
        const baseGroup = volumeGroup(baseVolume), detailGroup = volumeGroup(detailVolume);

        // The RASTER shader, on a 2D target. `cloudNoiseBake.wgsl` declares group 1 only, so the
        // pipeline's group 0 is one of the empty ones `setPipeline` fills in for it.
        const rasterModule = makeModule(device, CloudNoiseBakeProgram, 'cloudNoiseBake.wgsl');
        const rasterPipeline = device.createRenderPipeline({
            label: 'cloudNoiseBake-raster',
            vertex: rasterModule, fragment: rasterModule,
            vertexLayouts: [QUAD_LAYOUT],
            primitive: { topology: 'triangle-strip', cullMode: 'none', frontFace: 'ccw' },
            colorTargets: [{ format: 'rgba8unorm' }],
        });
        const rasterUniforms = device.createBuffer({
            label: 'cloudNoiseBake-raster-uniforms', size: 16,
            usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
        });
        const rasterGroup = device.createBindGroup({
            layout: rasterPipeline.bindGroupLayouts.filter(l => l.group === 1)[0],
            entries: [{ binding: 0, buffer: rasterUniforms }],
        });

        /** Draw one VxV pass into a fresh target and read it back. */
        const drawAndRead = async (label: string, pipeline: RenderPipeline,
                                   bind: (pass: RenderPassEncoder) => void): Promise<Uint8Array> => {
            const target = makeTarget(device, V, label);
            const renderTarget = device.createRenderTarget({ colorViews: [target.view] });
            const encoder = device.createCommandEncoder(label);
            const pass = encoder.beginRenderPass(renderTarget, {
                label,
                colorAttachments: [{ target: 0, loadOp: 'clear', storeOp: 'store', clearValue: [1, 0, 1, 1] }],
            });
            pass.setPipeline(pipeline);
            bind(pass);
            pass.setVertexBuffer(0, quad);
            pass.draw(4);
            pass.end();
            encoder.finish();
            const pixels = await device.readPixels(target.view, 0, 0, V, V);
            target.texture.destroy();
            return pixels;
        };

        /** One VxV slice of a baked volume, read straight back. */
        const readComputedSlice = async (group: BindGroup, z: number): Promise<Uint8Array> => {
            device.writeBuffer(sliceUniforms, 0, new Int32Array([z, 0, 0, 0]));
            return drawAndRead('volume-readback-z' + z, readbackPipeline, (pass) => {
                pass.setBindGroup(0, group);
                pass.setBindGroup(1, sliceGroup);
            });
        };

        /** The same slice, produced by the raster shader into a 2D target. */
        const readRasterSlice = async (z: number, settings: NoiseSettings): Promise<Uint8Array> => {
            device.writeBuffer(rasterUniforms, 0, noiseUniforms((z + 0.5) / V, settings));
            return drawAndRead('cloudNoiseBake-raster-z' + z, rasterPipeline,
                               (pass) => { pass.setBindGroup(1, rasterGroup); });
        };

        interface Agreement {
            maxComputeVsRaster: number; maxComputeVsCpu: number; maxRasterVsCpu: number;
            outliers: number; compared: number; nonZero: number; histogram: number[]; worst: string;
        }

        const compare = async (group: BindGroup, settings: NoiseSettings): Promise<Agreement> => {
            const a: Agreement = {
                maxComputeVsRaster: 0, maxComputeVsCpu: 0, maxRasterVsCpu: 0,
                outliers: 0, compared: 0, nonZero: 0, histogram: new Array(64).fill(0), worst: '',
            };
            for (const z of SLICES) {
                const computed = await readComputedSlice(group, z);
                const rastered = await readRasterSlice(z, settings);
                for (let y = 0; y < V; y++) {
                    for (let x = 0; x < V; x++) {
                        const i = (y * V + x) * 4;
                        const expected = cloudNoiseTexel(
                            ((x + 0.5) / V) * settings.period, ((y + 0.5) / V) * settings.period,
                            ((z + 0.5) / V) * settings.period,
                            settings.period, settings.octaves, settings.detail);
                        for (let c = 0; c < 4; c++) {
                            const cpu = Math.round(Math.min(1, Math.max(0, expected[c])) * 255);
                            const dComputeRaster = Math.abs(computed[i + c] - rastered[i + c]);
                            const dComputeCpu = Math.abs(computed[i + c] - cpu);
                            const dRasterCpu = Math.abs(rastered[i + c] - cpu);
                            a.maxComputeVsRaster = Math.max(a.maxComputeVsRaster, dComputeRaster);
                            a.maxRasterVsCpu = Math.max(a.maxRasterVsCpu, dRasterCpu);
                            if (dComputeCpu > a.maxComputeVsCpu) {
                                a.maxComputeVsCpu = dComputeCpu;
                                a.worst = 'worst at (' + x + ',' + y + ',' + z + ') ch' + c
                                        + ' compute=' + computed[i + c] + ' raster=' + rastered[i + c]
                                        + ' cpu=' + cpu;
                            }
                            if (dComputeCpu > 2) a.outliers++;
                            a.histogram[Math.min(dComputeCpu, 63)]++;
                            if (computed[i + c] !== 0) a.nonZero++;
                            a.compared++;
                        }
                    }
                }
            }
            return a;
        };

        const base = await compare(baseGroup, BASE);
        const detail = await compare(detailGroup, DETAIL);

        // Guards the tolerances below from passing on an all-zero volume: a dispatch that never ran
        // leaves the texture cleared, and "0 differs from 0 by 0" would sail through a comparison
        // between two paths that had both failed the same way.
        check('both dispatches wrote their volume rather than leaving it cleared',
              base.compared === SLICES.length * V * V * 4
                  && base.nonZero > base.compared * 0.9 && detail.nonZero > detail.compared * 0.9,
              'base ' + base.nonZero + '/' + base.compared + ' nonzero, detail '
                  + detail.nonZero + '/' + detail.compared + ' nonzero, slices [' + SLICES.join(',') + ']');

        // +/-1 LSB is the floor, not a hope: `textureStore` to rgba8unorm and a fragment write to an
        // RGBA8 attachment both round to nearest from the same f32, but the two rounding steps are
        // different parts of the driver, so a half-ULP difference upstream lands either side of a .5.
        check('the compute field matches the raster field to within 1 LSB',
              base.maxComputeVsRaster <= 1 && detail.maxComputeVsRaster <= 1,
              'max channel difference: base = ' + base.maxComputeVsRaster + '/255, detail = '
                  + detail.maxComputeVsRaster + '/255');

        // The independent statement, and claim (d) with it: the two volumes are compared against a
        // twin evaluated with THEIR OWN settings, so a shared uniform buffer that let the second
        // dispatch's write reach the first fails here rather than silently baking two detail volumes.
        //
        // WHY A DISTRIBUTION AND NOT A MAXIMUM. `hashCell` ends in `fract((c.x + c.y) * c.z)` over a
        // value of order 18000, where one f32 ULP is about 0.002. A single-precision twin therefore
        // reproduces the GPU almost everywhere and then, for the occasional lattice cell whose product
        // sits within an ULP of an integer, lands on the OTHER side of the fract and differs by nearly
        // a whole hash. That is a property of the hash, not a defect in either implementation, and no
        // amount of care in the twin removes it.
        //
        // MEASURED on this adapter over 4096 channels per volume (4 slices of a 16³ volume): the base
        // field came back 3855 exact, 240 off by one, and exactly ONE at 36. So the gate is "99.9%
        // within 2 LSB", which that distribution clears by a factor of forty while every failure worth
        // catching blows straight through it: a dropped half-texel offset moves essentially every
        // channel, and so does a wrong octave count, a mis-ordered fbm band or a swapped uniform.
        const report = (label: string, a: Agreement) =>
            label + ': outliers ' + a.outliers + '/' + a.compared + ', hist '
                  + a.histogram.map((n, d) => n ? d + ':' + n : '').filter(Boolean).join(',')
                  + (a.worst ? ' (' + a.worst + ')' : '');
        const budget = base.compared / 1000;
        check('both volumes match an independent CPU twin of cloudNoiseTexel (99.9% within 2 LSB)',
              base.outliers <= budget && detail.outliers <= budget
                  && base.maxRasterVsCpu === base.maxComputeVsCpu
                  && detail.maxRasterVsCpu === detail.maxComputeVsCpu,
              report('base', base) + ' | ' + report('detail', detail) + ' | budget ' + budget);

        baseVolume.destroy();
        detailVolume.destroy();
    }

    device.destroy();
    surfaceCanvas.remove();
    return results;
}

declare global {
    interface Window {
        __gpuReady: boolean;
        __gpuError: string | null;
        __gpuResults: CheckResult[] | null;
    }
}

window.__gpuReady = false;
window.__gpuError = null;
window.__gpuResults = null;

void (async () => {
    try {
        window.__gpuResults = await run();
    } catch (error) {
        window.__gpuError = String((error as Error)?.stack ?? error);
    } finally {
        window.__gpuReady = true;
    }
})();
