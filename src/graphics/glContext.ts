/**
 * The WebGL2 context, in a module of its own.
 *
 * It used to be `export let gl` on renderer.ts, which meant every low-level GL wrapper that needed a
 * context — Mesh, Shader, Texture, Framebuffer, CubeFramebuffer — imported the entire 4,800-line renderer.
 * That single edge put the renderer, and therefore `scene.ts` and therefore every node class, into the
 * dependency graph of the smallest leaves in the engine. Splitting node.ts made the cost concrete: a base
 * class cannot finish evaluating before its own subclasses start, and `class X extends undefined` is the
 * error you get.
 *
 * Exported as a live binding, so consumers keep reading `gl` as a plain value and see the assignment the
 * moment the renderer makes it.
 */
export let gl: WebGL2RenderingContext;

/** Called once by the renderer when it acquires the context from its canvas. */
export function setGLContext(context: WebGL2RenderingContext): void { gl = context; }
