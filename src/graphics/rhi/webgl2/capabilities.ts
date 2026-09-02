import type { DeviceCapabilities } from '../device';

// Read the WebGL2 device's real limits back, once, at boot. Takes its context by injection: this runs
// while the context is being acquired, before the `gl` live binding is published.

/**
 * The GPU timer-query extension object, or null when the driver withholds it. The single place that
 * asks, so `hasTimestampQuery` and the profiler cannot disagree about whether timing is possible.
 */
export function timerQueryExtension(gl: WebGL2RenderingContext): any {
    return gl.getExtension('EXT_disjoint_timer_query_webgl2');
}

/**
 * The anisotropic-filtering extension object, or null when the driver withholds it.
 *
 * Separate from the `maxAnisotropy` capability below because the PNAME lives on the object, not in the
 * core enum table: a texture that wants to raise anisotropy needs `ext.TEXTURE_MAX_ANISOTROPY_EXT` to
 * name the parameter, and the limit alone cannot supply it.
 */
export function anisotropyExtension(gl: WebGL2RenderingContext): any {
    return gl.getExtension('EXT_texture_filter_anisotropic');
}

export function detectWebGL2Capabilities(gl: WebGL2RenderingContext): DeviceCapabilities {
    // Optional and independent: a device can render to a float target while refusing to filter it.
    // Reported separately because texture.ts requires both before allocating RGBA16F.
    const floatRenderable = gl.getExtension('EXT_color_buffer_float') !== null;
    const floatFilterable = gl.getExtension('OES_texture_float_linear') !== null;

    const anisotropic = anisotropyExtension(gl);
    const maxAnisotropy = anisotropic
        ? gl.getParameter(anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number
        : 1;

    return {
        backend: 'webgl2',

        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
        maxTextureArrayLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number,
        max3DTextureSize: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number,

        maxColorAttachments: gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) as number,
        // Fragment-stage units, not the combined vertex+fragment total, which would flatter the budget.
        maxSamplersPerStage: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number,
        maxVertexAttributes: gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number,
        maxUniformBufferBindingSize: gl.getParameter(gl.MAX_UNIFORM_BLOCK_SIZE) as number,

        floatRenderable,
        floatFilterable,

        // Not "not yet": WebGL2 has no compute stage and no storage buffers at all.
        hasCompute: false,
        hasStorageBuffers: false,
        hasTimestampQuery: timerQueryExtension(gl) !== null,

        maxAnisotropy,
        // WebGL2 always presents through the canvas's own RGBA8 buffer; no format to negotiate.
        preferredCanvasFormat: 'rgba8unorm',

        adapterInfo: readAdapterInfo(gl),
    };
}

// Best-effort GPU identification. `WEBGL_debug_renderer_info` is a fingerprinting vector that browsers
// withhold, so absence is the expected case and nothing may depend on these strings.
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
