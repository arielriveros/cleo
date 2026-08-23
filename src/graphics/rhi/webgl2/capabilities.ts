import type { DeviceCapabilities } from '../device';

/**
 * Read the WebGL2 device's real limits back, once, at boot.
 *
 * Takes its context by injection rather than importing the `gl` live binding, for the same reason
 * gpuProfiler does: this runs while the context is being acquired, before anything has published it,
 * and a module-level import would be reading a binding that is still undefined.
 *
 * Everything here is queried rather than assumed — but the first thing the query established is that
 * the assumption was right. Measured on ANGLE/D3D11 (RTX 3060), `MAX_TEXTURE_IMAGE_UNITS` is exactly
 * 16: the ES 3.00 guaranteed minimum, not a floor the driver comfortably exceeds. So renderer.ts's
 * former `SHADOW_UNIT = 6` / `SPOT_SHADOW_UNIT = 15` were not over-cautious — the deferred pass
 * really did sit one unit from the ceiling on mainstream desktop hardware, and custom materials
 * really did have nowhere to put a sampler past 15. That budget does not loosen on WebGL2 anywhere;
 * what removed the constants was moving unit assignment into the bind groups, which pack each pass
 * from 0 instead of reserving numbers across the whole frame.
 *
 * Other measurements from the same device, for scale: maxTextureSize 16384, arrayLayers 2048,
 * colorAttachments 8, EXT_color_buffer_float and OES_texture_float_linear both present.
 */
export function detectWebGL2Capabilities(gl: WebGL2RenderingContext): DeviceCapabilities {
    // Both are optional on real hardware and they fail independently — a device can render to a float
    // target while refusing to sample it with anything but NEAREST. texture.ts already requires BOTH
    // before it will allocate an RGBA16F target, so a device with only the first silently gets the
    // 8-bit fallback and an LDR pipeline. Reported separately so that stops being invisible.
    const floatRenderable = gl.getExtension('EXT_color_buffer_float') !== null;
    const floatFilterable = gl.getExtension('OES_texture_float_linear') !== null;

    const anisotropic = gl.getExtension('EXT_texture_filter_anisotropic');
    const maxAnisotropy = anisotropic
        ? gl.getParameter(anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number
        : 1;

    return {
        backend: 'webgl2',

        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
        maxTextureArrayLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number,
        max3DTextureSize: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number,

        maxColorAttachments: gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) as number,
        // The fragment-stage texture units. This is the number the deferred lighting pass is measured
        // against, not the combined vertex+fragment total, which is always larger and would flatter it.
        maxSamplersPerStage: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number,
        maxVertexAttributes: gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number,
        maxUniformBufferBindingSize: gl.getParameter(gl.MAX_UNIFORM_BLOCK_SIZE) as number,

        floatRenderable,
        floatFilterable,

        // Not "not yet" — WebGL2 has no compute stage and no storage buffers at all. Anything gated on
        // these is a WebGPU-only path by construction.
        hasCompute: false,
        hasStorageBuffers: false,
        hasTimestampQuery: gl.getExtension('EXT_disjoint_timer_query_webgl2') !== null,

        maxAnisotropy,
        // WebGL2 always presents through the canvas's own RGBA8 drawing buffer; there is no swap-chain
        // format to negotiate the way WebGPU's `getPreferredCanvasFormat()` does.
        preferredCanvasFormat: 'rgba8unorm',

        adapterInfo: readAdapterInfo(gl),
    };
}

/**
 * Best-effort GPU identification.
 *
 * `WEBGL_debug_renderer_info` is a fingerprinting vector, so browsers increasingly withhold it — Firefox
 * gates it behind a pref and Chrome returns masked strings in some configurations. Absent adapter info
 * is therefore the expected case, not an error, and nothing may depend on these strings being present.
 * They exist only to make a bug report from a user's machine legible.
 */
function readAdapterInfo(gl: WebGL2RenderingContext): DeviceCapabilities['adapterInfo'] {
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (!debugInfo) return undefined;

    const vendor = String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) ?? '');
    const device = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? '');
    if (!vendor && !device) return undefined;

    return {
        vendor,
        architecture: '',
        device,
        description: [vendor, device].filter(Boolean).join(' — '),
    };
}
