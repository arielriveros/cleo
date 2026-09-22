// Heightmap files in and out, at full precision.
//
// The browser's own path — draw the image to a canvas, `getImageData` — hands back 8 bits per channel
// whatever the file holds. On a landscape with 300 m of relief that is 1.2 m per step: visible terraces
// on every slope, and exactly why every terrain tool in the industry trades in 16-bit PNG and raw R16.
// So PNG is decoded here, byte for byte, with the zlib stream inflated by the platform's
// DecompressionStream; RAW is trivial.
//
// Orientation, shared with `Terrain.exportHeightmap` and the old canvas import: image ROW 0 is the
// landscape's -Z edge and COLUMN 0 its -X edge.

/** A decoded heightmap, normalised to 0..1. */
export interface HeightImage {
    width: number;
    height: number;
    /** Row-major, 0..1. */
    data: Float32Array;
    /** Bits per sample in the source, for the dialog to report (8-bit sources terrace). */
    bitDepth: number;
}

export interface HeightImportOptions {
    /** World height of a 0 sample and of a 1 sample, terrain-local. */
    min: number;
    max: number;
    flipX?: boolean;
    flipY?: boolean;
    /** Clockwise, in degrees. */
    rotate?: 0 | 90 | 180 | 270;
}

// --- PNG ----------------------------------------------------------------------------------------

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Whether `bytes` starts with the PNG signature. */
export function isPng(bytes: Uint8Array): boolean {
    return bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
    // 'deflate' is the ZLIB-wrapped format, which is what a PNG's IDAT stream is.
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decode a PNG to a single 0..1 channel: grey for greyscale, RED for colour (the channel heightmap tools
 * write), palette entries by their red. 1/2/4/8/16-bit, every colour type, NOT interlaced — Adam7 is
 * rare in heightmaps and is refused with a message rather than decoded wrong.
 */
export async function decodePng(bytes: Uint8Array): Promise<HeightImage> {
    if (!isPng(bytes)) throw new Error('Not a PNG file');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 8;
    let width = 0, height = 0, bitDepth = 8, colorType = 0, interlace = 0;
    let palette: Uint8Array | null = null;
    const idat: Uint8Array[] = [];
    while (pos + 8 <= bytes.length) {
        const length = view.getUint32(pos);
        const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
        const body = bytes.subarray(pos + 8, pos + 8 + length);
        if (type === 'IHDR') {
            width = view.getUint32(pos + 8);
            height = view.getUint32(pos + 12);
            bitDepth = bytes[pos + 16];
            colorType = bytes[pos + 17];
            interlace = bytes[pos + 20];
        } else if (type === 'PLTE') palette = body;
        else if (type === 'IDAT') idat.push(body);
        else if (type === 'IEND') break;
        pos += 12 + length;
    }
    if (!width || !height) throw new Error('PNG has no image header');
    if (interlace) throw new Error('Interlaced PNGs are not supported for heightmaps; re-save it without interlacing');

    const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
    const bitsPerPixel = channels * bitDepth;
    const stride = Math.ceil((width * bitsPerPixel) / 8);
    const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));

    let total = 0;
    for (const c of idat) total += c.length;
    const compressed = new Uint8Array(total);
    let o = 0;
    for (const c of idat) { compressed.set(c, o); o += c.length; }
    const raw = await inflate(compressed);
    if (raw.length < height * (stride + 1)) throw new Error('PNG image data is truncated');

    // Unfilter in place into `rows`.
    const rows = new Uint8Array(height * stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const src = y * (stride + 1) + 1, dst = y * stride, prev = dst - stride;
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? rows[dst + x - bpp] : 0;
            const b = y > 0 ? rows[prev + x] : 0;
            const c = x >= bpp && y > 0 ? rows[prev + x - bpp] : 0;
            let v = raw[src + x];
            switch (filter) {
                case 1: v += a; break;
                case 2: v += b; break;
                case 3: v += (a + b) >> 1; break;
                case 4: v += paeth(a, b, c); break;
            }
            rows[dst + x] = v & 255;
        }
    }

    const data = new Float32Array(width * height);
    const maxValue = (1 << bitDepth) - 1;
    for (let y = 0; y < height; y++) {
        const row = y * stride;
        for (let x = 0; x < width; x++) {
            let sample: number;
            if (bitDepth === 16) {
                const i = row + x * channels * 2;
                sample = ((rows[i] << 8) | rows[i + 1]) / 65535;
            } else if (bitDepth === 8) {
                sample = rows[row + x * channels] / 255;
            } else {
                // Sub-byte greyscale or palette: pixels packed MSB first.
                const bit = x * bitDepth;
                const byte = rows[row + (bit >> 3)];
                sample = ((byte >> (8 - bitDepth - (bit & 7))) & maxValue) / maxValue;
            }
            if (colorType === 3 && palette) {
                const index = Math.round(sample * maxValue);
                sample = (palette[index * 3] ?? 0) / 255;
            }
            data[y * width + x] = sample;
        }
    }
    return { width, height, data, bitDepth: colorType === 3 ? 8 : bitDepth };
}

// CRC-32 over the chunk type and data, as PNG requires.
let CRC_TABLE: Uint32Array | null = null;
function crc32(bytes: Uint8Array, start: number, end: number): number {
    if (!CRC_TABLE) {
        CRC_TABLE = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            CRC_TABLE[n] = c >>> 0;
        }
    }
    let c = 0xffffffff;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    view.setUint32(8 + body.length, crc32(out, 4, 8 + body.length));
    return out;
}

