// A minimal PNG writer for what Creator emits besides the 16-bit heightmap (which is the engine's own
// encodePng16): 8-bit greyscale masks and the RGBA8 flipbook atlas.
//
// Written here rather than through `canvas.toBlob` so the bytes are a pure function of the pixels --
// the same in a test under Node as in any browser -- which is what lets an asset be pinned by hash.
// Filter 0 (none) on every row and the platform's zlib (`CompressionStream('deflate')` IS zlib/RFC 1950,
// which is what IDAT wants).

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
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

async function zlib(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Colour type 0 (greyscale) or 6 (RGBA), 8 bits per channel. */
async function encode(width: number, height: number, channels: 1 | 4, pixels: Uint8Array): Promise<Uint8Array> {
  if (pixels.length !== width * height * channels)
    throw new Error(`png: ${pixels.length} bytes is not ${width}x${height}x${channels}`);
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header[8] = 8;
  header[9] = channels === 1 ? 0 : 6;
  const stride = width * channels;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const parts = [SIGNATURE, chunk('IHDR', header), chunk('IDAT', await zlib(raw)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** 8-bit greyscale from 0..1 floats (clamped). */
export function encodePngGray8(width: number, height: number, values: ArrayLike<number>): Promise<Uint8Array> {
  const px = new Uint8Array(width * height);
  for (let i = 0; i < px.length; i++) px[i] = Math.round(Math.min(1, Math.max(0, values[i])) * 255);
  return encode(width, height, 1, px);
}

/** RGBA8, rows top to bottom, straight (not premultiplied) alpha. */
export function encodePngRgba8(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  return encode(width, height, 4, rgba);
}

/** Inverse of the zlib step, for tests that want to read a PNG back. */
export async function inflateIdat(png: Uint8Array): Promise<{ width: number; height: number; colorType: number; raw: Uint8Array }> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let o = 8, width = 0, height = 0, colorType = 0;
  const idat: Uint8Array[] = [];
  while (o < png.length) {
    const len = view.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    const body = png.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { width = view.getUint32(o + 8); height = view.getUint32(o + 12); colorType = body[9]; }
    if (type === 'IDAT') idat.push(body);
    o += 12 + len;
  }
  const joined = new Uint8Array(idat.reduce((n, b) => n + b.length, 0));
  let p = 0;
  for (const b of idat) { joined.set(b, p); p += b.length; }
  const stream = new Blob([joined as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return { width, height, colorType, raw: new Uint8Array(await new Response(stream).arrayBuffer()) };
}
