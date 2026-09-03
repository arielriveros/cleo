import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Where a depth copy sits in the frame's command stream.
 *
 * `_copyDepth` is the only helper in the renderer that CONSUMES what the frame has already drawn —
 * the deferred G-buffer depth handed to the forward overlay, the opaque snapshot the post passes and
 * TAA read, and the coverage an offscreen capture resolves its alpha from. Every other self-contained
 * encoder in the tree (the cloud noise bake, the mesh displacer, the channel packer, the shadow-layer
 * clear) only PRODUCES data, so submitting early is fine or even required for those.
 *
 * That distinction is the whole test. On WebGPU `finish()` submits, while the frame's render passes
 * sit unsubmitted in `_frameEncoder` until the end of the frame — so a copy on its own encoder runs
 * BEFORE every draw it was meant to copy. In a live viewport that reads as the previous frame's depth,
 * which a barely-moving camera makes look almost right; in an offscreen capture, which resizes every
 * target and renders exactly one frame, it reads a freshly allocated buffer. Zeroed, which is depth 0,
 * which is "covered" — so every thumbnail and every baked impostor came back a solid opaque rectangle
 * on WebGPU while WebGL2, whose commands execute as they are issued, was correct.
 *
 * Source-text scanning, for the reason `renderSettingsPersistence` gives: constructing a Renderer
 * needs a GPU. Newlines normalized — see the fix in `b161b49`.
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

describe('_copyDepth', () => {
    it('records into the frame encoder rather than opening its own', () => {
        const body = methodBody('_copyDepth');
        expect(body).toContain("this._acquireEncoder('copyDepth')");
        // The literal is what the bug was. `_acquireEncoder` falls back to it when no frame is open,
        // which is the only legitimate way this helper may reach it.
        expect(body).not.toContain('device.createCommandEncoder');
    });

    it('finishes only an encoder it owns', () => {
        // `_endFullscreenPass` makes exactly this distinction for passes, and for the same reason:
        // finishing the FRAME encoder mid-frame submits everything recorded so far and leaves the rest
        // of the frame recording into a spent object.
        expect(methodBody('_copyDepth')).toContain('if (encoder !== this._frameEncoder) encoder.finish()');
    });

    it('is what the capture path resolves its coverage from', () => {
        // The chain that made this visible: the thumbnail branch snapshots, then resolves alpha from
        // the snapshot. If either half moves, the other is no longer guarded by the two cases above.
        const post = methodBody('_applyPostProcessing');
        const branch = post.slice(post.indexOf('if (this._presentTarget)'));
        expect(branch.indexOf('this._copySceneDepth()')).toBeGreaterThan(-1);
        expect(branch.indexOf('this._copySceneDepth()'))
            .toBeLessThan(branch.indexOf('this._presentThumbnail()'));
        expect(methodBody('_presentThumbnail')).toContain('this._depthSource()');
    });
});
