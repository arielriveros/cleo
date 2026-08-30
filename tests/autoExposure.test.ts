import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REFERENCE_ILLUMINANCE } from '../src/graphics/lighting';

/**
 * The auto-exposure maths, ported to JS so the parts that are easy to get wrong can be checked without
 * a GPU or a frame clock.
 *
 * Three of them are worth pinning.
 *
 * The EV100 relation is phase 1's keystone — `exposure = REFERENCE_ILLUMINANCE / (1.2 * 2^EV100)`, with
 * EV100 15 landing exactly on the historical default of 2.0. Auto-exposure now WRITES `_exposure`
 * through that relation every frame, so an error here does not merely mis-expose: it moves every light
 * in the engine relative to the value the migration was built around.
 *
 * The log-luminance encode exists only because `readPixels` refuses a float target on WebGL2, and a
 * window that disagrees between the shader and the CPU is silent — the exposure would simply settle
 * somewhere wrong, which looks like a taste problem rather than a bug.
 *
 * And the adaptation must be FRAME-RATE INDEPENDENT. The naive `value += (target - value) * dt * k`
 * adapts twice as fast at 120fps as at 60, so a scene's look would depend on the machine running it.
 * That is the classic way an exponential smoother goes wrong and it is invisible on one machine.
 */

/** Must match `LOG_LUM_MIN` / `LOG_LUM_MAX` in exposureMeter.wgsl and `LOG_LUMINANCE_WINDOW`. */
const LOG_LUM_MIN = -12;
const LOG_LUM_MAX = 8;
const KEY = 0.18;

const exposureForEV = (ev: number) => REFERENCE_ILLUMINANCE / (1.2 * Math.pow(2, ev));
const evForExposure = (e: number) => Math.log2(REFERENCE_ILLUMINANCE / (1.2 * Math.max(1e-6, e)));

/** The shader's encode, and the renderer's decode. */
const encode = (luminance: number) =>
    Math.min(1, Math.max(0, (Math.log2(Math.max(luminance, 1e-6)) - LOG_LUM_MIN) / (LOG_LUM_MAX - LOG_LUM_MIN)));
const decode = (t: number) => Math.pow(2, LOG_LUM_MIN + t * (LOG_LUM_MAX - LOG_LUM_MIN));

/** `_onExposureSample`: average luminance to the EV the adaptation chases. */
const targetEVFor = (avgLuminance: number) =>
    evForExposure(KEY / Math.max(avgLuminance, 1e-9));

/** `_clampExposureEV`. */
const clampEV = (ev: number, lo: number, hi: number, compensation: number) =>
    Math.min(Math.max(hi, lo), Math.max(Math.min(lo, hi), ev)) - compensation;

/** `_adaptExposure`, one step. `speed` is a RATE: higher adapts faster, as in Unreal. */
const step = (currentEV: number, targetEV: number, dt: number, speed: number) => {
    const t = speed <= 0 ? 1 : 1 - Math.exp(-Math.max(0, dt) * speed);
    return currentEV + (targetEV - currentEV) * t;
};

describe('the EV100 relation auto-exposure writes through', () => {
    it('still puts EV100 15 at exactly the historical default exposure', () => {
        // If this moves, every photometric light in the engine moves with it — the migration in phase 1
        // is calibrated on the pair (EV100 15, exposure 2.0).
        expect(exposureForEV(15)).toBeCloseTo(2.0, 10);
        expect(evForExposure(2.0)).toBeCloseTo(15, 10);
    });

    it('round-trips across the whole authorable range', () => {
        for (let ev = -4; ev <= 20; ev += 0.5)
            expect(evForExposure(exposureForEV(ev))).toBeCloseTo(ev, 9);
    });

    it('is a stop per unit, in the direction a photographer expects', () => {
        // One EV up is half the exposure: a brighter scene metered means a darker setting.
        expect(exposureForEV(16)).toBeCloseTo(exposureForEV(15) / 2, 10);
        expect(exposureForEV(14)).toBeCloseTo(exposureForEV(15) * 2, 10);
    });
});

