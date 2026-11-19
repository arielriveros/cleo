import { mat4, quat, vec3 } from 'gl-matrix';
import type { Animation, Skin } from './animatedModel';
import { humanoidSlotOf } from './boneNames';
import { sampleQuat, sampleVec3 } from './samplerSample';

// Foot-lock windows: per foot, the spans of a clip's time in which that foot is planted and foot locking may hold
// it (`Animation.footLocks`, Advanced Locomotion System's FootLock_L / FootLock_R curves as ranges). Where a clip
// has them they decide when a foot plants and when it lets go; a clip without them leaves the Animator to detect a
// planted foot by itself. Pure: clip and skin in, spans out; no GL, no scene.

/** Spans of clip time, seconds on the clip as it plays (after its edits), per foot key. */
export type FootLockWindows = Record<string, [number, number][]>;

/**
 * The key a foot's windows are stored under: its humanoid slot (`foot.L`, `foot.R`), so they survive a retarget
 * onto another humanoid skeleton and a mirror only swaps the side; the bone's own name on a rig that is not
 * recognizably humanoid.
 */
export function footLockKey(boneName: string): string {
    return humanoidSlotOf(boneName) ?? boneName;
}

/** 1 when `time` is inside one of the foot's spans, 0 otherwise. Null when the clip has no entry for that foot. */
export function footLockAt(clip: Pick<Animation, 'footLocks'>, key: string, time: number): number | null {
    const spans = clip.footLocks?.[key];
    if (!spans) return null;
    for (const [a, b] of spans) if (time >= a && time <= b) return 1;
    return 0;
}

/** Spans sorted, clamped to `[0, duration]`, overlapping ones merged and empty ones dropped. */
export function normalizeFootLockSpans(spans: [number, number][], duration: number): [number, number][] {
    const out: [number, number][] = [];
    const sorted = spans
        .map(([a, b]) => [Math.max(0, Math.min(a, b)), Math.min(duration, Math.max(a, b))] as [number, number])
        .filter(([a, b]) => b - a > 1e-4)
        .sort((x, y) => x[0] - y[0]);
    for (const s of sorted) {
        const last = out[out.length - 1];
        if (last && s[0] <= last[1] + 1e-4) last[1] = Math.max(last[1], s[1]);
        else out.push([s[0], s[1]]);
    }
    return out;
}

/**
 * Every span cut down to its centred `keep` share (0..1): a shorter lock for a clip whose feet should follow the
 * animation more (a backward diagonal, whose crossing steps fight a long hold). Spans that end up under 0.06 s go.
 */
export function shrinkFootLockSpans(windows: FootLockWindows, keep: number): FootLockWindows {
    const share = Math.max(0, Math.min(1, keep));
    const out: FootLockWindows = {};
    for (const [key, spans] of Object.entries(windows)) {
        out[key] = spans
            .map(([a, b]) => { const cut = (b - a) * (1 - share) / 2; return [a + cut, b - cut] as [number, number]; })
            .filter(([a, b]) => b - a >= MIN_SPAN);
    }
    return out;
}

export interface FootLockDetectOptions {
    /** How far the heel (the ankle joint) may rise above its lowest in the clip before the span ends. Metres. */
    heelLift?: number;
    /** How close to its lowest the ball of the foot (the toe joint) must be for the foot to count as down. */
    contact?: number;
    /** Samples per second. */
    fps?: number;
    /** The feet, as foot (ankle) and toe node indices. Default: the skeleton's humanoid feet and toes. */
    feet?: { foot: number; toe?: number }[];
    /**
     * What "down" is measured against. `'clip'` (the default): the foot's lowest in the whole clip, which is the
     * floor of a clip played on the flat. `'stance'`: each stance's own height, for a clip whose feet plant at
     * different heights (a stair climb with its rise kept: the upper foot stands a riser above the lower one).
     * A stance is a stretch of at least 0.1 s over which the ball of the foot holds its height (moves up or down
     * slower than 0.15 m/s); the frames round it within `contact` of that height are down too.
     */
    ground?: 'clip' | 'stance';
}

