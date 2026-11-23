/**
 * `Input.mouse`: the mouse as a script sees it when a game wants the CURSOR rather than an action —
 * point-and-click, click-to-move, drag-to-aim, a strategy or 2D game. Position, button edges, wheel,
 * what is under the cursor and where it lands in the world.
 *
 * Independent of the action map: nothing here is bound, rebindable or gated by a map. For a verb the
 * player may rebind (`Fire`, `Look`) keep using `Input.pressed(...)`.
 *
 * Positions are in CANVAS CSS pixels, Y down, the space `Raycaster.screenToRay` consumes. While the
 * pointer is captured there is no cursor: `x`/`y` hold the last position it had, and `deltaX`/`deltaY`
 * are the reading to use.
 */

import { vec3 } from "gl-matrix";
import { InputSystem } from "./inputSystem";
import type { MouseButton } from "./inputSources";
import { Raycaster } from "../core/raycaster";
import type { Ray, RaycastHit } from "../core/raycaster";
import { CleoEngine } from "../core/engine";
import { isUINodeType } from "../core/scene/nodes/nodeType";
import type { Node } from "../core/scene/nodes/node";
import type { PhysicsRaycastHit, PhysicsRaycastOptions } from "../physics/physicsSystem";

export interface MousePickOptions {
    /** Ignore hits farther than this. Default: no limit. */
    maxDistance?: number;
    /** Skip nodes this returns false for. Runs before the ray test, so it is also the cheap way to narrow. */
    filter?: (node: Node) => boolean;
    /** False picks by bounding box only (faster, coarser). Default true: triangles where the node has a BVH. */
    precise?: boolean;
}

export interface MousePhysicsPickOptions extends PhysicsRaycastOptions {
    /** How far along the ray to look, world units. Default 1000. */
    maxDistance?: number;
}

const BUTTON_DEFAULT: MouseButton = 'left';

function snapshot() { return InputSystem.instance.deviceSnapshot; }

function canvasSize(): { w: number; h: number } | null {
    const canvas = InputSystem.instance.canvas;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? { w: rect.width, h: rect.height } : null;
}

/** The world ray under the cursor for the scene's active camera, or null with no camera or canvas. */
function cursorRay(): Ray | null {
    const size = canvasSize();
    const camera = CleoEngine.instance?.scene?.activeCamera?.camera;
    if (!size || !camera) return null;
    const p = snapshot().pointer;
    return Raycaster.screenToRay(p.px, p.py, size.w, size.h, camera);
}

/** Where the cursor ray crosses the plane through `through` with normal `normal`, or null (parallel / behind). */
function planeHit(ray: Ray, normal: vec3, through: vec3): vec3 | null {
    const denom = vec3.dot(normal, ray.direction);
    if (Math.abs(denom) < 1e-8) return null;
    const diff = vec3.sub(vec3.create(), through, ray.origin);
    const t = vec3.dot(diff, normal) / denom;
    if (t < 0) return null;
    return vec3.scaleAndAdd(vec3.create(), ray.origin, ray.direction, t);
}

function hiddenByAncestor(node: Node): boolean {
    for (let n: Node | null = node; n; n = n.parent as Node | null) if (!n.visible) return true;
    return false;
}

