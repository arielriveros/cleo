// How far and how wide an agent sees, and how long it remembers: the tuning a controller keeps and round-trips
// whether or not the game has the AI feature that does the seeing (ai/perception.ts, on yuka).
import { clamp, finiteOr } from "../core/math";

export interface PerceptionTuning {
    /** Full cone width in DEGREES. 360 sees everything within range. */
    fieldOfView: number;
    /** How far the agent can see, in world units. */
    range: number;
    /**
     * Seconds a target stays remembered after it was last seen. This is what makes an agent walk to
     * where you were rather than forgetting you the instant you break line of sight.
     */
    memorySpan: number;
    /**
     * Seconds of continuous visibility before a target counts as NOTICED.
     *
     * Without it an agent reacts on the exact frame a pixel of you clears a doorway, which reads as
     * clairvoyance. Backed by Yuka's `timeBecameVisible`, which exists for this.
     */
    reactionTime: number;
}

export const PERCEPTION_DEFAULTS: PerceptionTuning = {
    fieldOfView: 120,
    range: 20,
    memorySpan: 5,
    reactionTime: 0.25,
};

/** Every field defaulted and clamped, so a partial or junk record passes. Mirrors `steeringTuning`. */
export function perceptionTuning(over?: Partial<PerceptionTuning> | null): PerceptionTuning {
    const o = (over ?? {}) as Partial<PerceptionTuning>;
    const d = PERCEPTION_DEFAULTS;
    return {
        fieldOfView: clamp(finiteOr(o.fieldOfView, d.fieldOfView), 0, 360),
        range: Math.max(0, finiteOr(o.range, d.range)),
        memorySpan: Math.max(0, finiteOr(o.memorySpan, d.memorySpan)),
        reactionTime: Math.max(0, finiteOr(o.reactionTime, d.reactionTime)),
    };
}

