import { describe, it, expect } from 'vitest';
import { bytesToBase64, base64ToBytes, bytesToDataUrl, parseBase64DataUri } from '../src/core/base64';

describe('base64', () => {
    it('round-trips bytes', () => {
        const bytes = new Uint8Array([0, 1, 127, 128, 255, 42]);
        expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    });

    it('round-trips an empty array', () => {
        expect(bytesToBase64(new Uint8Array([]))).toBe('');
        expect(base64ToBytes('')).toEqual(new Uint8Array([]));
    });

    // The chunking (CHUNK = 0x8000) exists to avoid blowing the apply() argument limit. A payload
    // spanning several chunks is the case that regresses if that loop is ever "simplified".
    it('round-trips a payload larger than the 32KB chunk boundary', () => {
        const bytes = new Uint8Array(0x8000 * 2 + 17);
        for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
        expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    });

    it('preserves high bytes across the chunk boundary', () => {
        const bytes = new Uint8Array(0x8000 + 4).fill(0xff);
        expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    });

    it('builds a data URL with its mime', () => {
        expect(bytesToDataUrl(new Uint8Array([1, 2, 3]), 'image/png'))
            .toBe(`data:image/png;base64,${bytesToBase64(new Uint8Array([1, 2, 3]))}`);
    });
});

describe('parseBase64DataUri', () => {
    it('splits mime from payload', () => {
        const bytes = new Uint8Array([9, 8, 7]);
        const parsed = parseBase64DataUri(bytesToDataUrl(bytes, 'image/jpeg'));
        expect(parsed).not.toBeNull();
        expect(parsed!.mime).toBe('image/jpeg');
        expect(parsed!.bytes).toEqual(bytes);
    });

    it('defaults a missing mime to application/octet-stream', () => {
        expect(parseBase64DataUri('data:;base64,AQID')?.mime).toBe('application/octet-stream');
    });

    it('rejects non-data URIs', () => {
        expect(parseBase64DataUri('https://example.com/a.png')).toBeNull();
        expect(parseBase64DataUri('')).toBeNull();
    });

    // Documented contract: non-base64 data URIs are not this function's job.
    it('rejects a data URI that is not base64-encoded', () => {
        expect(parseBase64DataUri('data:image/svg+xml,<svg/>')).toBeNull();
    });

    it('rejects a data URI with no comma', () => {
        expect(parseBase64DataUri('data:image/png;base64')).toBeNull();
    });
});
