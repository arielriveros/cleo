// Builds every small copy of the Cleo logo from the two masters in applications/app-kit/src/assets/logo:
// the loading-screen logo and its pixelated copy, and the favicons, which each app serves from its
// public/brand/ (the editor the colour logo, the Creator the black-and-white one); the editor's
// Creator-button icon; and the desktop shell's window/installer icons. The outputs
// are committed, so no build depends on this; run it again (`npm run brand:icons`) when a master changes.
//
// Plain Node, no image library: the PNGs are decoded and encoded here with zlib, and resampled with an
// area average in premultiplied linear light (straight sRGB averaging darkens the soft glassy edges).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync, inflateSync, crc32 } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const masters = path.join(root, 'applications', 'app-kit', 'src', 'assets', 'logo');

// ---------------------------------------------------------------------------------------------- PNG I/O

/** Decodes an 8-bit RGBA, non-interlaced PNG (what the masters are) to `{ width, height, data }`. */
function decodePng(file) {
    const buf = readFileSync(file);
    let width = 0, height = 0;
    const idat = [];
    for (let p = 8; p < buf.length;) {
        const len = buf.readUInt32BE(p);
        const type = buf.toString('ascii', p + 4, p + 8);
        if (type === 'IHDR') {
            width = buf.readUInt32BE(p + 8);
            height = buf.readUInt32BE(p + 12);
            const [depth, colorType, , , interlace] = buf.subarray(p + 16, p + 21);
            if (depth !== 8 || colorType !== 6 || interlace !== 0) throw new Error(`${file}: expected 8-bit RGBA, non-interlaced`);
        }
        if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
        p += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * 4;
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const row = y * stride;
        for (let x = 0; x < stride; x++) {
            const a = x >= 4 ? data[row + x - 4] : 0;
            const b = y > 0 ? data[row - stride + x] : 0;
            const c = x >= 4 && y > 0 ? data[row - stride + x - 4] : 0;
            let v = line[x];
            if (filter === 1) v += a;
            else if (filter === 2) v += b;
            else if (filter === 3) v += (a + b) >> 1;
            else if (filter === 4) v += paeth(a, b, c);
            data[row + x] = v & 255;
        }
    }
    return { width, height, data };
}

