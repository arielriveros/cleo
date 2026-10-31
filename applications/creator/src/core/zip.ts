// A minimal .zip reader: the central directory, stored and deflated entries, nothing else (no zip64, no
// encryption). Enough for a downloaded PBR texture set; inflates with the platform's
// `DecompressionStream('deflate-raw')`, so it runs in browsers, workers and Node alike.

export interface ZipEntry { name: string; bytes: Uint8Array }

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Every file in the archive (directories skipped), in directory order. Throws on anything it cannot read. */
export async function readZip(data: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // The end-of-central-directory record: the last 22 bytes, or further back by its comment.
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--)
    if (view.getUint32(i, true) === EOCD) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip archive.');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== CENTRAL) throw new Error('Corrupt zip central directory.');
    const method = view.getUint16(p + 10, true);
    const compressed = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true), extraLen = view.getUint16(p + 30, true), commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(data.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (view.getUint32(local, true) !== LOCAL) throw new Error(`Corrupt zip entry ${name}.`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = data.subarray(start, start + compressed);
    if (method === 0) out.push({ name, bytes: raw.slice() });
    else if (method === 8) out.push({ name, bytes: await inflateRaw(raw) });
    else throw new Error(`${name}: unsupported zip compression (method ${method}).`);
  }
  return out;
}
