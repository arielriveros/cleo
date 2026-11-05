import { setGLContext } from './glContext';
import { GLState } from './glState';
import { WebGL2Device } from './webgl2Device';

/** What the WebGL2 device needs from the host at creation. */
export interface WebGL2DeviceOptions {
    /** The colour the canvas shows until the first frame lands. */
    clearColor?: readonly number[];
}

/**
 * Open the canvas's WebGL2 context and build the device over it — the WebGL2 half of
 * `rhi/createDevice.ts`. A canvas hosts one context type, so this is the only place `getContext` runs.
 *
 * The context's standing state is set here, once, and nowhere above the backend: a WebGL2 pipeline sets
 * depth, cull, blend and colour mask on every `setPipeline`, and clears name their own value, so these
 * defaults only describe the context before the first pass. The canvas is cleared to the host's colour
 * so it does not flash before that pass.
 */
export function createWebGL2Device(canvas: HTMLCanvasElement | OffscreenCanvas,
                                   options: WebGL2DeviceOptions = {}): WebGL2Device {
    const context = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
    if (!context) throw new Error('WebGL context not available');
    setGLContext(context);

    // The device reads the hardware's real limits once, before anything can depend on a guess.
    const device = new WebGL2Device(context);

    const c = options.clearColor ?? [0, 0, 0, 1];
    context.clearColor(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 1);
    context.clear(context.COLOR_BUFFER_BIT);
    GLState.depthTest(true);
    GLState.blend(true);
    GLState.depthFunc(context.LEQUAL);
    // Separate factors, never `blendFunc`: the scene buffer's alpha is the bloom-eligibility mask.
    GLState.blendFuncSeparate(context.SRC_ALPHA, context.ONE_MINUS_SRC_ALPHA, context.ZERO, context.ONE);
    context.drawingBufferColorSpace = 'srgb';
    return device;
}