/** `ground: 'stance'`: how slowly the ball must move up or down to be standing (m/s), and for how long (s). */
const STANCE_STILL_SPEED = 0.15, STANCE_MIN = 0.1;

/**
 * Per frame, whether the ball of the foot is down on a stance of its own (`ground: 'stance'`): inside or next to
 * a stretch over which it holds its height, and within `contact` of that height.
 */
function stanceDown(ball: number[], times: number[], contact: number): boolean[] {
    const n = ball.length - 1;
    const down = new Array<boolean>(ball.length).fill(false);
    const still = ball.map((_, k) => {
        const a = Math.max(0, k - 1), b = Math.min(n, k + 1);
        const dt = times[b] - times[a];
        return dt > 0 && Math.abs(ball[b] - ball[a]) / dt < STANCE_STILL_SPEED;
    });
    for (let k = 0; k <= n;) {
        if (!still[k]) { k++; continue; }
        let end = k;
        while (end < n && still[end + 1]) end++;
        if (times[end] - times[k] >= STANCE_MIN) {
            let ground = Infinity;
            for (let j = k; j <= end; j++) ground = Math.min(ground, ball[j]);
            // The landing onto it and the push off it, as far as the ball stays that close to its height (above it
            // or below: a foot stepping on down past its tread has left it).
            const near = (j: number) => Math.abs(ball[j] - ground) <= contact;
            let from = k, to = end;
            while (from > 0 && near(from - 1)) from--;
            while (to < n && near(to + 1)) to++;
            for (let j = from; j <= to; j++) if (near(j)) down[j] = true;
        }
        k = end + 1;
    }
    return down;
}

/** Seconds: the shortest stance detection keeps. */
const MIN_SPAN = 0.06;

/** The humanoid feet of a skeleton, by slot: `[{ foot, toe }]`, left then right. */
export function humanoidFeet(skin: Skin): { foot: number; toe?: number }[] {
    const bySlot = new Map<string, number>();
    for (const [node, name] of skin.nodeNames ?? []) {
        const slot = humanoidSlotOf(name);
        if (slot && !bySlot.has(slot)) bySlot.set(slot, node);
    }
    const out: { foot: number; toe?: number }[] = [];
    for (const side of ['L', 'R']) {
        const foot = bySlot.get(`foot.${side}`);
        if (foot !== undefined) out.push({ foot, toe: bySlot.get(`toe.${side}`) });
    }
    return out;
}

/**
 * Find each foot's planted spans in a clip, posed on its skin (model space, +Y up).
 *
 * A span starts on the frame the ball of the foot (the toe joint; the ankle without one) comes down, within
 * `contact` of its lowest in the clip, and ends on the frame the HEEL has risen `heelLift` above its lowest in that
 * stance, or the ball lifts, whichever comes first: the lock holds the foot while it bears weight and lets the
 * push-off follow the animation.
 * Spans shorter than 0.06 s (a foot brushing the ground mid-swing) are dropped. A foot that never comes down gets an
 * empty list (never locks).
 */
