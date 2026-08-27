// Base64 <-> bytes. Uses only btoa/atob, so this stays importable from workers as well as the window.

// Comfortably under the argument-count limit for Function.prototype.apply.
const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK)
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
    return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

/** Wrap bytes as a `data:<mime>;base64,…` URI. */
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
    return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

/**
 * Split a `data:<mime>;base64,<payload>` URI into its mime and decoded bytes.
 * Returns null for anything else — including non-base64 data URIs like `data:image/svg+xml,<raw>`.
 */
export function parseBase64DataUri(uri: string): { mime: string; bytes: Uint8Array } | null {
    if (!uri.startsWith('data:')) return null;
    const comma = uri.indexOf(',');
    if (comma < 0) return null;

    const header = uri.slice(5, comma);
    if (!header.endsWith(';base64')) return null;

    const mime = header.slice(0, -';base64'.length) || 'application/octet-stream';
    try {
        return { mime, bytes: base64ToBytes(uri.slice(comma + 1)) };
    } catch {
        return null;
    }
}
