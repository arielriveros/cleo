import { describe, it, expect, beforeEach } from 'vitest';
import { WebGL2PassTimer } from '../src/graphics/rhi/webgl2/webgl2PassTimer';

/**
 * WebGL2's half of `Device.setTimestampCollection`: one TIME_ELAPSED query per render pass, read back
 * frames late and never waited on, so the Performance panel shows the same per-pass rows on both
 * backends. A stub context stands in for EXT_disjoint_timer_query_webgl2.
 */
const EXT = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };
const QUERY_RESULT = 0x8866, QUERY_RESULT_AVAILABLE = 0x8867;

let calls: string[];
let available: boolean;
let disjoint: boolean;
let resultNs: Map<object, number>;
let gl: WebGL2RenderingContext;
let next = 0;

beforeEach(() => {
    calls = []; available = true; disjoint = false; resultNs = new Map(); next = 0;
    gl = {
        QUERY_RESULT, QUERY_RESULT_AVAILABLE,
        getExtension: () => EXT,
        createQuery: () => { const q = { q: ++next }; resultNs.set(q, next * 1e6); return q; },
        deleteQuery: () => { calls.push('delete'); },
        beginQuery: (_t: number, q: { q: number }) => { calls.push(`begin${q.q}`); },
        endQuery: () => { calls.push('end'); },
        getParameter: (p: number) => (p === EXT.GPU_DISJOINT_EXT ? disjoint : 0),
        getQueryParameter: (q: object, p: number) => (p === QUERY_RESULT_AVAILABLE ? available : resultNs.get(q)),
    } as unknown as WebGL2RenderingContext;
});

describe('WebGL2PassTimer', () => {
    it('brackets each pass with one query and delivers the frame once its results are in', () => {
        const timer = new WebGL2PassTimer(gl);
        const got: [string, number][] = [];
        timer.setEnabled(true, (label, ms) => got.push([label, ms]));
        timer.beginPass('geometry'); timer.endPass();
        timer.beginPass('lighting'); timer.endPass();
        expect(calls).toEqual(['begin1', 'end', 'begin2', 'end']);

        available = false;
        timer.collect();                       // sealed, not ready: nothing yet, and nothing waited on
        expect(got).toEqual([]);
        available = true;
        timer.collect();
        expect(got).toEqual([['geometry', 1], ['lighting', 2]]);
    });

    it('closes a pass left open when the next one begins, or at the collect', () => {
        const timer = new WebGL2PassTimer(gl);
        const got: string[] = [];
        timer.setEnabled(true, label => got.push(label));
        timer.beginPass('a');
        timer.beginPass('b');                  // one TIME_ELAPSED query at a time
        timer.collect();
        expect(calls).toEqual(['begin1', 'end', 'begin2', 'end']);
        expect(got).toEqual(['a', 'b']);
    });

    it('delivers one resolved frame per collect, oldest first', () => {
        const timer = new WebGL2PassTimer(gl);
        const got: string[] = [];
        timer.setEnabled(true, label => got.push(label));
        available = false;
        timer.beginPass('f1'); timer.endPass(); timer.collect();
        timer.beginPass('f2'); timer.endPass(); timer.collect();
        available = true;
        timer.collect();
        expect(got).toEqual(['f1']);
        timer.collect();
        expect(got).toEqual(['f1', 'f2']);
    });

    it('drops everything in flight on a disjoint', () => {
        const timer = new WebGL2PassTimer(gl);
        const got: string[] = [];
        timer.setEnabled(true, label => got.push(label));
        timer.beginPass('geometry'); timer.endPass();
        disjoint = true;
        timer.collect();
        disjoint = false;
        timer.collect();
        expect(got).toEqual([]);
    });

    it('issues no query while switched off, and switching off closes an open one', () => {
        const timer = new WebGL2PassTimer(gl);
        timer.beginPass('geometry');
        expect(calls).toEqual([]);
        timer.setEnabled(true, () => {});
        timer.beginPass('geometry');
        timer.setEnabled(false, () => {});
        expect(calls).toEqual(['begin1', 'end']);
        timer.beginPass('geometry');
        expect(calls).toEqual(['begin1', 'end']);
    });

    it('stays inert without the extension', () => {
        const noExt = { ...gl, getExtension: () => null } as unknown as WebGL2RenderingContext;
        const timer = new WebGL2PassTimer(noExt);
        expect(timer.available).toBe(false);
        timer.setEnabled(true, () => {});
        timer.beginPass('geometry'); timer.endPass(); timer.collect();
        expect(calls).toEqual([]);
    });

    it('times at most 128 passes a frame', () => {
        const timer = new WebGL2PassTimer(gl);
        let delivered = 0;
        timer.setEnabled(true, () => { delivered++; });
        for (let i = 0; i < 200; i++) { timer.beginPass(`p${i}`); timer.endPass(); }
        timer.collect();
        expect(delivered).toBe(128);
    });
});