export function detectFootLockWindows(clip: Animation, skin: Skin, options: FootLockDetectOptions = {}): FootLockWindows {
    const heelLift = options.heelLift ?? 0.03;
    const contact = options.contact ?? 0.025;
    const fps = options.fps ?? 60;
    const feet = options.feet ?? humanoidFeet(skin);
    const out: FootLockWindows = {};
    if (!feet.length) return out;

    let duration = 0;
    for (const s of clip.samplers) duration = Math.max(duration, s.input[s.input.length - 1] ?? 0);
    const n = Math.max(2, Math.round(duration * fps));
    const pose = poser(clip, skin);
    const heights = feet.map(() => ({ heel: [] as number[], ball: [] as number[] }));
    const times: number[] = [];
    for (let k = 0; k <= n; k++) {
        const t = duration * k / n;
        const at = pose(t);
        times.push(t);
        feet.forEach((f, i) => {
            heights[i].heel.push(at(f.foot)[1]);
            heights[i].ball.push(at(f.toe ?? f.foot)[1]);
        });
    }

    feet.forEach((f, i) => {
        const { heel, ball } = heights[i];
        // The ground: low in the clip, but not its single lowest frame, which one dip through the floor would set.
        // Or each stance's own (`ground: 'stance'`).
        const sorted = [...ball].sort((x, y) => x - y);
        const ballLow = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.05))];
        const onStance = options.ground === 'stance' ? stanceDown(ball, times, contact) : null;
        const spans: [number, number][] = [];
        let from = -1, heelRef = Infinity, spent = false, spentHeel = Infinity;
        const close = (k: number) => {
            // A touch shorter than this is a foot brushing the ground mid-swing, not a step.
            if (from >= 0 && times[k] - times[from] >= MIN_SPAN) spans.push([times[from], times[k]]);
            from = -1;
        };
        for (let k = 0; k <= n; k++) {
            const ballDown = onStance ? onStance[k] : ball[k] <= ballLow + contact;
            if (from < 0) {
                // After a heel-off the next span waits for the foot to come down again: the ball leaving the ground
                // and landing, or the heel settling back (a stop's shuffle onto a flat foot).
                if (!ballDown || heel[k] <= spentHeel + heelLift * 0.5) spent = false;
                if (ballDown && !spent) { from = k; heelRef = heel[k]; }
                continue;
            }
            // The heel measured against where it is in THIS stance, not its lowest in the clip: a foot that
            // lands on its ball (a sprint, a strafe's push-off) never brings its heel down to that.
            heelRef = Math.min(heelRef, heel[k]);
            if (!ballDown) close(k - 1);
            else if (heel[k] > heelRef + heelLift) { close(k - 1); spent = true; spentHeel = heelRef; }
        }
        if (from >= 0) close(n);
        const name = skin.nodeNames?.get(f.foot) ?? String(f.foot);
        out[footLockKey(name)] = spans;
    });
    return out;
}

/** `(time) => (node) => model-space position`, the clip posed over the skin's rest. */
function poser(clip: Animation, skin: Skin): (time: number) => (node: number) => vec3 {
    const tracks = new Map<number, { t?: number; r?: number; s?: number }>();
    clip.channels.forEach((c) => {
        const e = tracks.get(c.targetNodeIndex) ?? {};
        if (c.targetPath === 'translation') e.t = c.samplerIndex;
        else if (c.targetPath === 'rotation') e.r = c.samplerIndex;
        else if (c.targetPath === 'scale') e.s = c.samplerIndex;
        tracks.set(c.targetNodeIndex, e);
    });
    const parents = skin.nodeParents ?? new Map<number, number>();
    const rest = skin.nodeTransforms ?? new Map<number, mat4>();
    return (time: number) => {
        const cache = new Map<number, mat4>();
        const local = (node: number): mat4 => {
            const m = rest.get(node) ?? mat4.create();
            const tr = tracks.get(node);
            if (!tr) return m;
            const T = mat4.getTranslation(vec3.create(), m), S = mat4.getScaling(vec3.create(), m);
            const R = mat4.getRotation(quat.create(), m);
            if (tr.t !== undefined) sampleVec3(clip.samplers[tr.t], time, T);
            if (tr.r !== undefined) sampleQuat(clip.samplers[tr.r], time, R);
            if (tr.s !== undefined) sampleVec3(clip.samplers[tr.s], time, S);
            return mat4.fromRotationTranslationScale(mat4.create(), quat.normalize(R, R), T, S);
        };
        const world = (node: number, depth = 0): mat4 => {
            const hit = cache.get(node);
            if (hit) return hit;
            const p = parents.get(node);
            const m = p === undefined || p === node || depth > 256 ? local(node) : mat4.multiply(mat4.create(), world(p, depth + 1), local(node));
            cache.set(node, m);
            return m;
        };
        return (node: number) => mat4.getTranslation(vec3.create(), world(node));
    };
}