function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Encodes RGBA pixels as a PNG, choosing each row's filter by the usual minimum-sum heuristic. */
function encodePng({ width, height, data }) {
    const stride = width * 4;
    const raw = Buffer.alloc(height * (stride + 1));
    const candidate = Buffer.alloc(stride);
    for (let y = 0; y < height; y++) {
        const row = y * stride;
        let best = Infinity;
        for (let filter = 0; filter < 5; filter++) {
            let sum = 0;
            for (let x = 0; x < stride; x++) {
                const a = x >= 4 ? data[row + x - 4] : 0;
                const b = y > 0 ? data[row - stride + x] : 0;
                const c = x >= 4 && y > 0 ? data[row - stride + x - 4] : 0;
                const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : paeth(a, b, c);
                const v = (data[row + x] - predictor) & 255;
                candidate[x] = v;
                sum += v < 128 ? v : 256 - v;
            }
            if (sum < best) {
                best = sum;
                raw[y * (stride + 1)] = filter;
                candidate.copy(raw, y * (stride + 1) + 1);
            }
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.set([8, 6, 0, 0, 0], 8);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

function chunk(type, body) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
    return Buffer.concat([head, body, crc]);
}

/** A PNG-in-ICO container: Windows Vista and later (and electron-builder) read PNG entries at any size. */
function encodeIco(pngs) {
    const header = Buffer.alloc(6 + 16 * pngs.length);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(pngs.length, 4);
    let offset = header.length;
    pngs.forEach(({ size, png }, i) => {
        const e = 6 + 16 * i;
        header[e] = size >= 256 ? 0 : size;
        header[e + 1] = size >= 256 ? 0 : size;
        header.writeUInt16LE(1, e + 4);
        header.writeUInt16LE(32, e + 6);
        header.writeUInt32LE(png.length, e + 8);
        header.writeUInt32LE(offset, e + 12);
        offset += png.length;
    });
    return Buffer.concat([header, ...pngs.map(p => p.png)]);
}

// ------------------------------------------------------------------------------------------ Resampling

const toLinear = new Float32Array(256).map((_, i) => {
    const c = i / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const toSrgb = (l) => {
    const c = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
};

/** The box around every pixel whose alpha is above `threshold`. */
function alphaBounds({ width, height, data }, threshold = 8) {
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (data[(y * width + x) * 4 + 3] <= threshold) continue;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
        }
    }
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Premultiplied linear-light RGBA as floats, for averaging. */
function toFloat({ width, height, data }) {
    const f = new Float32Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const a = data[i * 4 + 3] / 255;
        f[i * 4] = toLinear[data[i * 4]] * a;
        f[i * 4 + 1] = toLinear[data[i * 4 + 1]] * a;
        f[i * 4 + 2] = toLinear[data[i * 4 + 2]] * a;
        f[i * 4 + 3] = a;
    }
    return { width, height, data: f };
}

function fromFloat({ width, height, data }) {
    const out = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const a = data[i * 4 + 3];
        if (a <= 1e-6) continue;
        out[i * 4] = toSrgb(data[i * 4] / a);
        out[i * 4 + 1] = toSrgb(data[i * 4 + 1] / a);
        out[i * 4 + 2] = toSrgb(data[i * 4 + 2] / a);
        out[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
    }
    return { width, height, data: out };
}

/**
 * For each destination column (or row) of a 1-D resize: which source pixels it covers and by how much.
 * The source span [srcStart, srcStart + srcLen) maps onto [dstStart, dstStart + dstLen) of `dstSize`
 * pixels; destination pixels outside it, or source pixels outside the image, contribute nothing.
 */
function areaWeights(srcSize, srcStart, srcLen, dstSize, dstStart, dstLen) {
    const scale = srcLen / dstLen;
    const taps = [];
    for (let d = 0; d < dstSize; d++) {
        const s0 = srcStart + (d - dstStart) * scale, s1 = s0 + scale;
        const list = [];
        for (let s = Math.floor(s0); s < Math.ceil(s1); s++) {
            if (s < 0 || s >= srcSize) continue;
            const w = Math.min(s + 1, s1) - Math.max(s, s0);
            if (w > 0) list.push([s, w / scale]);
        }
        taps.push(list);
    }
    return taps;
}

/**
 * Draws the source's `rect` into a transparent `width`×`height` image, scaled to `fit`×`fit` at most
 * (keeping its aspect) and centred.
 */
function render(src, rect, width, height, fit) {
    const scale = Math.min(fit / rect.w, fit / rect.h);
    const dw = rect.w * scale, dh = rect.h * scale;
    const dx = (width - dw) / 2, dy = (height - dh) / 2;
    const xs = areaWeights(src.width, rect.x, rect.w, width, dx, dw);
    const ys = areaWeights(src.height, rect.y, rect.h, height, dy, dh);
    return resample(src, xs, ys, width, height);
}

/** Separable area average by the given column and row taps (areaWeights): rows first, then columns. */
function resample(src, xs, ys, width, height) {
    const mid = new Float32Array(width * src.height * 4);
    for (let y = 0; y < src.height; y++) {
        for (let x = 0; x < width; x++) {
            const o = (y * width + x) * 4;
            for (const [s, w] of xs[x]) {
                const i = (y * src.width + s) * 4;
                mid[o] += src.data[i] * w;
                mid[o + 1] += src.data[i + 1] * w;
                mid[o + 2] += src.data[i + 2] * w;
                mid[o + 3] += src.data[i + 3] * w;
            }
        }
    }
    const out = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (const [s, w] of ys[y]) {
            for (let x = 0; x < width; x++) {
                const o = (y * width + x) * 4, i = (s * width + x) * 4;
                out[o] += mid[i] * w;
                out[o + 1] += mid[i + 1] * w;
                out[o + 2] += mid[i + 2] * w;
                out[o + 3] += mid[i + 3] * w;
            }
        }
    }
    return fromFloat({ width, height, data: out });
}

// --------------------------------------------------------------------------------------------- Outputs

function write(rel, bytes) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    console.log(`cleo: ${rel} (${(bytes.length / 1024).toFixed(1)} KB)`);
}

