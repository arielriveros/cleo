/**
 * The saved GI captures a host has loaded: `.cgib` bytes (giBakeFormat.ts) by bake id, which a
 * GIVolumeNode names in `bakeId`. The editor fills it from its project storage at boot, a published game
 * from its game.bin, before any scene is parsed; the renderer reads it when a volume first appears.
 * Pure: no GPU here.
 */

const bakes = new Map<string, Uint8Array>();
let generation = 0;

export const GiBakeRegistry = {
    /** Register (or replace) the bytes of bake `id`. */
    set(id: string, bytes: Uint8Array): void {
        bakes.set(id, bytes);
        generation++;
    },
    get(id: string | null | undefined): Uint8Array | null {
        return id ? bakes.get(id) ?? null : null;
    },
    has(id: string | null | undefined): boolean {
        return !!id && bakes.has(id);
    },
    delete(id: string): boolean {
        const had = bakes.delete(id);
        if (had) generation++;
        return had;
    },
    /** Every registered bake id. */
    ids(): string[] { return [...bakes.keys()]; },
    clear(): void {
        bakes.clear();
        generation++;
    },
    /** Bumped on every change, so a consumer can tell its view is out of date. */
    get generation(): number { return generation; },
};

/** A fresh bake id: unique enough to be minted per save without a registry round-trip. */
export function newGiBakeId(): string {
    const rand = Math.random().toString(36).slice(2, 10);
    return `gi-${Date.now().toString(36)}-${rand}`;
}
