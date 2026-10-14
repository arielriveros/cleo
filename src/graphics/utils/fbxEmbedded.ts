// What a BINARY .fbx says about its materials' textures — read straight from the file's node records, in
// milliseconds, without assimp.
//
// The .fbx route converts to glTF2 with assimp, and that exporter keeps the base colour and drops the
// rest (normal, specular, ambient maps). They used to be recovered with a SECOND full assimp pass to
// assjson: on a 120 MB Mixamo character that was ~45 s — most of it assimpjs copying the file into WASM
// one byte at a time — and a JSON string big enough to run the WASM heap out of memory. And it only
// returned the maps' FILE NAMES, which the importer then looked for among the uploaded files, so
// textures that were embedded in the .fbx all along were reported as "missing, link them manually".
//
// The FBX binary layout is simple and stable (a tree of node records with typed properties), and the
// three things needed live in two subtrees:
//
//   Objects/Video      an embedded image: `RelativeFilename`, and `Content` (the file's raw bytes)
//   Objects/Texture    a texture slot's image: `RelativeFilename` / `FileName`
//   Objects/Material   a material, by id and name
//   Connections/C      "OP" texture -> material, property "DiffuseColor" | "NormalMap" | ...;
//                      "OO" video -> texture
//
// Never throws on a malformed or ASCII file: it returns null and the caller falls back.

export interface FbxEmbeddedImage {
    /** Basename of the image as the authoring tool named it (`Ch05_1001_Normal.png`). */
    name: string;
    bytes: Uint8Array;
    mime: string;
}

export interface FbxMaterialTextures {
    /** The material's name as written in the file (assimp keeps it, so it names the glTF material too). */
    name: string;
    /** FBX property name (`DiffuseColor`, `NormalMap`, `Bump`, `SpecularColor`, ...) -> image basename. */
    slots: Record<string, string>;
}

export interface FbxTextureInfo {
    embedded: FbxEmbeddedImage[];
    materials: FbxMaterialTextures[];
}

interface FbxNode {
    name: string;
    props: (number | bigint | string | Uint8Array | null)[];
    children: FbxNode[];
}

const MAGIC = 'Kaydara FBX Binary  \u0000';

/** True when the bytes are a binary FBX. */
export function isBinaryFbx(bytes: Uint8Array): boolean {
    if (bytes.length < 27) return false;
    for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC.charCodeAt(i)) return false;
    return true;
}

