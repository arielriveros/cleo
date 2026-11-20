// The film gate: where the reference video sits in the viewport. The whole frame, as large as fits, centred
// ("contain"), optionally moved and zoomed (a crop to the subject, a shifted principal point). Shared by the
// DOM overlay, the engine backdrop and the calibration overlay, so the three agree to the pixel.

export interface Rect { x: number; y: number; w: number; h: number; }

/**
 * The video's rectangle in a `viewW`×`viewH` viewport: contain-fit, then `zoom` about the centre of `focus`
 * (a rectangle in the video's own unit square, [0..1] both ways, y down), so a zoom onto the subject keeps
 * the subject centred. No zoom: the whole frame, centred.
 */
export function gateRect(viewW: number, viewH: number, videoW: number, videoH: number,
                         crop?: { x: number; y: number; w: number; h: number } | null): Rect {
  const vw = Math.max(1, viewW), vh = Math.max(1, viewH);
  const aspect = Math.max(1e-6, videoW) / Math.max(1e-6, videoH);
  const fitW = Math.min(vw, vh * aspect), fitH = fitW / aspect;
  if (!crop || crop.w <= 0 || crop.h <= 0) return { x: (vw - fitW) / 2, y: (vh - fitH) / 2, w: fitW, h: fitH };
  // The crop fills the viewport (contain), the rest of the frame continuing past it.
  const cropAspect = (crop.w * videoW) / (crop.h * videoH);
  const cw = Math.min(vw, vh * cropAspect), scale = cw / (crop.w * fitW);
  const w = fitW * scale, h = fitH * scale;
  const cx = (crop.x + crop.w / 2) * w, cy = (crop.y + crop.h / 2) * h;
  return { x: vw / 2 - cx, y: vh / 2 - cy, w, h };
}

/** A point in the video's pixels to the viewport, through the gate. */
export function videoToView(p: readonly [number, number], gate: Rect, videoW: number, videoH: number): [number, number] {
  return [gate.x + (p[0] / videoW) * gate.w, gate.y + (p[1] / videoH) * gate.h];
}

/** A viewport point to the video's pixels, through the gate. */
export function viewToVideo(p: readonly [number, number], gate: Rect, videoW: number, videoH: number): [number, number] {
  return [((p[0] - gate.x) / gate.w) * videoW, ((p[1] - gate.y) / gate.h) * videoH];
}
