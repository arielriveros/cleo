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
import type { Texture, TextureView, ShaderModule } from '../../../../src/graphics/rhi/resources';
import ScreenProgram from '../../../../src/graphics/shaders/wgsl/screen.wgsl';
import PresentProgram from '../../../../src/graphics/shaders/wgsl/present.wgsl';
import OutlineProgram from '../../../../src/graphics/shaders/wgsl/outline.wgsl';

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
                { binding: 0, textureView: device.createSamplingView(source) },
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
        const depth = uploadTexture(device, flat, SIZE, 'coverage');

        // The uniform buffer is sized and addressed entirely from the BUILD-TIME layout — no hand-
        // written offsets, no `new Float32Array([exposure, 0])` that happens to match the struct.
        const block = PresentProgram.uniformBlocks[0];
        const uniforms = device.createBuffer({
            label: 'present-uniforms', size: block.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
        });
        const uniformSet = new UniformSet(block, uniforms);
        check('the present block layout arrived with the shader',
              block.size >= 8 && block.flat.length === 2,
              `size=${block.size} members=[${block.flat.map(m => m.name + '@' + m.offset).join(', ')}]`);

        const group0 = device.createBindGroup({
            layout: pipeline.bindGroupLayouts[0],
            entries: [
                { binding: 0, textureView: device.createSamplingView(source) },
                { binding: 1, sampler: nearest },
                { binding: 2, textureView: device.createSamplingView(depth) },
                { binding: 3, sampler: nearest },
            ],
        });
        const group1 = device.createBindGroup({
            layout: pipeline.bindGroupLayouts[1],
            entries: [{ binding: 0, buffer: uniforms }],
        });

        const draw = async (exposure: number): Promise<Uint8Array> => {
            // BY NAME, through the alias the renderer actually uses — the layout knows this member as
            // `u_present.u_exposure`. This is the whole chain under test: name -> offset -> buffer ->
            // what the shader reads.
            if (!uniformSet.set('u_exposure', exposure)) throw new Error('u_exposure did not resolve');
            uniformSet.set('u_alphaFromDepth', 0);
            uniformSet.flush(device);
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
    // `outline` is the cleanest case in the engine: matrices in group 1, a colour in group 2, and no
    // textures at all. That separation is what makes the test sharp — group 1 decides WHERE the
    // triangle lands and group 2 decides WHAT COLOUR it is, so a name routed to the wrong block does
    // not merely shade differently, it moves the geometry or leaves it black.
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
        check('the outline program declares two uniform blocks',
              program.blocks.length === 2 && !!program.forGroup(1) && !!program.forGroup(2),
              program.blocks.map(b => 'g' + b.layout.group + ':' + b.layout.name).join(' '));

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
            const groups = [1, 2].map(g => device.createBindGroup({
                layout: pipeline.bindGroupLayouts.find(l => l.group === g)!,
                entries: [{ binding: 0, buffer: program.forGroup(g)!.buffer }],
            }));
            const encoder = device.createCommandEncoder('outline');
            const pass = encoder.beginRenderPass(renderTarget, {
                label: 'outline',
                colorAttachments: [{ target: 0, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(1, groups[0]);
            pass.setBindGroup(2, groups[1]);
            pass.setVertexBuffer(0, vbo);
            pass.draw(3);
            pass.end();
            encoder.finish();
            const pixels = await device.readPixels(target.view, 0, 0, SIZE, SIZE);
            target.texture.destroy();
            return pixels;
        };

        // Group 2 decides the colour.
        const red = await drawOutline([1, 0, 0], 1);
        check('a name routed to group 2 colours the fragment',
              red[0] === 255 && red[1] === 0 && red[2] === 0,
              `rgb=(${red[0]},${red[1]},${red[2]})`);
        const teal = await drawOutline([0, 0.5, 1], 1);
        check('a second colour writes the same member again',
              teal[0] === 0 && Math.abs(teal[2] - 255) <= 1,
              `rgb=(${teal[0]},${teal[1]},${teal[2]})`);

        // Group 1 decides the geometry. Scaling the model matrix to a quarter pulls the triangle off
        // the top-right corner, so that texel goes back to the clear colour while the origin stays lit.
        const shrunk = await drawOutline([0, 0.5, 1], 0.25);
        const corner = ((SIZE - 1) * SIZE + (SIZE - 1)) * 4;
        check('a name routed to group 1 moves the geometry',
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
            const groups = [1, 2].map(g => device.createBindGroup({
                layout: pipeline.bindGroupLayouts.find(l => l.group === g)!,
                entries: [{ binding: 0, buffer: gpuProgram.uniforms.forGroup(g)!.buffer }],
            }));
            const encoder = device.createCommandEncoder('outline-iface');
            const pass = encoder.beginRenderPass(renderTarget, {
                label: 'outline-iface',
                colorAttachments: [{ target: 0, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(1, groups[0]);
            pass.setBindGroup(2, groups[1]);
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
