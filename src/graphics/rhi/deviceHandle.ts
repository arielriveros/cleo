import type { Device } from './device';

/**
 * The live device, as a live binding. Typed as the INTERFACE, never as a backend class, so the compiler
 * catches a backend-specific member at its call site. Types-only imports, so it can never form a cycle.
 */
export let device: Device;

/** Called once by the renderer, immediately after it acquires a context. */
export function setDevice(next: Device): void { device = next; }
