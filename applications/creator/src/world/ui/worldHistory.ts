// The World's undo history. A document is a few kilobytes of JSON, so each step keeps the whole document
// as it was; a slider drag is one step (edits with the same key in quick succession coalesce). A paint
// stroke also keeps the texels it touched, before and after, so undoing it puts the mask back too.

import type { PaintPixels } from '../paint';
import type { WorldDoc } from '../worldDoc';
import { writeRegion, type MaskRegion } from './paint/paintBrush';

export interface PaintEdit {
  maskId: string;
  resolution: number;
  region: MaskRegion;
  before: Float32Array;
  after: Float32Array;
}

interface Entry {
  label: string;
  /** The document on the other side of this step. */
  doc: WorldDoc;
  paint?: PaintEdit;
  key?: string;
  at: number;
}

/** Edits under one key this close together are one step (a slider drag). */
const COALESCE_MS = 1200;
const MAX_STEPS = 200;
/** Paint texels kept, bytes. */
const MAX_PAINT_BYTES = 64 * 2 ** 20;

export class WorldHistory {
  private past: Entry[] = [];
  private future: Entry[] = [];

  /** `prev` is about to be replaced by an edit named `label`. */
  record(prev: WorldDoc, label: string, key?: string): void {
    const now = performance.now();
    const top = this.past[this.past.length - 1];
    if (key && top && !top.paint && top.key === key && now - top.at < COALESCE_MS) {
      top.at = now;
      this.future = [];
      return;
    }
    this.past.push({ label, doc: prev, key, at: now });
    this.future = [];
    this.trim();
  }

  /** A paint stroke on top of `prev` (whose paint meta still has the old hash). */
  recordPaint(prev: WorldDoc, edit: PaintEdit, label = 'Paint'): void {
    this.past.push({ label, doc: prev, paint: edit, at: performance.now() });
    this.future = [];
    this.trim();
  }

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  get undoLabel(): string | undefined { return this.past[this.past.length - 1]?.label; }
  get redoLabel(): string | undefined { return this.future[this.future.length - 1]?.label; }

  /** The document before the last step (and the mask restored in `pixels`), or null. */
  undo(current: WorldDoc, pixels: PaintPixels): { doc: WorldDoc; mask?: string } | null {
    const e = this.past.pop();
    if (!e) return null;
    if (e.paint && pixels[e.paint.maskId]) writeRegion(pixels[e.paint.maskId], e.paint.resolution, e.paint.region, e.paint.before);
    this.future.push({ ...e, doc: current, key: undefined });
    return { doc: e.doc, mask: e.paint?.maskId };
  }

  redo(current: WorldDoc, pixels: PaintPixels): { doc: WorldDoc; mask?: string } | null {
    const e = this.future.pop();
    if (!e) return null;
    if (e.paint && pixels[e.paint.maskId]) writeRegion(pixels[e.paint.maskId], e.paint.resolution, e.paint.region, e.paint.after);
    this.past.push({ ...e, doc: current, key: undefined, at: 0 });
    return { doc: e.doc, mask: e.paint?.maskId };
  }

  /** A different document was opened: its history starts empty. */
  clear(): void {
    this.past = [];
    this.future = [];
  }

  private trim(): void {
    while (this.past.length > MAX_STEPS) this.past.shift();
    let bytes = 0;
    for (let i = this.past.length - 1; i >= 0; i--) {
      const p = this.past[i].paint;
      if (!p) continue;
      bytes += p.before.byteLength + p.after.byteLength;
      if (bytes > MAX_PAINT_BYTES) { this.past.splice(0, i + 1); break; }
    }
  }
}
