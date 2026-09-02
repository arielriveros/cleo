import { describe, it, expect } from 'vitest';
import {
    DEFAULT_POST_CHAIN, isBuiltinEffect, isDefaultChain, materialIndexOf, resolvePostChain,
} from '../src/graphics/renderGraph/chain';
import type { PostChainEntry } from '../src/graphics/renderGraph/chain';

/**
 * The chain is the one piece of this feature that reaches saved data, and the way it fails is silent.
 *
 * Every scene written before per-camera chains existed carries no chain at all, and has to keep
 * rendering exactly as it did — the default this resolves to IS the old hardcoded order, so a change
 * to `DEFAULT_POST_CHAIN` is a change to how every existing project looks. A chain that instead
 * dropped an effect, or reordered one, would not throw: the frame would simply come back without
 * bloom, and the report would be "my scene lost its glow after updating".
 *
 * The other half is drift between a saved chain and the camera's material list. Materials are keyed
 * by INDEX (a CustomMaterial has no stable id — its `type` is a content hash that changes on every
 * edit), so deleting one shifts every index after it. Resolution repairs that rather than rejecting
 * it, because rejecting a saved file means a black screen.
 */

describe('default chain', () => {
    it('is the engine default order', () => {
        // Load-bearing: this list is what an un-migrated scene gets. Changing it changes every
        // existing project's image. Motion blur, exposure and present are deliberately absent —
        // they are anchors, not entries. See the header of chain.ts.
        expect(DEFAULT_POST_CHAIN).toEqual([
            'depthOfField', 'godRays', 'bloom', 'lensFlare', 'chromatic', 'vignette', 'filmGrain',
        ]);
    });

    it('leaves the three original effects in the order they already ran', () => {
        // The guarantee that adding four effects changed nobody's image. Their ABSOLUTE positions
        // moved (DoF was inserted ahead of them), but nothing was reordered relative to anything that
        // already existed — and the four newcomers all ship switched off. If this ever fails, every
        // saved scene in every project has quietly started rendering differently.
        const original = DEFAULT_POST_CHAIN.filter(id => ['godRays', 'bloom', 'chromatic'].includes(id));
        expect(original).toEqual(['godRays', 'bloom', 'chromatic']);
    });

    it('puts depth of field ahead of everything that adds light to the image', () => {
        // DoF is the lens focusing on the SCENE; god rays, bloom and flare are glare produced inside
        // the lens, which the focal plane does not act on. Running DoF after them defocuses the glare
        // by the CoC of whatever geometry happens to sit behind it.
        const at = (id: string) => DEFAULT_POST_CHAIN.indexOf(id as never);
        expect(at('depthOfField')).toBeLessThan(at('godRays'));
        expect(at('depthOfField')).toBeLessThan(at('bloom'));
        expect(at('depthOfField')).toBeLessThan(at('lensFlare'));
        // Shafts have to bloom, and flare is composited with the bloom it came from.
        expect(at('godRays')).toBeLessThan(at('bloom'));
        expect(at('bloom')).toBeLessThan(at('lensFlare'));
        // Grain is the sensor's own response: nothing in the lens may follow it.
        expect(at('filmGrain')).toBe(DEFAULT_POST_CHAIN.length - 1);
    });

    it('resolves a camera with no authored chain to the built-ins, all enabled', () => {
        // Enabled here means "in the chain", not "doing something": each effect is gated a second time
        // in `_buildPostGraph` on its own intensity, and every one added after the first three is zero
        // by default.
        expect(resolvePostChain(null, 0))
            .toEqual(DEFAULT_POST_CHAIN.map(effect => ({ effect, enabled: true })));
    });

    it('puts screen materials after the built-ins, which is where _screenMaterialsPass sat', () => {
        expect(resolvePostChain(null, 2).map(e => e.effect))
            .toEqual([...DEFAULT_POST_CHAIN, 'material:0', 'material:1']);
    });

    it('treats undefined the same as null', () => {
        expect(resolvePostChain(undefined, 1)).toEqual(resolvePostChain(null, 1));
    });
});

