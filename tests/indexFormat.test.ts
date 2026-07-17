import { describe, it, expect } from 'vitest';
import {
    INDEX_16_LIMIT, GL_UNSIGNED_SHORT, GL_UNSIGNED_INT,
    maxIndex, needs32Bit, createIndexArray, glTypeFor,
} from '../src/graphics/indexFormat';

/** Indices for a mesh whose highest vertex index is `max`. */
const upTo = (max: number) => [0, 1, max];

describe('maxIndex', () => {
    it('finds the largest value', () => {
        expect(maxIndex([0, 5, 2])).toBe(5);
        expect(maxIndex([7])).toBe(7);
    });

    it('returns -1 for an empty array', () => {
        expect(maxIndex([])).toBe(-1);
    });

    // Math.max(...indices) throws RangeError somewhere around 125k args — exactly the large meshes this
    // module exists for. This test is the guard against someone "simplifying" the loop back to a spread.
    it('handles an array far past the argument-spread limit', () => {
        const big = new Array(200_000);
        for (let i = 0; i < big.length; i++) big[i] = i;
        expect(() => maxIndex(big)).not.toThrow();
        expect(maxIndex(big)).toBe(199_999);
    });
});

describe('needs32Bit', () => {
    it('keeps ordinary meshes on the 16-bit path', () => {
        expect(needs32Bit(upTo(0))).toBe(false);
        expect(needs32Bit(upTo(1000))).toBe(false);
        expect(needs32Bit([])).toBe(false);
    });

    // The boundary is the whole point. 65535 is NOT usable as an index: WebGL2 always treats it as
    // PRIMITIVE_RESTART_FIXED_INDEX for UNSIGNED_SHORT, so it must push the mesh to 32-bit.
    it('switches at the primitive-restart index, not one past it', () => {
        expect(needs32Bit(upTo(INDEX_16_LIMIT - 1))).toBe(false); // 65534 — last usable 16-bit index
        expect(needs32Bit(upTo(INDEX_16_LIMIT))).toBe(true);      // 65535 — the restart marker
        expect(needs32Bit(upTo(INDEX_16_LIMIT + 1))).toBe(true);  // 65536
    });

    it('pins the limit to 65535', () => {
        expect(INDEX_16_LIMIT).toBe(65535);
    });
});

describe('createIndexArray', () => {
    it('returns Uint16Array for ordinary meshes', () => {
        const a = createIndexArray(upTo(1000));
        expect(a).toBeInstanceOf(Uint16Array);
        expect(Array.from(a)).toEqual([0, 1, 1000]);
    });

    it('returns Uint32Array once an index reaches the limit', () => {
        const a = createIndexArray(upTo(INDEX_16_LIMIT));
        expect(a).toBeInstanceOf(Uint32Array);
        expect(Array.from(a)).toEqual([0, 1, 65535]);
    });

    // The actual bug this whole change exists to fix: index 70000 used to silently become 4464.
    it('preserves indices that Uint16Array would have wrapped', () => {
        const a = createIndexArray([0, 65536, 70000, 199_999]);
        expect(a).toBeInstanceOf(Uint32Array);
        expect(Array.from(a)).toEqual([0, 65536, 70000, 199_999]);
        // Prove the old behaviour really did corrupt these, so the test documents the bug it prevents.
        expect(Array.from(new Uint16Array([0, 65536, 70000, 199_999]))).toEqual([0, 0, 4464, 3391]);
    });

    it('throws on a negative index rather than wrapping it to the restart marker', () => {
        // new Uint16Array([-1]) is 65535 — silently the primitive-restart index. Loud is better.
        expect(() => createIndexArray([0, 1, -1])).toThrow(/non-negative integer/);
    });

    it('throws on fractional and NaN indices', () => {
        expect(() => createIndexArray([0, 1.5])).toThrow(/non-negative integer/);
        expect(() => createIndexArray([0, NaN])).toThrow(/non-negative integer/);
    });

    it('handles an empty array', () => {
        const a = createIndexArray([]);
        expect(a).toBeInstanceOf(Uint16Array);
        expect(a.length).toBe(0);
    });
});

describe('glTypeFor', () => {
    it('maps each array width to its GL enum', () => {
        expect(glTypeFor(new Uint16Array([0]))).toBe(GL_UNSIGNED_SHORT);
        expect(glTypeFor(new Uint32Array([0]))).toBe(GL_UNSIGNED_INT);
    });

    // These are hardcoded rather than read off a live context (this module must stay GL-free), so pin them
    // to the spec values. gltfLoader.ts's COMPONENT_TYPE independently declares UNSIGNED_INT: 5125.
    it('matches the WebGL spec enum values', () => {
        expect(GL_UNSIGNED_SHORT).toBe(5123);
        expect(GL_UNSIGNED_INT).toBe(5125);
    });
});
