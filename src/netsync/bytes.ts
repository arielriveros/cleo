// Little binary codec for NetSync messages (docs/design/netsync.md). Big-endian, no alignment, no schema:
// each message type writes and reads its own fields in order. Dependency-free, so it runs in the browser,
// in a worker and in the Node host alike.

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Appends fields to a growable buffer. `finish()` returns exactly the bytes written. */
export class ByteWriter {
    private _buf: Uint8Array;
    private _view: DataView;
    private _length = 0;

    constructor(capacity: number = 64) {
        this._buf = new Uint8Array(Math.max(8, capacity));
        this._view = new DataView(this._buf.buffer);
    }

    /** Bytes written so far. */
    public get length(): number { return this._length; }

    public u8(v: number): this { this._reserve(1); this._buf[this._length++] = v; return this; }
    public u16(v: number): this { this._reserve(2); this._view.setUint16(this._length, v); this._length += 2; return this; }
    public u32(v: number): this { this._reserve(4); this._view.setUint32(this._length, v >>> 0); this._length += 4; return this; }
    public f64(v: number): this { this._reserve(8); this._view.setFloat64(this._length, v); this._length += 8; return this; }

    /** Unsigned LEB128, for counts and lengths: 1 byte below 128. Integers up to 2^53. */
    public varUint(v: number): this {
        if (!Number.isInteger(v) || v < 0 || v > Number.MAX_SAFE_INTEGER) throw new RangeError(`varUint: ${v}`);
        while (v >= 0x80) {
            this.u8((v % 0x80) | 0x80);
            v = Math.floor(v / 0x80);
        }
        return this.u8(v);
    }

    /** UTF-8 with a varUint byte-length prefix. */
    public string(s: string): this { return this.bytes(textEncoder.encode(s)); }

    /** Raw bytes with a varUint length prefix. */
    public bytes(b: Uint8Array): this { this.varUint(b.length); return this.raw(b); }

    /** Raw bytes, no prefix. */
    public raw(b: Uint8Array): this {
        this._reserve(b.length);
        this._buf.set(b, this._length);
        this._length += b.length;
        return this;
    }

    /** A copy of the bytes written. The writer can keep going afterwards. */
    public finish(): Uint8Array { return this._buf.slice(0, this._length); }

    private _reserve(n: number): void {
        if (this._length + n <= this._buf.length) return;
        let size = this._buf.length * 2;
        while (size < this._length + n) size *= 2;
        const next = new Uint8Array(size);
        next.set(this._buf.subarray(0, this._length));
        this._buf = next;
        this._view = new DataView(next.buffer);
    }
}

/** Reads fields in the order a {@link ByteWriter} wrote them. Throws a RangeError on reading past the end. */
export class ByteReader {
    private readonly _view: DataView;
    private _pos: number;

    constructor(private readonly _bytes: Uint8Array, offset: number = 0) {
        this._view = new DataView(_bytes.buffer, _bytes.byteOffset, _bytes.byteLength);
        this._pos = offset;
    }

    public get position(): number { return this._pos; }
    public get remaining(): number { return this._bytes.length - this._pos; }

    public u8(): number { this._need(1); return this._bytes[this._pos++]; }
    public u16(): number { this._need(2); const v = this._view.getUint16(this._pos); this._pos += 2; return v; }
    public u32(): number { this._need(4); const v = this._view.getUint32(this._pos); this._pos += 4; return v; }
    public f64(): number { this._need(8); const v = this._view.getFloat64(this._pos); this._pos += 8; return v; }

    public varUint(): number {
        let result = 0;
        let scale = 1;
        for (let i = 0; i < 8; i++) {
            const b = this.u8();
            result += (b & 0x7f) * scale;
            if ((b & 0x80) === 0) return result;
            scale *= 0x80;
        }
        throw new RangeError('varUint: too long');
    }

    public string(): string { return textDecoder.decode(this.bytes()); }

    /** A view (not a copy) of the next length-prefixed bytes. */
    public bytes(): Uint8Array { return this.raw(this.varUint()); }

    /** A view (not a copy) of the next `n` bytes. */
    public raw(n: number): Uint8Array {
        this._need(n);
        const out = this._bytes.subarray(this._pos, this._pos + n);
        this._pos += n;
        return out;
    }

    private _need(n: number): void {
        if (this._pos + n > this._bytes.length) {
            throw new RangeError(`read past end: need ${n} at ${this._pos} of ${this._bytes.length}`);
        }
    }
}
