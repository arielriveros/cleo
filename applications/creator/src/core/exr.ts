// A minimal OpenEXR writer: one 32-bit float channel, uncompressed scanlines, single part. What Houdini,
// Gaea, World Machine and Blender read a float heightmap from, with no 16-bit quantisation and the
// heights in true metres. Written by hand (the format's header is a handful of typed attributes) so the
// bytes are a pure function of the data, like core/png.ts.

const MAGIC = 20000630;

function attribute(name: string, type: string, value: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const n = enc.encode(name), t = enc.encode(type);
  const out = new Uint8Array(n.length + 1 + t.length + 1 + 4 + value.length);
  out.set(n, 0);
  out.set(t, n.length + 1);
  new DataView(out.buffer).setInt32(n.length + 1 + t.length + 1, value.length, true);
  out.set(value, n.length + 1 + t.length + 1 + 4);
  return out;
}

const bytes = (size: number, write: (v: DataView) => void) => {
  const out = new Uint8Array(size);
  write(new DataView(out.buffer));
  return out;
};

/**
 * `data`: width * height floats, row 0 at the top (the first scanline). `channel` names it; 'Y' is the
 * luminance channel every reader shows as greyscale.
 */
export function encodeExrFloat(width: number, height: number, data: Float32Array, channel = 'Y'): Uint8Array {
  if (data.length !== width * height) throw new Error(`exr: ${data.length} floats is not ${width}x${height}`);
  const enc = new TextEncoder();
  const ch = enc.encode(channel);
  // chlist: name\0, pixel type (2 = FLOAT), pLinear, 3 reserved, x/y sampling; then a terminating \0.
  const chlist = new Uint8Array(ch.length + 1 + 16 + 1);
  chlist.set(ch, 0);
  const cv = new DataView(chlist.buffer);
  cv.setInt32(ch.length + 1, 2, true);
  cv.setInt32(ch.length + 1 + 8, 1, true);
  cv.setInt32(ch.length + 1 + 12, 1, true);
  const box = bytes(16, v => { v.setInt32(0, 0, true); v.setInt32(4, 0, true); v.setInt32(8, width - 1, true); v.setInt32(12, height - 1, true); });
  const header = [
    attribute('channels', 'chlist', chlist),
    attribute('compression', 'compression', new Uint8Array([0])),
    attribute('dataWindow', 'box2i', box),
    attribute('displayWindow', 'box2i', box),
    attribute('lineOrder', 'lineOrder', new Uint8Array([0])),
    attribute('pixelAspectRatio', 'float', bytes(4, v => v.setFloat32(0, 1, true))),
    attribute('screenWindowCenter', 'v2f', new Uint8Array(8)),
    attribute('screenWindowWidth', 'float', bytes(4, v => v.setFloat32(0, 1, true))),
    new Uint8Array([0]),
  ];
  const headerSize = 8 + header.reduce((n, a) => n + a.length, 0);
  const lineSize = 8 + width * 4;
  const tableSize = height * 8;
  const out = new Uint8Array(headerSize + tableSize + height * lineSize);
  const view = new DataView(out.buffer);
  view.setInt32(0, MAGIC, true);
  view.setInt32(4, 2, true); // version 2, single-part scanline
  let o = 8;
  for (const a of header) { out.set(a, o); o += a.length; }
  const first = headerSize + tableSize;
  for (let y = 0; y < height; y++) {
    // Offsets are 64-bit; World exports stay far below 2^32, so the high word is 0.
    view.setUint32(o + y * 8, first + y * lineSize, true);
    view.setUint32(o + y * 8 + 4, 0, true);
  }
  for (let y = 0; y < height; y++) {
    const p = first + y * lineSize;
    view.setInt32(p, y, true);
    view.setInt32(p + 4, width * 4, true);
    for (let x = 0; x < width; x++) view.setFloat32(p + 8 + x * 4, data[y * width + x], true);
  }
  return out;
}