describe('authored chain resolution', () => {
    it('keeps the order the user authored', () => {
        const authored: PostChainEntry[] = [
            { effect: 'chromatic', enabled: true },
            { effect: 'bloom', enabled: true },
            { effect: 'godRays', enabled: true },
        ];
        // The authored three keep their order; the effects this camera predates are appended.
        expect(resolvePostChain(authored, 0).map(e => e.effect).slice(0, 3))
            .toEqual(['chromatic', 'bloom', 'godRays']);
    });

    it('carries the enabled flag through', () => {
        const authored: PostChainEntry[] = [{ effect: 'bloom', enabled: false }];
        expect(resolvePostChain(authored, 0)[0]).toEqual({ effect: 'bloom', enabled: false });
    });

    it('appends a built-in the authored chain never mentioned', () => {
        // A built-in is always PRESENT — off is expressed as `enabled: false`, never as absence. That
        // is what guarantees there is always a row to switch it back on from, and it is also the
        // repair for a chain written by an older build that did not know about an effect yet: every
        // camera authored before depth of field existed takes this path on load.
        const resolved = resolvePostChain([{ effect: 'chromatic', enabled: true }], 0);
        expect(resolved.map(e => e.effect)).toEqual([
            'chromatic', ...DEFAULT_POST_CHAIN.filter(id => id !== 'chromatic'),
        ]);
    });

    it('drops an id it does not recognise', () => {
        // Forward compatibility: a chain saved by a NEWER build naming an effect this one has never
        // heard of must not break the scene. Drop the row, keep the rest.
        const resolved = resolvePostChain(
            [{ effect: 'nightVision' as never, enabled: true }, { effect: 'bloom', enabled: true }], 0);
        expect(resolved.map(e => e.effect)).toEqual([
            'bloom', ...DEFAULT_POST_CHAIN.filter(id => id !== 'bloom'),
        ]);
    });

    it('drops a material whose index is past the end of the camera list', () => {
        // The material was deleted in the inspector while the chain still names it.
        const resolved = resolvePostChain(
            [{ effect: 'material:3', enabled: true }, { effect: 'bloom', enabled: true }], 1);
        expect(resolved.map(e => e.effect)).toEqual([
            'bloom', ...DEFAULT_POST_CHAIN.filter(id => id !== 'bloom'), 'material:0',
        ]);
    });

    it('appends a material the camera has but the chain does not mention', () => {
        // Adding a material in the inspector puts it at the end of the chain, exactly as it always has.
        const authored: PostChainEntry[] = [
            { effect: 'bloom', enabled: true }, { effect: 'material:0', enabled: true },
            { effect: 'godRays', enabled: true }, { effect: 'chromatic', enabled: true },
        ];
        const resolved = resolvePostChain(authored, 2).map(e => e.effect);
        expect(resolved.slice(0, 4)).toEqual(['bloom', 'material:0', 'godRays', 'chromatic']);
        expect(resolved[resolved.length - 1]).toBe('material:1');
    });

    it('keeps the first position of a duplicated entry and ignores the rest', () => {
        const authored: PostChainEntry[] = [
            { effect: 'bloom', enabled: true },
            { effect: 'godRays', enabled: true },
            { effect: 'bloom', enabled: false },
        ];
        const resolved = resolvePostChain(authored, 0);
        expect(resolved.map(e => e.effect)).toEqual([
            'bloom', 'godRays',
            ...DEFAULT_POST_CHAIN.filter(id => id !== 'bloom' && id !== 'godRays'),
        ]);
        // The FIRST occurrence wins, so the trailing `enabled: false` duplicate is ignored outright
        // rather than switching the effect off from a position it does not occupy.
        expect(resolved[0].enabled).toBe(true);
    });

    it('survives a malformed blob without throwing', () => {
        // The input is a file on disk that any number of older builds may have written.
        const junk = [null, undefined, {}, { effect: 42 }, { effect: 'bloom' }] as never;
        expect(() => resolvePostChain(junk, 0)).not.toThrow();
        // `{ effect: 'bloom' }` with no flag reads as enabled — absent means on, not off.
        expect(resolvePostChain(junk, 0)[0]).toEqual({ effect: 'bloom', enabled: true });
    });
});

describe('chain identity helpers', () => {
    it('recognises built-ins and material ids', () => {
        expect(isBuiltinEffect('bloom')).toBe(true);
        expect(isBuiltinEffect('depthOfField')).toBe(true);
        expect(isBuiltinEffect('filmGrain')).toBe(true);
        expect(isBuiltinEffect('nightVision')).toBe(false);
        expect(isBuiltinEffect('material:0')).toBe(false);
        expect(materialIndexOf('material:4')).toBe(4);
        expect(materialIndexOf('bloom')).toBeNull();
        // Not an index: these would otherwise resolve to NaN and index past the end of the list.
        expect(materialIndexOf('material:-1')).toBeNull();
        expect(materialIndexOf('material:x')).toBeNull();
        expect(materialIndexOf('material:1.5')).toBeNull();
    });

    it('detects a chain equivalent to the default, so an untouched camera serializes nothing', () => {
        expect(isDefaultChain(null, 0)).toBe(true);
        expect(isDefaultChain(resolvePostChain(null, 2), 2)).toBe(true);
        expect(isDefaultChain([{ effect: 'bloom', enabled: false }], 0)).toBe(false);
        expect(isDefaultChain([{ effect: 'chromatic', enabled: true }], 0)).toBe(false);
        // A material moved ahead of the built-ins is an override even though the set is unchanged.
        expect(isDefaultChain([{ effect: 'material:0', enabled: true }], 1)).toBe(false);
        // But a chain authored when the camera had ONE material is still the default once a second is
        // added: resolution appends the newcomer in the position the default would have given it, so
        // adding a material in the inspector does not silently turn a camera into an override.
        expect(isDefaultChain(resolvePostChain(null, 1), 2)).toBe(true);
    });
});