/** The loading-screen logo's canvas: the artwork at long side `long` plus a hairline of transparent margin. */
function logoCanvas(rect, long) {
    const scale = long / Math.max(rect.w, rect.h);
    const margin = 2;
    return { scale, w: Math.round(rect.w * scale) + margin * 2, h: Math.round(rect.h * scale) + margin * 2 };
}

/** The loading-screen logo: trimmed to the artwork, long side `long`, with a hairline of transparent margin. */
function logo(src, rect, long) {
    const { w, h } = logoCanvas(rect, long);
    return encodePng(render(src, rect, w, h, long));
}

/**
 * The loading screen's pixelated logo (app-kit feedback/LogoLoader.tsx): the same canvas as `logo()`,
 * margin included, area-averaged down to `cols` columns. Shown stretched over logo.png's box with
 * `image-rendering: pixelated`, so it covers exactly what logo.png covers and the two line up.
 */
function logoPixels(src, rect, long, cols) {
    const { scale, w, h } = logoCanvas(rect, long);
    const rows = Math.round(cols * h / w);
    // logo.png's canvas in source pixels: render() centres the artwork, so the margin is split evenly.
    const sx = rect.x - (w - rect.w * scale) / 2 / scale, sy = rect.y - (h - rect.h * scale) / 2 / scale;
    const xs = areaWeights(src.width, sx, w / scale, cols, 0, cols);
    const ys = areaWeights(src.height, sy, h / scale, rows, 0, rows);
    return encodePng(resample(src, xs, ys, cols, rows));
}

/** The pixelated logo's columns: the loader is 180 CSS px wide, so 6 px blocks at 1x. */
const PIXEL_COLS = 30;

/** A square icon: the artwork centred with a little padding, which is what launchers and tabs expect. */
const icon = (src, rect, size) => encodePng(render(src, rect, size, size, size * 0.9));

const color = toFloat(decodePng(path.join(masters, 'cleo_color.png')));
const bw = toFloat(decodePng(path.join(masters, 'cleo_bw.png')));
const colorRect = alphaBounds(fromFloat(color));
const bwRect = alphaBounds(fromFloat(bw));

for (const [app, src, rect] of [['editor', color, colorRect], ['creator', bw, bwRect]]) {
    const dir = `applications/${app}/public/brand`;
    write(`${dir}/logo.png`, logo(src, rect, 400));
    write(`${dir}/logo-pixel.png`, logoPixels(src, rect, 400, PIXEL_COLS));
    write(`${dir}/favicon-32.png`, icon(src, rect, 32));
    write(`${dir}/icon-192.png`, icon(src, rect, 192));
}
// The editor's "Creator" button (features/assets/CreatorButton.tsx) shows the Creator's logo from the
// editor's own public/: the Creator's copy is behind a dev proxy that is empty while it is not running.
write('applications/editor/public/brand/creator-32.png', icon(bw, bwRect, 32));

const desktop = 'applications/app-kit/desktop/icons';
write(`${desktop}/icon.png`, icon(color, colorRect, 512));
write(`${desktop}/icon.ico`, encodeIco([16, 24, 32, 48, 64, 128, 256].map(size => ({ size, png: icon(color, colorRect, size) }))));
write(`${desktop}/icon-creator.png`, icon(bw, bwRect, 256));
