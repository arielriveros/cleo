import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The offscreen-capture alpha contract.
 *
 * `present.wgsl` writes `alpha = 1.0` unless `u_alphaFromDepth` says otherwise, and the two call sites
 * that share that program disagree on purpose: the on-screen resolve wants an opaque frame, the
 * offscreen thumbnail wants coverage taken from the scene DEPTH buffer, so an asset composites over the
 * editor's UI and a baked foliage impostor cuts out around its leaves.
 *
 * Uniform-block members persist between writes, so this is not a pair of independent settings — it is
 * ONE piece of state that both passes have to claim every time. Whichever of them forgets inherits the
 * other's value.
 *
 * That is not hypothetical. The thumbnail's write was deleted while the tone-curve and LUT resets were
 * added beside it, so every capture inherited the viewport's 0.0 and came back fully opaque: asset
 * thumbnails gained a black tile behind them, and baked impostors — whose entire job is an alpha cutout
 * — became solid black cards. Nothing failed, because nothing asserted it: `wgslReflection` checks only
 * that the shader DECLARES the member, and `autoExposure` reads this same file but stops at the call.
 *
 * Source-text scanning, for the reason `renderSettingsPersistence` gives: constructing a Renderer needs
 * a GPU. Newlines normalized — see the fix in `b161b49`.
 */

const CRLF = new RegExp(String.raw`\r\n`, 'g');
const RENDERER = readFileSync(join(__dirname, '..', 'src', 'graphics', 'renderer.ts'), 'utf-8')
    .replace(CRLF, '\n');

/** The body of a `private _name(...)` method, up to its closing brace at class indentation. */
function methodBody(name: string): string {
    const start = RENDERER.indexOf(`private ${name}(`);
    expect(start, `${name} not found in renderer.ts`).toBeGreaterThan(-1);
    const rest = RENDERER.slice(start);
    const end = rest.indexOf('\n    }');
    expect(end, `could not find the end of ${name}`).toBeGreaterThan(-1);
    return rest.slice(0, end);
}

/** Lines of renderer.ts containing `needle`. */
const linesWith = (needle: string) => RENDERER.split('\n').filter(l => l.includes(needle));

describe('offscreen capture alpha', () => {
    it('takes thumbnail coverage from the depth buffer', () => {
        // Without this the capture is a solid rectangle the colour of the thumbnail clear, which is
        // transparent BLACK — so the failure reads as a renderer that drew nothing rather than as a
        // missing uniform, and that is what made it survive a release.
        expect(methodBody('_presentThumbnail')).toContain("setUniform('u_alphaFromDepth', 1.0)");
    });

    it('puts the on-screen resolve back to opaque', () => {
        // The other half, and the reason the thumbnail cannot simply set the flag once and leave it:
        // a leaked 1.0 punches the page background through the viewport on every frame after a capture.
        expect(methodBody('_presentPass')).toContain("setUniform('u_alphaFromDepth', 0.0)");
    });

    it('is claimed by every sharer of the present program', () => {
        // A third caller of `_fullscreenPipeline('present', ...)` that did not write the flag would
        // inherit whichever of the two above ran last — the same trap, one level up.
        expect(linesWith("setUniform('u_alphaFromDepth'").length)
            .toBe(linesWith("_fullscreenPipeline('present'").length);
    });
});