describe('the log-luminance encode', () => {
    it('round-trips through 8 bits to better than a tenth of a stop', () => {
        // The number comes back as one byte, because readPixels refuses a float target on WebGL2.
        let worstStops = 0;
        for (let log2L = LOG_LUM_MIN; log2L <= LOG_LUM_MAX; log2L += 0.13) {
            const L = Math.pow(2, log2L);
            const quantised = Math.round(encode(L) * 255) / 255;
            worstStops = Math.max(worstStops, Math.abs(Math.log2(decode(quantised)) - log2L));
        }
        // 20 stops over 255 steps is 0.078 per step, so half a step is the floor.
        expect(worstStops).toBeLessThan(0.05);
    });

    it('saturates rather than wrapping outside the window', () => {
        expect(encode(Math.pow(2, LOG_LUM_MAX + 5))).toBe(1);
        expect(encode(Math.pow(2, LOG_LUM_MIN - 5))).toBe(0);
        // A black pixel must not encode to -Infinity and poison the average.
        expect(Number.isFinite(encode(0))).toBe(true);
    });

    it('covers the range an internal-radiance scene actually spans', () => {
        // A white lit surface sits near 0.3 and the sun's specular can reach the tens; the window has
        // to hold both with room to spare, or the meter clamps and stops responding.
        for (const L of [1e-3, 0.05, 0.3, 1, 30, 200])
            expect(encode(L)).toBeGreaterThan(0), expect(encode(L)).toBeLessThan(1);
    });
});

describe('metering to a target EV', () => {
    it('places the metered average at middle grey', () => {
        // The definition: whatever the scene averages, the chosen exposure maps it to 0.18.
        for (const avg of [0.01, 0.09, 0.5, 4]) {
            const ev = targetEVFor(avg);
            const exposure = exposureForEV(ev);
            expect(avg * exposure).toBeCloseTo(KEY, 6);
        }
    });

    it('opens up for a darker scene and stops down for a brighter one', () => {
        // The direction is the whole feature and it is one sign away from being backwards.
        expect(targetEVFor(0.02)).toBeLessThan(targetEVFor(0.2));
        expect(exposureForEV(targetEVFor(0.02))).toBeGreaterThan(exposureForEV(targetEVFor(0.2)));
    });

    it('moves one EV per doubling of scene brightness', () => {
        expect(targetEVFor(0.2) - targetEVFor(0.1)).toBeCloseTo(1, 9);
    });
});

describe('clamps and compensation', () => {
    it('holds the metered value inside the EV window', () => {
        expect(clampEV(30, 2, 17, 0)).toBe(17);
        expect(clampEV(-8, 2, 17, 0)).toBe(2);
    });

    it('survives a window given the wrong way round', () => {
        // An artist dragging min past max should not produce NaN or an inverted clamp.
        expect(clampEV(9, 17, 2, 0)).toBe(9);
        expect(clampEV(30, 17, 2, 0)).toBe(17);
    });

    it('brightens the picture for positive compensation', () => {
        // +1 stop of compensation is a BRIGHTER image, which on a meter is a LOWER EV. Getting this
        // backwards is invisible until someone drags the slider and the picture goes the wrong way.
        expect(clampEV(15, 2, 17, 1)).toBe(14);
        expect(exposureForEV(clampEV(15, 2, 17, 1))).toBeGreaterThan(exposureForEV(15));
    });

    it('lets compensation reach past the clamp', () => {
        // Applied after the clamp on purpose: the clamp bounds what the METER may decide, not what the
        // artist may then ask for on top of it.
        expect(clampEV(30, 2, 17, 3)).toBe(14);
    });
});

describe('adaptation', () => {
    it('is frame-rate independent', () => {
        // The same wall-clock elapsed must land in the same place however it is subdivided. A
        // `dt * k` smoother fails this outright.
        const run = (dt: number, seconds: number) => {
            let ev = 10;
            for (let t = 0; t < seconds - 1e-9; t += dt) ev = step(ev, 16, dt, 1.5);
            return ev;
        };
        const at60 = run(1 / 60, 2);
        const at120 = run(1 / 120, 2);
        const at30 = run(1 / 30, 2);
        expect(at120).toBeCloseTo(at60, 3);
        expect(at30).toBeCloseTo(at60, 2);
    });

    it('is a RATE, so a higher number adapts faster', () => {
        // The direction the setting reads in. It shipped inverted — `exp(-dt / speed)`, a time constant
        // in seconds — while carrying Unreal's rate names AND Unreal's rate values, so 3.0 meant a
        // three-second constant where Unreal means a third of a second. The digits matched and the
        // meaning did not.
        const slow = step(0, 1, 0.1, 1);
        const fast = step(0, 1, 0.1, 8);
        expect(fast).toBeGreaterThan(slow);
        // `1 - exp(-1)` is 63.2% of the way after 1/speed seconds, which is what makes the number
        // readable: speed 2 covers that in half a second.
        expect(step(0, 1, 1 / 2, 2)).toBeCloseTo(1 - Math.exp(-1), 9);
    });

    it('snaps at zero, which is what the gate relies on', () => {
        // A rate of zero would literally never converge, which is useless as the bottom of a slider.
        // `passConfigs.js` zeroes both speeds so the captured frame is the metered value rather than a
        // record of how fast the machine ran.
        expect(step(3, 17, 1 / 60, 0)).toBe(17);
    });

    it('converges monotonically and never overshoots', () => {
        let ev = 4;
        let prev = -Infinity;
        for (let i = 0; i < 600; i++) {
            ev = step(ev, 15, 1 / 60, 1.25);
            expect(ev).toBeGreaterThan(prev);
            expect(ev).toBeLessThanOrEqual(15 + 1e-9);
            prev = ev;
        }
        expect(ev).toBeCloseTo(15, 3);
    });
});

