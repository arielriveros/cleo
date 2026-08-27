/** The WebGL2 context, as a live binding. Assigned once by the renderer at boot. */
export let gl: WebGL2RenderingContext;

/** Called once by the renderer when it acquires the context from its canvas. */
export function setGLContext(context: WebGL2RenderingContext): void { gl = context; }