export const mouse = {
    // ----- Cursor -----------------------------------------------------------------------------

    /** Cursor position in canvas CSS pixels, Y down. */
    get x(): number { return snapshot().pointer.px; },
    get y(): number { return snapshot().pointer.py; },
    get position(): [number, number] { const p = snapshot().pointer; return [p.px, p.py]; },
    /** The same position normalized to the canvas, 0..1, Y down. */
    get nx(): number { return snapshot().pointer.x; },
    get ny(): number { return snapshot().pointer.y; },

    /** Movement this frame in pixels. The only motion there is while the mouse is captured. */
    get deltaX(): number { return snapshot().pointer.deltaX; },
    get deltaY(): number { return snapshot().pointer.deltaY; },
    /** Scroll this frame (positive Y is scrolling down, as the browser reports it). */
    get wheelX(): number { return snapshot().pointer.wheelX; },
    get wheelY(): number { return snapshot().pointer.wheelY; },

    /** The cursor is over the game canvas. */
    get overCanvas(): boolean { return snapshot().pointerOverCanvas; },

    /**
     * The cursor is over an interactive Game UI node (a button, slider, toggle or text input, or any UI node
     * marked interactive). A click-to-move game checks this so pressing a button does not also move the player.
     */
    get overUI(): boolean {
        const scene = CleoEngine.instance?.scene;
        if (!scene) return false;
        const { px, py } = snapshot().pointer;
        for (const node of scene.nodes) {
            if (!isUINodeType(node.nodeType)) continue;
            const ui = node as unknown as { interactive?: boolean; screenRect?: { x: number; y: number; width: number; height: number } };
            const r = ui.screenRect;
            if (!ui.interactive || !r) continue;
            if (px < r.x || py < r.y || px > r.x + r.width || py > r.y + r.height) continue;
            if (!hiddenByAncestor(node)) return true;
        }
        return false;
    },

    // ----- Buttons ----------------------------------------------------------------------------

    /** The button is held. */
    down(button: MouseButton = BUTTON_DEFAULT): boolean { return snapshot().mouseButtons.has(button); },
    /** True on exactly the frame the button went down — and a press and release inside one frame still reports. */
    pressed(button: MouseButton = BUTTON_DEFAULT): boolean { return snapshot().mousePressed.has(button); },
    /** True on exactly the frame the button came up (including by the window losing focus). */
    released(button: MouseButton = BUTTON_DEFAULT): boolean { return snapshot().mouseReleased.has(button); },
    /** Seconds the button has been held, or 0. */
    heldSeconds(button: MouseButton = BUTTON_DEFAULT): number { return InputSystem.instance.mouseHeldSeconds(button); },

    // ----- Cursor appearance and capture -------------------------------------------------------

    /**
     * Set the CSS cursor over the game: `'pointer'`, `'crosshair'`, `'grab'`, `'none'`, ... or `''` for the
     * default. Stays until set again; the engine clears it when the game ends.
     */
    setCursor(css: string): void { InputSystem.instance.setCursor(css); },
    get cursor(): string { return InputSystem.instance.cursor; },
    /** Hide the cursor over the game while it keeps reporting a position (a custom-drawn cursor). */
    hide(): void { InputSystem.instance.setCursor('none'); },
    /** Show the default cursor again. */
    show(): void { InputSystem.instance.setCursor(''); },

    /** Capture the mouse (pointer lock). Needs a user gesture, like `Input.captureMouse`. */
    capture(): void { InputSystem.instance.requestPointerLock(); },
    release(): void { InputSystem.instance.releasePointerLock(); },
    get locked(): boolean { return InputSystem.instance.isPointerLocked; },

    // ----- In the world -----------------------------------------------------------------------

    /** The world-space ray from the active camera through the cursor, or null with no camera. */
    ray(): Ray | null { return cursorRay(); },

    /**
     * The nearest renderable node under the cursor — the same picking the editor uses (bounding box, then
     * triangles where the node has a BVH). UI, terrain and tilemaps are not hit this way; use
     * {@link pickPhysics} or {@link groundPoint} for terrain.
     */
    pick(options: MousePickOptions = {}): RaycastHit | null {
        const ray = cursorRay();
        const scene = CleoEngine.instance?.scene;
        if (!ray || !scene) return null;
        const filter = options.filter;
        const nodes = filter ? [...scene.nodes].filter(filter) : [...scene.nodes];
        return Raycaster.raycast(ray, nodes, options.maxDistance ?? Infinity, options.precise ?? true)[0] ?? null;
    },

    /**
     * The first collider under the cursor, with `point` and `normal` — terrain and landscapes included.
     * Takes the same options as `scene.physics.raycast` (`layerMask`, `ignore`, `includeTriggers`, ...).
     */
    pickPhysics(options: MousePhysicsPickOptions = {}): PhysicsRaycastHit | null {
        const ray = cursorRay();
        const physics = CleoEngine.instance?.scene?.physics;
        if (!ray || !physics) return null;
        const { maxDistance = 1000, ...rest } = options;
        const to = vec3.scaleAndAdd(vec3.create(), ray.origin, ray.direction, maxDistance);
        return physics.raycast(ray.origin, to, rest);
    },

    /**
     * Where the cursor ray meets the horizontal plane at height `y` (default 0). The click-to-move point on
     * flat ground; null when the ray is parallel to the plane or points away from it.
     */
    groundPoint(y: number = 0): vec3 | null {
        const ray = cursorRay();
        return ray ? planeHit(ray, [0, 1, 0], [0, y, 0]) : null;
    },

    /**
     * The cursor in a 2D game's world: where the ray meets the z = 0 plane the 2D nodes live on, as `[x, y]`
     * in world units (Y up). Works for the orthographic 2D camera at any zoom or position.
     */
    worldPoint2D(): [number, number] | null {
        const ray = cursorRay();
        const hit = ray ? planeHit(ray, [0, 0, 1], [0, 0, 0]) : null;
        return hit ? [hit[0], hit[1]] : null;
    },
} as const;

export type MouseApi = typeof mouse;
