// A graphics device that draws nothing: what the engine runs on when there is no GPU at all — the NetSync
// dedicated host (docs/design/netsync.md §7), a headless tool.
//
// Everything that ALLOCATES works: a Mesh gets a buffer, a texture is sized and configured, a program has
// uniforms that take any value. Nothing is uploaded or kept — a buffer remembers its size, not its bytes — so a
// scene full of models costs the host no memory for their geometry beyond what the CPU side already holds.
// Rendering through it is never meant to happen: a pass records into the void, a readback returns zeros.
//
// It answers as a minimal WebGL2-class device (no compute, no storage buffers, no timestamp queries), so any
// code that chooses a path by capability takes the simplest one.

import type {
    BindGroupDescriptor, BufferDescriptor, CommandEncoder, ComputePassEncoder, ComputePipelineDescriptor, Device,
    DeviceCapabilities, RenderPassEncoder, RenderPipelineDescriptor, RenderTargetDescriptor, ShaderModuleDescriptor,
    TextureDescriptor,
} from '../device';
import type {
    BindGroup, BindGroupLayout, Buffer, ComputePipeline, RenderPipeline, RenderTarget, Sampler, ShaderModule, Texture,
    TextureView,
} from '../resources';
import type { AttributeInfo, ShaderProgram, ShaderProgramDescriptor } from '../shaderProgram';
import type {
    AddressMode, BufferUsageFlags, SamplerDescriptor, TextureConfigureDescriptor, TextureDimension, TextureFormat,
    TextureUsageFlags,
} from '../types';

const CAPABILITIES: DeviceCapabilities = {
    backend: 'webgl2',
    conventions: {
        clipDepthZeroToOne: false,
        originTopLeft: false,
        readbackRowsTopDown: false,
        writeTextureConvertsFloatToHalf: false,
        pipelineCreationCompiles: false,
        runtimeShaderLanguage: 'glsl',
    },
    maxTextureSize: 4096,
    maxTextureArrayLayers: 256,
    max3DTextureSize: 256,
    maxColorAttachments: 4,
    maxSamplersPerStage: 16,
    maxVertexAttributes: 16,
    maxUniformBufferBindingSize: 16384,
    floatRenderable: false,
    floatFilterable: false,
    hasCompute: false,
    hasStorageBuffers: false,
    hasIndirectDraw: false,
    hasOcclusionQuery: false,
    hasTimestampQuery: false,
    parallelShaderCompile: false,
    maxAnisotropy: 1,
    preferredCanvasFormat: 'rgba8unorm',
    adapterInfo: { vendor: 'none', architecture: 'none', device: 'null', description: 'Null device (headless)' },
};

class NullBuffer implements Buffer {
    constructor(public readonly label: string, public size: number, public readonly usage: BufferUsageFlags) {}
    public destroy(): void { /* nothing held */ }
}

class NullTexture implements Texture {
    public generation = 0;
    public mipLevelCount: number;
    public depthOrArrayLayers: number;
    public dimension: TextureDimension;

    constructor(
        public readonly label: string,
        public format: TextureFormat,
        public width: number,
        public height: number,
        public readonly usage: TextureUsageFlags,
        dimension: TextureDimension = '2d',
        depthOrArrayLayers: number = 1,
        mipLevelCount: number = 1,
    ) {
        this.dimension = dimension;
        this.depthOrArrayLayers = depthOrArrayLayers;
        this.mipLevelCount = mipLevelCount;
    }

    /** What the texture would occupy on a GPU; reported so memory stats stay meaningful. */
    public get byteSize(): number { return this.width * this.height * this.depthOrArrayLayers * 4; }

    public configure(_descriptor: TextureConfigureDescriptor): void { this.generation++; }
    public upload2D(_image: TexImageSource | null, width: number, height: number, _mipMap: boolean): void { this.setSize(width, height); }
    public uploadCube(_images: readonly TexImageSource[] | null, width: number, height: number, _mipMap: boolean): void {
        this.dimension = 'cube';
        this.setSize(width, height, 6);
    }
    public uploadFace(_face: number, _image: TexImageSource, _mipMap: boolean): void { this.generation++; }
    public uploadBytes(_data: Uint8Array, width: number, height: number, _wrapping: AddressMode): void { this.setSize(width, height); }
    public uploadRegion(_x: number, _y: number, _width: number, _height: number, _data: Uint8Array): void { this.generation++; }
    public allocateCube(size: number, levels: number): void { this.dimension = 'cube'; this.setSize(size, size, 6, levels); }
    public allocateVolume(width: number, height: number, depth: number, _wrapping: AddressMode): void {
        this.dimension = '3d';
        this.setSize(width, height, depth);
    }
    public allocateDepthArray(size: number, layers: number, _compare: boolean): void {
        this.dimension = '2d-array';
        this.setSize(size, size, layers);
    }
    public allocateArray(width: number, height: number, layers: number, levels: number): void {
        this.dimension = '2d-array';
        this.setSize(width, height, layers, levels);
    }
    public setCompareMode(_enabled: boolean): void { /* nothing to compare */ }
    public generateMipmaps(_encoder?: CommandEncoder): void { /* no mips to make */ }
    public setSize(width: number, height: number, depthOrArrayLayers: number = this.depthOrArrayLayers, mipLevelCount: number = this.mipLevelCount): void {
        this.width = width;
        this.height = height;
        this.depthOrArrayLayers = depthOrArrayLayers;
        this.mipLevelCount = mipLevelCount;
        this.generation++;
    }
    public destroy(): void { /* nothing held */ }
}