describe('the authored exposure is kept apart from the metered one', () => {
    const RENDERER = readFileSync(join(__dirname, '..', 'src', 'graphics', 'renderer.ts'), 'utf-8');

    it('serializes the AUTHORED value, not whatever the meter was at', () => {
        // `exposure: this._exposure` made a scene's saved exposure depend on where the camera happened
        // to be pointing when Save was pressed.
        expect(RENDERER).toContain('exposure: this._baseExposure,');
    });

    it('never lets the meter write the authored value', () => {
        // The meter owns `_exposure`; `_baseExposure` is written only by the setters and by
        // applyRenderSettings. If the adaptation touched it, suppressing metering would leave a preview
        // sitting on the last adapted value, which is the bug this split exists to remove.
        const fn = RENDERER.slice(RENDERER.indexOf('private _adaptExposure('));
        expect(fn.slice(0, fn.indexOf('\n    }'))).not.toContain('_baseExposure');
    });

    it('resolves the exposure ABOVE the thumbnail early-return', () => {
        // The ordering IS the feature. `screenshotOffscreen` sets `_presentTarget`, and
        // `_applyPostProcessing` returns on it before the metering pass — so a thumbnail never meters,
        // and without a resolve above that return it would render at the scene's last metered value.
        // Two thumbnails a second apart then come out at different brightnesses.
        const post = RENDERER.slice(RENDERER.indexOf('private _applyPostProcessing('));
        const body = post.slice(0, post.indexOf('this._presentThumbnail()'));
        expect(body).toContain('this._resolveExposure();');
    });

    it("renders a preview at a FIXED exposure, not the project's", () => {
        // The distinction this got wrong once. Using the project's authored value looks reasonable and
        // is not: a scene saved while auto-exposure had opened up on a dim interior banks a very large
        // exposure, and every preview in the editor then renders blown out. A constant is also what
        // keeps thumbnails comparable with each other and stable as the scene is retuned.
        expect(RENDERER).toContain('this._exposure = Renderer.PREVIEW_EXPOSURE;');
        expect(RENDERER).toContain('PREVIEW_EXPOSURE = 2.0');
        const fn = RENDERER.slice(RENDERER.indexOf('private _resolveExposure()'));
        const body = fn.slice(0, fn.indexOf('\n    }'));
        // The offscreen thumbnail path counts as a preview whichever tab it was taken from.
        expect(body).toContain('!this._exposureMeteringAllowed || this._presentTarget');
    });

    it('leaves a manual exposure alone when metering is merely switched off', () => {
        // Auto-exposure off project-wide is not a preview: the artist's own exposure has to stand.
        const fn = RENDERER.slice(RENDERER.indexOf('private _resolveExposure()'));
        const body = fn.slice(0, fn.indexOf('\n    }'));
        expect(body).toContain('if (!this._autoExposureEnabled) this._exposure = this._baseExposure;');
        expect(RENDERER).toContain('return this._autoExposureEnabled && this._exposureMeteringAllowed;');
    });
});

