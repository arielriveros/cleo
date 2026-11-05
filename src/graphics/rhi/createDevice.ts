import { Logger } from '../../core/logger';
import type { BackendKind, Device } from './device';
import { resolveBackendRequest } from './backendSelect';
import { acquireWebGPUDevice } from './webgpu/webgpuDevice';
import { createWebGL2Device } from './webgl2/createWebGL2Device';

export interface CreateDeviceOptions {
    /** The colour the canvas shows until the first frame (WebGL2 clears to it at creation). */
    clearColor?: readonly number[];
    /**
     * Told why the requested backend was not used, BEFORE the fallback is attempted — so the reason is
     * known even when the fallback then fails too.
     */
    onFallback?: (reason: string) => void;
}

/**
 * The device for the requested backend, falling back to WebGL2 with a stated reason. The one module
 * above the backend folders that names both: everything else holds the `Device` interface
 * (rhi/deviceHandle.ts) and never learns which it got.
 */
export async function createDevice(canvas: HTMLCanvasElement, requested: BackendKind | undefined,
                                   options: CreateDeviceOptions = {}): Promise<Device> {
    let reason = resolveBackendRequest(requested);
    if (reason) {
        Logger.warn(`Falling back to WebGL2: ${reason}`, 'Runtime');
    } else if (requested === 'webgpu') {
        const gpu = await acquireWebGPUDevice({ canvas, powerPreference: 'high-performance' });
        if (gpu) return gpu;
        // Null covers every ordinary "this machine cannot" outcome, each already logged with its
        // cause. Falling through to WebGL2 is the answer to all of them, not an error.
        reason = 'WebGPU device acquisition failed — see the log above';
    }
    if (reason) options.onFallback?.(reason);
    return createWebGL2Device(canvas, { clearColor: options.clearColor });
}
