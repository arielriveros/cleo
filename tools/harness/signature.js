// Perceptual frame signatures, shared by the harness drivers.
//
// A frame is reduced to an 8x8 grid of cells, two numbers each: mean luma and standard deviation.
//
// The mean alone is not enough, and this was measured rather than assumed — with mean-only signatures,
// SSAO and a half-resolution render both came out *identical to base*. That is not because nothing
// happened; it is because a blur preserves local means almost exactly. Since the passes most likely to
// change under a shader rewrite are blurs (bloom down/upsample, gaussian, SSAO blur, motion-blur
// gather), a statistic blind to blur would be a gate that could not fail.
//
// Standard deviation is the sharpness of a cell, so it moves when a blur radius changes, when an
// upsample weight is wrong, or when a resolution-dependent pass reads the wrong texel size.

const GRID = 8;

/** One quantisation step. Cells sitting exactly on a boundary flip reproducibly between runs. */
const NOISE = 4;

function signature(bitmap, width, height) {
    const cells = [];
    const q = (v) => Math.min(255, Math.max(0, Math.round(v / 4) * 4)).toString(16).padStart(2, '0');

    for (let gy = 0; gy < GRID; gy++) {
        for (let gx = 0; gx < GRID; gx++) {
            const x0 = Math.floor(gx * width / GRID), x1 = Math.floor((gx + 1) * width / GRID);
            const y0 = Math.floor(gy * height / GRID), y1 = Math.floor((gy + 1) * height / GRID);
            let sum = 0, sumSq = 0, n = 0;
            for (let y = y0; y < y1; y++) {
                for (let x = x0; x < x1; x++) {
                    const i = (y * width + x) * 4;               // BGRA
                    const luma = 0.2126 * bitmap[i + 2] + 0.7152 * bitmap[i + 1] + 0.0722 * bitmap[i];
                    sum += luma; sumSq += luma * luma; n++;
                }
            }
            const mean = sum / Math.max(1, n);
            // Scaled up, because a cell's deviation is small next to its mean and would otherwise
            // quantise away entirely at the same step size.
            const sd = Math.sqrt(Math.max(0, sumSq / Math.max(1, n) - mean * mean)) * 2;
            cells.push(q(mean), q(sd));
        }
    }
    return cells.join('');
}

/**
 * Compare two signatures.
 *
 * `differing` counts every value that moved at all — used to prove a pass DID something. `material`
 * counts only values that moved by more than the noise floor, and is what a baseline mismatch is judged
 * on. Keeping both means "the pass ran" and "it still renders the same" stay separate questions.
 */
function compare(a, b) {
    let differing = 0, material = 0, worst = 0;
    const values = a.length / 2;
    for (let i = 0; i < values; i++) {
        const x = parseInt(a.slice(i * 2, i * 2 + 2), 16);
        const y = parseInt(b.slice(i * 2, i * 2 + 2), 16);
        const delta = Math.abs(x - y);
        if (delta > 0) differing++;
        if (delta > NOISE) material++;
        worst = Math.max(worst, delta);
    }
    return { differing, material, worst };
}

/**
 * Capture the window and reduce it to a signature.
 *
 * The throwaway capture is not superstition: capturePage returns the last COMPOSITED frame, so it lags
 * a state change by one call, and measuring once produced a clean off-by-one where a changed frame
 * showed up in the next reading.
 */
/**
 * Capture and reduce. `rect` ({x, y, width, height}) crops BEFORE the grid is laid down, which is the
 * only way to see an effect that is large per-pixel but small in area.
 *
 * The arithmetic is the whole reason it exists. At the standard 1000x700 window a full-frame cell is
 * ~125x87 = 10,875 pixels, so a highlight covering 300 of them has to shift those pixels by most of the
 * luma range to move that cell's quantised mean by one step. It was MEASURED that this hides the area
 * lights completely: toggling a 5 cm `sourceRadius` between 0.05 and 0 moves ZERO of the 128 values even
 * against a mirror-finish sphere, 0.5 m moves zero, and it takes a 1 m bulb to move two. Cropping to a
 * 120x120 box around the object turns the same grid into 15x15 cells and the same highlight into most
 * of one, which is a difference of roughly 700x in sensitivity for no new machinery.
 *
 * Electron's `capturePage` takes the rect itself, and `signature` already takes its own width/height, so
 * nothing downstream changes.
 */
async function captureSignature(win, sleep, rect) {
    await win.webContents.capturePage();
    await sleep(300);
    const img = await win.webContents.capturePage(rect);
    const size = img.getSize();
    return signature(img.toBitmap(), size.width, size.height);
}

module.exports = { signature, compare, captureSignature, NOISE, GRID };
