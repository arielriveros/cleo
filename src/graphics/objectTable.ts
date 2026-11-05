import { Logger } from '../core/logger';
import { Texture } from './texture';
import { device } from './rhi/deviceHandle';
import type { Texture as RhiTexture } from './rhi/resources';
import { frameStats } from './renderStats';
import {
    OBJECT_TABLE_WIDTH, OBJECT_RECORD_TEXELS, OBJECT_RECORD_FLOATS,
    packObjectRecord, uploadRects,
} from './objectData';

/** What the table needs from the device: the submission count it resets on, and a texel upload. */
export interface ObjectTableBackend {
    readonly submissionEpoch: number;
    writeTexture(texture: RhiTexture, data: ArrayBufferView, width: number, height: number,
                 mipLevel?: number, arrayLayer?: number, x?: number, y?: number): void;
}

/** Records the table starts with: 16 rows of 128 records. */
const INITIAL_ROWS = 16;

function allocateTable(rows: number): Texture {
    const texture = new Texture({
        // Neither renderable nor filterable — what makes rgba32float safe everywhere. See lightGrid.ts.
        format: 'rgba32float', loadOnly: true, mipMap: false,
        minFilter: 'nearest', magFilter: 'nearest', mipMapFilter: 'nearest', wrapping: 'clamp',
    });
    texture.create(null, OBJECT_TABLE_WIDTH, rows);
    return texture;
}

/**
 * The per-object table (see objectData.ts for the record layout), on the GPU and in a CPU staging copy.
 *
 * **Rows are append-only within a submission.** WebGPU puts a `writeTexture` on the queue timeline when
 * it is CALLED, while every draw recorded in the frame encoder runs at the frame's single `submit`: a
 * texel written twice in one submission would be read by every draw with its LAST value. So a record
 * is never rewritten; an object whose data changed mid-submission (a sprite billboarded per pass camera,
 * a capture posing a node) gets a new record. The table starts again at record 0 when the device's
 * `submissionEpoch` moves — on WebGPU when the queue has taken everything recorded (the moment the
 * uniform arenas recycle their slots too), on WebGL2 at every encoder finish (it is immediate).
 *
 * **Growth** allocates a new texture rather than resizing: draws already recorded keep the old one,
 * which still holds every record they name, and it is destroyed at the next epoch. `generation` moves,
 * so a loop that does not set a pipeline per draw knows to rebind.
 */
export class ObjectTable {
    private _texture: Texture | null = null;
    private readonly _retired: Texture[] = [];
    private _rows = 0;
    private _staging = new Float32Array(0);
    /** Records written this epoch, and how many of them are on the GPU. */
    private _count = 0;
    private _uploaded = 0;
    private _epoch = -1;
    private _generation = 0;
    /** Per owner, its record this epoch. Checked by value before reuse. */
    private readonly _owners = new WeakMap<object, { epoch: number; record: number }>();
    private readonly _scratch = new Float32Array(OBJECT_RECORD_FLOATS);

    constructor(private readonly _allocate: (rows: number) => Texture = allocateTable,
                private readonly _backend: () => ObjectTableBackend = () => device as unknown as ObjectTableBackend) {}

    /** The table texture. Allocated on first use. */
    public get texture(): Texture {
        if (!this._texture) this._grow(INITIAL_ROWS);
        return this._texture!;
    }

    /** Moves whenever `texture` is replaced: a bind group naming the old one must be rebuilt. */
    public get generation(): number { return this._generation; }

    /** Records written this epoch. */
    public get count(): number { this._sync(); return this._count; }

    /** The submission epoch the records belong to: a record index is valid only while this is unchanged. */
    public get epoch(): number { this._sync(); return this._epoch; }

    /** Bytes of GPU storage (the live texture; retired ones last one epoch). */
    public get gpuBytes(): number { return this._rows * OBJECT_TABLE_WIDTH * 16; }

