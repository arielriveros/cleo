import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { renderNow, setRenderClock, renderClockOverridden } from '../src/graphics/render/renderClock';

/**
 * Everything the renderer animates or throttles by time reads the render clock (render/renderClock.ts), so
 * a movie render can run it on the movie's time: a frame that takes two seconds to draw must not show two
 * seconds of wind, exposure adaptation or cloud drift. A wall-clock read under src/graphics/ is allowed
 * only where it MEASURES something (profilers, stall records, compile budgets, ids), in the files below,
 * or on a line that says why with a `// wall-clock:` comment.
 */

const ROOT = path.resolve(__dirname, '..');
const GRAPHICS = path.join(ROOT, 'src', 'graphics');

/** Files whose wall-clock reads are measurements, not looks. */
const MEASURING_FILES = new Set([
    'src/graphics/cpuProfiler.ts',
    'src/graphics/material.ts',                       // slot ids
    'src/graphics/render/gi/giBakeRegistry.ts',       // bake ids
    'src/graphics/render/pipelineCache.ts',           // stall records
    'src/graphics/render/programRegistry.ts',         // stall records
    'src/graphics/render/renderClock.ts',             // the clock itself
    'src/graphics/rhi/webgl2/webgl2Device.ts',        // compile timing, readback patience
    'src/graphics/shaderOptimizer/compileQueue.ts',   // the per-frame compile budget
    'src/graphics/shaderStats.ts',
    'src/graphics/systems/customShaders.ts',          // stall records
    'src/graphics/tilemap/tilemap.ts',                // collision rebuild throttle, not drawn
]);

/** Lines in other files that time themselves for the stats (a `start`/`sliceStart`/`_statsT0` measurement). */
const MEASURING_LINE = /\b(start|sliceStart|_statsT0)\b/;

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (name.endsWith('.ts')) out.push(full);
    }
    return out;
}

function offenders(): string[] {
    const found: string[] = [];
    for (const file of walk(GRAPHICS)) {
        const rel = path.relative(ROOT, file).split(path.sep).join('/');
        if (MEASURING_FILES.has(rel)) continue;
        const lines = readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((line, i) => {
            const trimmed = line.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
            const code = line.replace(/\/\/.*$/, '');
            if (!/performance\.now\(\)|Date\.now\(\)/.test(code)) return;
            if (line.includes('// wall-clock:') || MEASURING_LINE.test(code)) return;
            found.push(`${rel}:${i + 1}: ${trimmed}`);
        });
    }
    return found;
}

describe('the render clock', () => {
    afterEach(() => setRenderClock(null));

    it('is the wall clock until something drives it, then that', () => {
        expect(renderClockOverridden()).toBe(false);
        const before = renderNow();
        expect(Math.abs(before - performance.now())).toBeLessThan(50);
        let t = 1234;
        setRenderClock(() => t);
        expect(renderClockOverridden()).toBe(true);
        expect(renderNow()).toBe(1234);
        t = 5000;
        expect(renderNow()).toBe(5000);
        setRenderClock(null);
        expect(renderClockOverridden()).toBe(false);
    });

    it('is what every time-based effect under src/graphics reads', () => {
        expect(offenders(), 'Read renderNow() (render/renderClock.ts), or mark a measurement `// wall-clock: why`').toEqual([]);
    });
});