describe('metering is suppressed outside the scene tab', () => {
    const CONTEXT = readFileSync(join(__dirname, '..', 'editor', 'src', 'features', 'EngineContext.tsx'), 'utf-8');

    /** The `TabKind` union and the table that must cover it. */
    const tabKinds = () => {
        const line = CONTEXT.match(/export type TabKind = ([^;]+);/);
        expect(line, 'TabKind not found').toBeTruthy();
        return [...line![1].matchAll(/'([a-zA-Z]+)'/g)].map(m => m[1]);
    };
    const tableEntries = () => {
        const start = CONTEXT.indexOf('export const TAB_METERS_EXPOSURE');
        const body = CONTEXT.slice(start, CONTEXT.indexOf('};', start));
        return Object.fromEntries([...body.matchAll(/^\s{2}([a-zA-Z]+):\s*(true|false)/gm)]
            .map(m => [m[1], m[2] === 'true']));
    };

    it('covers every tab kind', () => {
        // The same exhaustiveness `MODE_RENDERS_VIEWPORT` has, for the same reason: a new tab kind
        // added without an entry would silently inherit metering it should not have.
        const table = tableEntries();
        for (const kind of tabKinds()) expect(table, `no TAB_METERS_EXPOSURE entry for '${kind}'`).toHaveProperty(kind);
    });

    it('allows it for the scene tab and nothing else', () => {
        const table = tableEntries();
        expect(table.scene).toBe(true);
        for (const [kind, on] of Object.entries(table))
            if (kind !== 'scene') expect(on, `'${kind}' is a preview and must not meter`).toBe(false);
    });

    it('drives it from all three places the renderer is configured per context', () => {
        // Tab switch, play start (the running game is the scene whichever tab Play came from), and play
        // stop (hand it back to whatever tab is underneath). Missing the play pair leaves a game
        // metering-suppressed because Play happened to be pressed from a material tab.
        expect(CONTEXT).toContain('setExposureMeteringAllowed(TAB_METERS_EXPOSURE[tab.kind])');
        expect(CONTEXT).toContain('setExposureMeteringAllowed(true)');
        expect(CONTEXT).toContain('setExposureMeteringAllowed(TAB_METERS_EXPOSURE[activeTabKindRef.current])');
    });
});

describe('the shader and the renderer agree on the window', () => {
    const SHADER = readFileSync(
        join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'exposureMeter.wgsl'), 'utf-8');
    const RENDERER = readFileSync(join(__dirname, '..', 'src', 'graphics', 'renderer.ts'), 'utf-8');

    it('uses the same encode window on both sides', () => {
        // Two copies of one constant, and a disagreement is silent: the exposure just settles somewhere
        // wrong, which reads as a taste problem rather than a bug.
        expect(SHADER).toContain(`LOG_LUM_MIN: f32 = ${LOG_LUM_MIN}.0`);
        expect(SHADER).toContain(`LOG_LUM_MAX: f32 = ${LOG_LUM_MAX}.0`);
        expect(RENDERER).toContain(`LOG_LUMINANCE_WINDOW: [number, number] = [${LOG_LUM_MIN}.0, ${LOG_LUM_MAX}.0]`);
    });

    it('meters in log space, not linear', () => {
        // Averaging luminance directly lets one blown highlight drag the whole frame's exposure.
        expect(SHADER).toContain('log2(lum)');
        expect(SHADER).toContain('sumLog / kept');
    });

    it('rejects the tails before averaging, as Unreal does', () => {
        // A flat mean over the whole frame lets the extremes drag it, and the adaptation then chases
        // whichever the camera is pointed at. 10/90 are Unreal's own AutoExposureLow/HighPercent
        // defaults. Honest note: on the harness fixture this is worth only about 0.04 stops against a
        // flat average, because the outlier that moves it there is a floor covering far more than a
        // tenth of the frame — which SHOULD move the exposure. It earns its place on a small blown
        // highlight, which that scene does not have.
        expect(SHADER).toContain('LOW_PERCENT: f32 = 0.10');
        expect(SHADER).toContain('HIGH_PERCENT: f32 = 0.90');
        // The retained band must be averaged from the real samples, not from bin centres, or the
        // result quantises to the 0.31-stop bin grid.
        expect(SHADER).toContain('if (v >= lowCut && v <= highCut)');
    });

    it('falls back to the whole set rather than dividing by zero', () => {
        // A frame flat enough to land every sample in one bin can cut everything away.
        expect(SHADER).toContain('if (kept < 1.0)');
    });

    it('meters the lit scene rather than the composed frame', () => {
        // After bloom, exposure and bloom chase each other: bloom brightens, the meter darkens, which
        // moves bloom's display-referred threshold, and round again.
        expect(RENDERER).toContain('this._textureBindGroup(pipeline, 0, [this._sceneFBO.colors[0]])');
    });
});