/** Encode a 0..1 heightmap as a 16-bit greyscale PNG. */
export async function encodePng16(img: Pick<HeightImage, 'width' | 'height' | 'data'>): Promise<Uint8Array> {
    const { width, height, data } = img;
    const header = new Uint8Array(13);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, width);
    hv.setUint32(4, height);
    header[8] = 16; header[9] = 0; header[10] = 0; header[11] = 0; header[12] = 0;

    const stride = width * 2;
    const raw = new Uint8Array(height * (stride + 1));
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0; // filter: none
        for (let x = 0; x < width; x++) {
            const v = Math.round(Math.min(Math.max(data[y * width + x], 0), 1) * 65535);
            const i = y * (stride + 1) + 1 + x * 2;
            raw[i] = v >> 8;
            raw[i + 1] = v & 255;
        }
    }
    const parts = [new Uint8Array(PNG_SIGNATURE), chunk('IHDR', header), chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array(0))];
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

// --- RAW ----------------------------------------------------------------------------------------

/**
 * Decode a headerless R16 file (Unreal/Unity/World Machine "RAW"): unsigned 16-bit samples, LITTLE-endian
 * unless told otherwise, square unless `width` is given.
 */
export function decodeRaw16(bytes: Uint8Array, opts: { width?: number; littleEndian?: boolean } = {}): HeightImage {
    const samples = Math.floor(bytes.length / 2);
    const width = opts.width ?? Math.round(Math.sqrt(samples));
    const height = width > 0 ? Math.floor(samples / width) : 0;
    if (!width || width * height !== samples)
        throw new Error(`A ${bytes.length}-byte RAW file is not a square 16-bit heightmap; give its width`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const le = opts.littleEndian ?? true;
    const data = new Float32Array(samples);
    for (let i = 0; i < samples; i++) data[i] = view.getUint16(i * 2, le) / 65535;
    return { width, height, data, bitDepth: 16 };
}

/** Encode as little-endian R16. */
export function encodeRaw16(img: Pick<HeightImage, 'width' | 'height' | 'data'>): Uint8Array {
    const out = new Uint8Array(img.width * img.height * 2);
    const view = new DataView(out.buffer);
    for (let i = 0; i < img.width * img.height; i++)
        view.setUint16(i * 2, Math.round(Math.min(Math.max(img.data[i], 0), 1) * 65535), true);
    return out;
}

/** Decode whichever format `bytes` is: PNG by its signature, otherwise RAW R16. */
export async function decodeHeightmap(bytes: Uint8Array, rawWidth?: number): Promise<HeightImage> {
    return isPng(bytes) ? decodePng(bytes) : decodeRaw16(bytes, { width: rawWidth });
}

// --- sampling -----------------------------------------------------------------------------------

/** Bilinear 0..1 sample at normalised image coordinates (0..1 across, edge to edge), clamped. */
export function sampleHeight(img: HeightImage, u: number, v: number): number {
    const x = Math.min(Math.max(u, 0), 1) * (img.width - 1);
    const y = Math.min(Math.max(v, 0), 1) * (img.height - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, img.width - 1), y1 = Math.min(y0 + 1, img.height - 1);
    const fx = x - x0, fy = y - y0, d = img.data, w = img.width;
    const a = d[y0 * w + x0] + (d[y0 * w + x1] - d[y0 * w + x0]) * fx;
    const b = d[y1 * w + x0] + (d[y1 * w + x1] - d[y1 * w + x0]) * fx;
    return a + (b - a) * fy;
}

/**
 * A `resolution` x `resolution` height grid (terrain-local metres) from an image: bilinear, stretched
 * edge to edge, with optional flips and a clockwise rotation applied before sampling.
 */
export function heightsFromImage(img: HeightImage, resolution: number, o: HeightImportOptions): Float32Array {
    const R = resolution, out = new Float32Array(R * R);
    const span = o.max - o.min;
    for (let r = 0; r < R; r++) {
        for (let c = 0; c < R; c++) {
            let u = R > 1 ? c / (R - 1) : 0, v = R > 1 ? r / (R - 1) : 0;
            // Rotate the SAMPLING point counter-clockwise, which turns the image clockwise on the ground.
            switch (o.rotate ?? 0) {
                case 90: [u, v] = [v, 1 - u]; break;
                case 180: [u, v] = [1 - u, 1 - v]; break;
                case 270: [u, v] = [1 - v, u]; break;
            }
            if (o.flipX) u = 1 - u;
            if (o.flipY) v = 1 - v;
            out[r * R + c] = o.min + sampleHeight(img, u, v) * span;
        }
    }
    return out;
}

/** A height grid as a 0..1 image plus the range that maps it back — the export side of the round trip. */
export function imageFromHeights(heights: Float32Array, resolution: number): { image: HeightImage; min: number; max: number } {
    let min = Infinity, max = -Infinity;
    for (const h of heights) { if (h < min) min = h; if (h > max) max = h; }
    if (!isFinite(min)) { min = 0; max = 0; }
    const span = max - min || 1;
    const data = new Float32Array(heights.length);
    for (let i = 0; i < heights.length; i++) data[i] = (heights[i] - min) / span;
    return { image: { width: resolution, height: resolution, data, bitDepth: 16 }, min, max };
}