    /**
     * The record for `owner` with this data, appended unless the owner already has an identical one
     * this epoch, or the last record written is identical (a landscape's chunks, which share a matrix,
     * collapse to one). NOT uploaded — call {@link flush} before the draws that read it, or use
     * {@link rowFor}.
     */
    public ensure(owner: object, model: ArrayLike<number>, dissolve: number, holeOptIn: boolean, palette = 0,
                  uvScaleX = 1, uvScaleY = 1, uvOffsetX = 0, uvOffsetY = 0): number {
        this._sync();
        const scratch = this._scratch;
        packObjectRecord(scratch, 0, model, dissolve, holeOptIn, palette, uvScaleX, uvScaleY, uvOffsetX, uvOffsetY);
        const known = this._owners.get(owner);
        if (known && known.epoch === this._epoch && this._matches(known.record)) return known.record;
        let record: number;
        if (this._count > 0 && this._matches(this._count - 1)) record = this._count - 1;
        else {
            record = this._append();
            this._staging.set(scratch, record * OBJECT_RECORD_FLOATS);
        }
        if (known) { known.epoch = this._epoch; known.record = record; }
        else this._owners.set(owner, { epoch: this._epoch, record });
        return record;
    }

    /** {@link ensure}, then upload what is pending: what a draw path that prepared nothing calls. */
    public rowFor(owner: object, model: ArrayLike<number>, dissolve: number, holeOptIn: boolean, palette = 0,
                  uvScaleX = 1, uvScaleY = 1, uvOffsetX = 0, uvOffsetY = 0): number {
        const record = this.ensure(owner, model, dissolve, holeOptIn, palette, uvScaleX, uvScaleY, uvOffsetX, uvOffsetY);
        if (this._uploaded < this._count) this.flush();
        return record;
    }

    /** Upload every record written since the last flush: at most three rectangles, usually one. */
    public flush(): void {
        this._sync();
        if (this._uploaded >= this._count) return;
        const texture = this.texture;
        const backend = this._backend();
        for (const r of uploadRects(this._uploaded * OBJECT_RECORD_TEXELS, this._count * OBJECT_RECORD_TEXELS)) {
            backend.writeTexture(texture.rhiTexture, this._staging.subarray(r.offset, r.offset + r.width * r.height * 4),
                                 r.width, r.height, 0, 0, r.x, r.y);
            frameStats.objectUploads++;
            frameStats.objectUploadBytes += r.width * r.height * 16;
        }
        frameStats.objectRows += this._count - this._uploaded;
        this._uploaded = this._count;
    }

    private _matches(record: number): boolean {
        const s = this._scratch, data = this._staging, base = record * OBJECT_RECORD_FLOATS;
        for (let i = 0; i < OBJECT_RECORD_FLOATS; i++) if (data[base + i] !== s[i]) return false;
        return true;
    }

    /** Claim the next record, growing the table if it is full. */
    private _append(): number {
        if (!this._texture) this._grow(INITIAL_ROWS);
        const capacity = (this._rows * OBJECT_TABLE_WIDTH) / OBJECT_RECORD_TEXELS;
        if (this._count >= capacity) this._grow(this._rows * 2);
        return this._count++;
    }

    private _grow(rows: number): void {
        const max = device?.capabilities?.maxTextureSize ?? 8192;
        if (rows > max) throw new Error(`ObjectTable: ${rows} rows exceeds the device's ${max}`);
        const staging = new Float32Array(rows * OBJECT_TABLE_WIDTH * 4);
        staging.set(this._staging.subarray(0, Math.min(this._staging.length, this._count * OBJECT_RECORD_FLOATS)));
        this._staging = staging;
        if (this._texture) this._retired.push(this._texture);
        this._texture = this._allocate(rows);
        this._rows = rows;
        this._uploaded = 0;          // the new texture holds nothing yet
        this._generation++;
        if (rows > INITIAL_ROWS)
            Logger.print('info', [`Object table: ${OBJECT_TABLE_WIDTH}x${rows} rgba32float`], 'ObjectTable');
    }

    /** Start again at record 0 when the device has taken everything recorded against this epoch. */
    private _sync(): void {
        const epoch = this._backend().submissionEpoch;
        if (epoch === this._epoch) return;
        this._epoch = epoch;
        this._count = 0;
        this._uploaded = 0;
        for (const old of this._retired) old.delete();
        this._retired.length = 0;
    }

    public dispose(): void {
        this._texture?.delete();
        this._texture = null;
        for (const old of this._retired) old.delete();
        this._retired.length = 0;
    }
}
