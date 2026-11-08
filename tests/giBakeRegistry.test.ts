import { describe, expect, it } from 'vitest';
import { GiBakeRegistry, newGiBakeId } from '../src/graphics/render/gi/giBakeRegistry';

describe('GiBakeRegistry', () => {
    it('holds bakes by id and counts its changes', () => {
        GiBakeRegistry.clear();
        const g0 = GiBakeRegistry.generation;
        const a = new Uint8Array([1, 2, 3]);
        GiBakeRegistry.set('a', a);
        expect(GiBakeRegistry.get('a')).toBe(a);
        expect(GiBakeRegistry.has('a')).toBe(true);
        expect(GiBakeRegistry.get(null)).toBeNull();
        expect(GiBakeRegistry.get('missing')).toBeNull();
        expect(GiBakeRegistry.ids()).toEqual(['a']);
        expect(GiBakeRegistry.delete('a')).toBe(true);
        expect(GiBakeRegistry.delete('a')).toBe(false);
        expect(GiBakeRegistry.generation).toBe(g0 + 2);
    });

    it('mints distinct ids', () => {
        const ids = new Set(Array.from({ length: 50 }, () => newGiBakeId()));
        expect(ids.size).toBe(50);
        for (const id of ids) expect(id.startsWith('gi-')).toBe(true);
    });
});