/** The basename of an authoring path (`..\..\tmp\skins.fbm\Ch05_1001_Normal.png` -> `Ch05_1001_Normal.png`). */
export function fbxBaseName(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Read the embedded images and the material -> texture slots of a binary FBX, or null when the bytes
 * are not one (or are damaged). Only the `Objects` and `Connections` subtrees are decoded; geometry
 * arrays are skipped over by their byte length and never read.
 */
export function readFbxTextures(bytes: Uint8Array): FbxTextureInfo | null {
    try {
        if (!isBinaryFbx(bytes)) return null;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const version = view.getUint32(23, true);
        const wide = version >= 7500;
        const top = readChildren(bytes, view, 27, bytes.length, wide, name => name === 'Objects' || name === 'Connections');
        const objects = top.find(n => n.name === 'Objects');
        const connections = top.find(n => n.name === 'Connections');
        if (!objects) return null;
        return assemble(objects, connections);
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------------------------------
// Records

/**
 * Node records from `offset` up to `end`. A record's children are only decoded when `descend(name)`
 * says so (at the top level); below that, everything is decoded — the Objects subtree's leaves are small
 * except Content and geometry arrays, and arrays are skipped without inflating.
 */
function readChildren(bytes: Uint8Array, view: DataView, offset: number, end: number, wide: boolean,
                      descend?: (name: string) => boolean): FbxNode[] {
    const out: FbxNode[] = [];
    const headerLen = wide ? 25 : 13;
    while (offset + headerLen <= end) {
        const endOffset = wide ? Number(view.getBigUint64(offset, true)) : view.getUint32(offset, true);
        const numProps = wide ? Number(view.getBigUint64(offset + 8, true)) : view.getUint32(offset + 4, true);
        const propLen = wide ? Number(view.getBigUint64(offset + 16, true)) : view.getUint32(offset + 8, true);
        const nameLen = bytes[offset + (wide ? 24 : 12)];
        if (endOffset === 0) break;                                // the null record that closes a list
        if (endOffset > bytes.length || endOffset <= offset) throw new Error('bad FBX record');
        const nameStart = offset + headerLen;
        const name = ascii(bytes, nameStart, nameLen);
        const propsStart = nameStart + nameLen;
        const childrenStart = propsStart + propLen;

        const wanted = !descend || descend(name);
        const node: FbxNode = { name, props: wanted ? readProps(bytes, view, propsStart, numProps) : [], children: [] };
        if (wanted && childrenStart < endOffset)
            node.children = readChildren(bytes, view, childrenStart, endOffset, wide);
        out.push(node);
        offset = endOffset;
    }
    return out;
}

function readProps(bytes: Uint8Array, view: DataView, offset: number, count: number): FbxNode['props'] {
    const props: FbxNode['props'] = [];
    for (let i = 0; i < count; i++) {
        const type = String.fromCharCode(bytes[offset++]);
        switch (type) {
            case 'Y': props.push(view.getInt16(offset, true)); offset += 2; break;
            case 'C': props.push(bytes[offset]); offset += 1; break;
            case 'I': props.push(view.getInt32(offset, true)); offset += 4; break;
            case 'F': props.push(view.getFloat32(offset, true)); offset += 4; break;
            case 'D': props.push(view.getFloat64(offset, true)); offset += 8; break;
            case 'L': props.push(view.getBigInt64(offset, true)); offset += 8; break;
            case 'S': {
                const len = view.getUint32(offset, true);
                props.push(utf8(bytes, offset + 4, len));
                offset += 4 + len;
                break;
            }
            case 'R': {
                const len = view.getUint32(offset, true);
                // A copy, not a view: the result is transferred out of the worker on its own buffer.
                props.push(bytes.slice(offset + 4, offset + 4 + len));
                offset += 4 + len;
                break;
            }
            case 'f': case 'd': case 'l': case 'i': case 'b': {
                // Arrays (geometry, weights): skipped by length, never inflated — not needed here.
                const compressedLen = view.getUint32(offset + 8, true);
                props.push(null);
                offset += 12 + compressedLen;
                break;
            }
            default:
                throw new Error(`unknown FBX property type ${type}`);
        }
    }
    return props;
}

const ascii = (b: Uint8Array, start: number, len: number) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(b[start + i]);
    return s;
};
const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
const utf8 = (b: Uint8Array, start: number, len: number) =>
    decoder ? decoder.decode(b.subarray(start, start + len)) : ascii(b, start, len);

// ---------------------------------------------------------------------------------------------------
// Objects + Connections -> images and material slots

/** "Name\x00\x01Class" -> "Name": the binary format's name/class separator. */
const objectName = (raw: unknown) => String(raw ?? '').split('\u0000\u0001')[0];
const idOf = (raw: unknown) => (typeof raw === 'bigint' ? raw.toString() : String(raw));
const child = (node: FbxNode, name: string) => node.children.find(c => c.name === name);
const stringChild = (node: FbxNode, ...names: string[]) => {
    for (const n of names) {
        const v = child(node, n)?.props[0];
        if (typeof v === 'string' && v) return v;
    }
    return '';
};

function mimeOf(bytes: Uint8Array, name: string): string | null {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    const ext = name.toLowerCase().split('.').pop();
    if (ext === 'png') return 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'webp') return 'image/webp';
    return null;   // TGA, DDS, PSD: the browser cannot decode them
}

function assemble(objects: FbxNode, connections: FbxNode | undefined): FbxTextureInfo {
    const videos = new Map<string, { name: string; content: Uint8Array | null }>();
    const textures = new Map<string, string>();         // texture id -> image basename
    const materials = new Map<string, FbxMaterialTextures>();
    const materialOrder: string[] = [];

    for (const o of objects.children) {
        const id = idOf(o.props[0]);
        if (o.name === 'Video') {
            const file = stringChild(o, 'RelativeFilename', 'Filename', 'FileName');
            const content = child(o, 'Content')?.props[0];
            videos.set(id, { name: fbxBaseName(file || objectName(o.props[1])), content: content instanceof Uint8Array && content.length ? content : null });
        } else if (o.name === 'Texture') {
            const file = stringChild(o, 'RelativeFilename', 'FileName', 'Filename');
            if (file) textures.set(id, fbxBaseName(file));
        } else if (o.name === 'Material') {
            materials.set(id, { name: objectName(o.props[1]), slots: {} });
            materialOrder.push(id);
        }
    }

    for (const c of connections?.children ?? []) {
        if (c.name !== 'C') continue;
        const kind = c.props[0], src = idOf(c.props[1]), dst = idOf(c.props[2]);
        if (kind === 'OP' && textures.has(src) && materials.has(dst)) {
            const property = String(c.props[3] ?? '');
            if (property) materials.get(dst)!.slots[property] = textures.get(src)!;
        } else if (kind === 'OO' && videos.has(src) && textures.has(dst)) {
            // A texture whose file name is empty takes its video's.
            if (!textures.get(dst)) textures.set(dst, videos.get(src)!.name);
        }
    }

    // One image per basename: the same file is commonly embedded once per texture that uses it.
    const embedded: FbxEmbeddedImage[] = [];
    const seen = new Set<string>();
    for (const v of videos.values()) {
        if (!v.content || seen.has(v.name.toLowerCase())) continue;
        const mime = mimeOf(v.content, v.name);
        if (!mime) continue;
        seen.add(v.name.toLowerCase());
        embedded.push({ name: v.name, bytes: v.content, mime });
    }

    return { embedded, materials: materialOrder.map(id => materials.get(id)!) };
}

// ---------------------------------------------------------------------------------------------------
// Stripping the embedded images out before assimp sees the file

/**
 * A copy of a binary FBX with every `Video/Content` blob emptied, or null when the bytes are not a
 * binary FBX (or stripping would change nothing).
 *
 * Why: assimpjs copies its input into WASM ONE BYTE AT A TIME (its `AddFile` binding goes through
 * `vecFromJSArray`), which measured 43 s for a 120 MB Mixamo character — and 110 MB of that file was
 * its own embedded PNGs, which the importer reads with {@link readFbxTextures} anyway. Without them
 * assimp gets a 10 MB file, writes the textures as plain file references, and the assembler resolves
 * those names against the embedded images.
 *
 * Every record is re-serialised with its end offset recomputed (they are absolute file positions, so
 * removing bytes anywhere shifts every later record); property bytes, the null-record terminators and
 * the footer are copied verbatim.
 */
export function stripFbxEmbeddedContent(bytes: Uint8Array): Uint8Array | null {
    try {
        if (!isBinaryFbx(bytes)) return null;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const wide = view.getUint32(23, true) >= 7500;
        const headerLen = wide ? 25 : 13;
        const out = new ByteSink(bytes.length);
        out.write(bytes.subarray(0, 27));
        let stripped = 0;

        // Serialise the records from `offset` until a null record or `end`; returns where reading stopped.
        const writeList = (offset: number, end: number, parent: string): number => {
            while (offset + headerLen <= end) {
                const endOffset = wide ? Number(view.getBigUint64(offset, true)) : view.getUint32(offset, true);
                if (endOffset === 0) return offset;
                const numProps = wide ? Number(view.getBigUint64(offset + 8, true)) : view.getUint32(offset + 4, true);
                const propLen = wide ? Number(view.getBigUint64(offset + 16, true)) : view.getUint32(offset + 8, true);
                const nameLen = bytes[offset + headerLen - 1];
                const nameStart = offset + headerLen;
                const name = ascii(bytes, nameStart, nameLen);
                const propsStart = nameStart + nameLen, childrenStart = propsStart + propLen;

                const recordStart = out.length;
                out.write(bytes.subarray(offset, nameStart + nameLen));      // header (patched below) + name
                let newPropLen = propLen;
                if (parent === 'Video' && name === 'Content' && numProps === 1 && bytes[propsStart] === 0x52 /* R */) {
                    const len = view.getUint32(propsStart + 1, true);
                    out.write(new Uint8Array([0x52, 0, 0, 0, 0]));
                    newPropLen = 5;
                    stripped += len;
                } else {
                    out.write(bytes.subarray(propsStart, childrenStart));
                }
                // Children, then whatever closes the record (its null-record terminator) verbatim.
                const stop = childrenStart < endOffset ? writeList(childrenStart, endOffset, name) : childrenStart;
                out.write(bytes.subarray(stop, endOffset));
                out.patchHeader(recordStart, wide, out.length, numProps, newPropLen);
                offset = endOffset;
            }
            return offset;
        };
        const stop = writeList(27, bytes.length, '');
        out.write(bytes.subarray(stop));                                    // top-level terminator + footer
        return stripped > 0 ? out.result() : null;
    } catch {
        return null;
    }
}

/** A growable byte buffer with in-place header patching. */
class ByteSink {
    private _buf: Uint8Array;
    public length = 0;
    constructor(capacity: number) { this._buf = new Uint8Array(Math.max(1024, capacity)); }
    write(chunk: Uint8Array): void {
        if (this.length + chunk.length > this._buf.length) {
            const next = new Uint8Array(Math.max(this._buf.length * 2, this.length + chunk.length));
            next.set(this._buf.subarray(0, this.length));
            this._buf = next;
        }
        this._buf.set(chunk, this.length);
        this.length += chunk.length;
    }
    patchHeader(at: number, wide: boolean, endOffset: number, numProps: number, propLen: number): void {
        const v = new DataView(this._buf.buffer, this._buf.byteOffset + at, wide ? 24 : 12);
        if (wide) {
            v.setBigUint64(0, BigInt(endOffset), true);
            v.setBigUint64(8, BigInt(numProps), true);
            v.setBigUint64(16, BigInt(propLen), true);
        } else {
            v.setUint32(0, endOffset, true);
            v.setUint32(4, numProps, true);
            v.setUint32(8, propLen, true);
        }
    }
    result(): Uint8Array { return this._buf.slice(0, this.length); }
}