class NullTextureView implements TextureView {
    constructor(public readonly texture: Texture, public readonly baseMipLevel: number, public readonly baseArrayLayer: number) {}
    public get label(): string { return this.texture.label; }
    public get generation(): number { return this.texture.generation; }
    public destroy(): void { /* nothing held */ }
}

/** A program that takes every uniform and draws nothing. */
class NullShaderProgram implements ShaderProgram {
    public readonly attributes: AttributeInfo[] = [];
    public use(): void { /* nothing bound */ }
    public setUniform(_name: string, _value: unknown): void { /* nothing written */ }
    public hasUniform(_name: string): boolean { return false; }
    public flushUniformBlocks(): void { /* nothing to flush */ }
    public dispose(): void { /* nothing held */ }
}

const nullLayout = (group: number): BindGroupLayout => ({ label: 'null.layout', group, destroy() {} });

/**
 * A pass encoder that accepts every call. Built on a Proxy because recording has many methods and the null
 * device does the same nothing for each; `then` is left undefined so the object is never mistaken for a
 * promise.
 */
function nullRecorder<T extends object>(extra: Record<string, unknown> = {}): T {
    return new Proxy(extra, {
        get: (target, key) => {
            if (key in target) return (target as any)[key];
            if (typeof key === 'symbol' || key === 'then') return undefined;
            return () => undefined;
        },
    }) as T;
}

export class NullDevice implements Device {
    public readonly backend = CAPABILITIES.backend;
    public readonly capabilities = CAPABILITIES;
    public submissionEpoch = 0;
    private readonly _surfaceTexture = new NullTexture('null.surface', 'rgba8unorm', 1, 1, 0);

    public createBuffer(d: BufferDescriptor): Buffer { return new NullBuffer(d.label ?? 'null.buffer', d.size, d.usage); }

    public createTexture(d: TextureDescriptor): Texture {
        return new NullTexture(d.label ?? 'null.texture', d.format, d.width, d.height, d.usage, d.dimension, d.depthOrArrayLayers, d.mipLevelCount);
    }

    public createTextureView(texture: Texture, baseMipLevel: number = 0, baseArrayLayer: number = 0): TextureView {
        return new NullTextureView(texture, baseMipLevel, baseArrayLayer);
    }

    public createWholeTextureView(texture: Texture): TextureView { return new NullTextureView(texture, 0, 0); }

    public createSampler(descriptor: SamplerDescriptor): Sampler { return { label: 'null.sampler', descriptor, destroy() {} }; }

    public createShaderModule(d: ShaderModuleDescriptor): ShaderModule {
        return { label: d.label ?? 'null.module', stage: d.stage, compilationInfo: [], entryPoints: d.entryPoints ?? {}, resources: [], destroy() {} };
    }

    public createShaderProgram(_d: ShaderProgramDescriptor): ShaderProgram { return new NullShaderProgram(); }

    public createRenderPipeline(d: RenderPipelineDescriptor): RenderPipeline {
        return {
            label: d.label ?? 'null.pipeline', vertexLayouts: d.vertexLayouts, primitive: d.primitive, depthStencil: d.depthStencil,
            colorTargets: d.colorTargets, bindGroupLayouts: [], resources: [], layoutForGroup: nullLayout, destroy() {},
        };
    }

    public createComputePipeline(_d: ComputePipelineDescriptor): ComputePipeline {
        throw new Error('The null device has no compute (capabilities.hasCompute is false).');
    }

    public createRenderTarget(d: RenderTargetDescriptor): RenderTarget {
        const first = d.colorViews[0]?.texture ?? d.depthView?.texture;
        return { label: d.label ?? 'null.target', colorViews: d.colorViews, depthView: d.depthView, width: first?.width ?? 1, height: first?.height ?? 1, destroy() {} };
    }

    public createBindGroup(d: BindGroupDescriptor): BindGroup { return { label: d.label ?? 'null.bindGroup', layout: d.layout, destroy() {} }; }

    public getCurrentSurfaceTarget(): RenderTarget {
        const view = new NullTextureView(this._surfaceTexture, 0, 0);
        return { label: 'null.surface', colorViews: [view], width: 1, height: 1, destroy() {} };
    }

    public reconfigureSurface(): void { /* no surface */ }

    public writeBuffer(_buffer: Buffer, _offset: number, _data: ArrayBufferView): void { /* nothing kept */ }

    public reallocateBuffer(buffer: Buffer, data: ArrayBufferView): Buffer {
        if (buffer instanceof NullBuffer) buffer.size = Math.max(buffer.size, data.byteLength);
        return buffer;
    }

    public writeTexture(_texture: Texture, _data: ArrayBufferView, _width: number, _height: number, _mipLevel?: number, _arrayLayer?: number, _x?: number, _y?: number): void {
        /* nothing kept */
    }

    public createCommandEncoder(_label?: string): CommandEncoder {
        return {
            beginRenderPass: () => nullRecorder<RenderPassEncoder>(),
            beginComputePass: () => nullRecorder<ComputePassEncoder>(),
            copyTextureToTexture: () => {},
            finish: () => { this.submissionEpoch++; },
        };
    }

    public readPixels(_view: TextureView, _x: number, _y: number, width: number, height: number): Promise<Uint8Array> {
        return Promise.resolve(new Uint8Array(width * height * 4));
    }

    public readBuffer(_buffer: Buffer, _offset: number, size: number): Promise<ArrayBuffer> {
        return Promise.resolve(new ArrayBuffer(size));
    }

    public setTimestampCollection(_enabled: boolean, _sink: (label: string, ms: number) => void): void { /* no timestamps */ }
    public collectTimestamps(): void { /* no timestamps */ }
    public destroy(): void { /* nothing held */ }
}
