import type { vec3 } from 'gl-matrix';
import type { Animation, Skin } from './animatedModel';
import { clipPoser } from './footLockWindows';

// Where a get-up clip starts to rise: the first moment any joint has moved from where the clip's first frame has
// it, a frame before that. A motion-capture get-up often lies still for a second or more before the body moves;
// played from its first frame, the character lies there as though nothing were happening. Joined at its rise
// start, it gets up as soon as the reaction hands it over. Pure: clip and skin in, seconds out; cached per pair.

/** How far a joint must move to count as moving: this share of the body's size in the clip's first frame (~3 cm). */
const MOVED_SHARE = 0.017;
/** Samples per second it is measured at. */
const FPS = 30;

const CACHE = new WeakMap<Animation, WeakMap<Skin, number>>();

/**
 * Seconds into `clip` where its body starts to move (0 when it moves from the start, or the clip does not move
 * the skin's joints at all), measured on `skin` (the skeleton it plays on).
 */
export function clipRiseStart(clip: Animation, skin: Skin): number {
    let bySkin = CACHE.get(clip);
    const hit = bySkin?.get(skin);
    if (hit !== undefined) return hit;
    const value = measure(clip, skin);
    if (!bySkin) { bySkin = new WeakMap(); CACHE.set(clip, bySkin); }
    bySkin.set(skin, value);
    return value;
}

function measure(clip: Animation, skin: Skin): number {
    let duration = 0;
    for (const s of clip.samplers) duration = Math.max(duration, s.input[s.input.length - 1] ?? 0);
    const joints = skin.joints.map(j => j.nodeIndex);
    if (!(duration > 0) || !joints.length) return 0;
    const pose = clipPoser(clip, skin);
    const first = pose(0);
    const at0: vec3[] = joints.map(j => first(j));
    // The body's size in that frame: the diagonal of the box round its joints.
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of at0) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    const size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    if (!(size > 1e-6)) return 0;
    const moved = size * MOVED_SHARE;
    const n = Math.max(1, Math.ceil(duration * FPS));
    for (let k = 1; k <= n; k++) {
        const t = Math.min(duration, k / FPS);
        const now = pose(t);
        for (let j = 0; j < joints.length; j++) {
            const a = at0[j], b = now(joints[j]);
            if (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) > moved) return Math.max(0, (k - 1) / FPS - 1 / FPS);
        }
    }
    return 0;
}
