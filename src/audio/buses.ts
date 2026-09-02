import { Howler } from "howler";
import { BUS_IDS } from "./soundSettings";
import type { BusId } from "./soundSettings";

/**
 * The fixed mixer: four buses a sample can route into, each a gain stage in front of howler's master.
 *
 *     [sample rack] -> busGain -> Howler.masterGain -> destination
 *
 * Fixed rather than user-defined on purpose. Four names cover what a game actually automates — duck the
 * music under dialogue, mute SFX in the options menu, keep UI clicks audible when everything else is
 * down — and they can be referenced from a script as string literals with no asset to look up.
 *
 * `master` is not a gain node of its own: it IS `Howler.volume()`, which sits downstream of every bus
 * anyway. Adding a fifth node in front of howler's own master would just be a second place to look when
 * something is inaudible.
 *
 * Bus state is PROJECT-level, not per-sample. A `SoundSampleAsset` only names the bus it routes into.
 */

type BusState = { gain: number; muted: boolean };

export class Mixer {
    private readonly _state = new Map<BusId, BusState>();
    /** Created lazily: touching `Howler.ctx` before a user gesture is what leaves a suspended context. */
    private readonly _nodes = new Map<BusId, GainNode>();

    constructor() {
        for (const bus of BUS_IDS) this._state.set(bus, { gain: 1, muted: false });
    }

    public gain(bus: BusId): number { return this._state.get(bus)?.gain ?? 1; }
    public muted(bus: BusId): boolean { return this._state.get(bus)?.muted ?? false; }

    public setGain(bus: BusId, value: number): void {
        const state = this._state.get(bus);
        if (!state) return;
        state.gain = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1));
        this._push(bus);
    }

    public setMuted(bus: BusId, muted: boolean): void {
        const state = this._state.get(bus);
        if (!state) return;
        state.muted = muted;
        this._push(bus);
    }

    /**
     * The node a sample on this bus should connect its rack output to.
     *
     * Returns null when there is no Web Audio context — howler falls back to HTML5 audio on a device
     * with no Web Audio, and there is nothing to route through. Callers treat that as "connect to
     * nothing extra"; the sound still plays, it just cannot be bussed or processed.
     */
    public nodeFor(bus: BusId): GainNode | null {
        if (bus === 'master') return null;

        const existing = this._nodes.get(bus);
        if (existing) return existing;

        const ctx = Howler.ctx as AudioContext | undefined;
        const master = Howler.masterGain as GainNode | undefined;
        if (!ctx || !master) return null;

        const node = ctx.createGain();
        node.connect(master);
        this._nodes.set(bus, node);
        this._push(bus);
        return node;
    }

    /** Master volume, 0..1 — howler's own, which every bus already feeds into. */
    public get masterVolume(): number { return Howler.volume(); }
    public set masterVolume(value: number) { Howler.volume(Math.min(1, Math.max(0, value))); }

    /** Serializable mixer state, for project prefs. */
    public serialize(): Record<string, BusState> {
        const out: Record<string, BusState> = {};
        for (const [bus, state] of this._state) out[bus] = { gain: state.gain, muted: state.muted };
        return out;
    }

    public parse(raw: unknown): void {
        if (!raw || typeof raw !== 'object') return;
        const r = raw as Record<string, Partial<BusState>>;
        for (const bus of BUS_IDS) {
            const entry = r[bus];
            if (!entry) continue;
            if (typeof entry.gain === 'number') this.setGain(bus, entry.gain);
            if (typeof entry.muted === 'boolean') this.setMuted(bus, entry.muted);
        }
    }

    /** Push a bus's state onto its live node, if one exists yet. `master` goes to howler's volume. */
    private _push(bus: BusId): void {
        const state = this._state.get(bus);
        if (!state) return;
        if (bus === 'master') {
            Howler.volume(state.muted ? 0 : state.gain);
            return;
        }
        const node = this._nodes.get(bus);
        if (node) node.gain.value = state.muted ? 0 : state.gain;
    }
}
