import { describe, it, expect } from 'vitest';
import { renderStill, StillCancelledError, type StillEngine } from '../src/sequencer/movie/renderStill';
import { sampleJitter } from '../src/sequencer/movie/movieTiming';

/**
 * A still (a project's cover) is a movie frame of one moment: renderStill drives the same seam renderMovie does,
 * against a fake engine here. What it must get right is what a movie frame gets right — the light settled and the
 * exposure snapped before the first sample, every sample declared with its jitter, and nothing read back that was
 * never drawn — because a capture that skips any of them looks merely "a bit off", which nobody reports.
 */

function fakeEngine(opts: { settleAfter?: number; presented?: boolean } = {}) {
  const log: string[] = [];
  let renders = 0;
  const engine: StillEngine & { log: string[] } = {
    log,
    render() { renders++; log.push('render'); },
    setSample(sample, samples, jitter) { log.push(`sample ${sample}/${samples} ${jitter ? jitter.map(v => v.toFixed(3)).join(',') : 'none'}`); },
    get framePresented() { return opts.presented !== false; },
    async readFrame() { log.push('read'); return new Uint8Array([1, 2, 3, 4]); },
    async whenAssetsReady() { log.push('assets'); return true; },
    get lightingSettled() { return renders >= (opts.settleAfter ?? 0); },
    snapExposure() { log.push('snap'); },
    async yield() { log.push('yield'); },
  };
  return engine;
}

const count = (log: string[], what: string) => log.filter(l => l === what).length;

describe('renderStill', () => {
  it('settles three renders at least, snaps exposure, then draws each sample with its jitter', async () => {
    const e = fakeEngine();
    const rgba = await renderStill(e, { samples: 4 });
    expect([...rgba]).toEqual([1, 2, 3, 4]);
    const snap = e.log.indexOf('snap');
    expect(count(e.log.slice(0, snap), 'render')).toBe(3);
    expect(e.log.slice(0, snap).filter(l => l.startsWith('sample'))).toEqual(['sample 0/1 none']);
    const samples = e.log.slice(snap).filter(l => l.startsWith('sample'));
    expect(samples).toEqual([0, 1, 2, 3].map(k => `sample ${k}/4 ${sampleJitter(k, 4)!.map(v => v.toFixed(3)).join(',')}`));
    expect(count(e.log.slice(snap), 'render')).toBe(4);
    expect(e.log[e.log.length - 1]).toBe('read');
  });

  it('keeps settling until the light has, up to the cap', async () => {
    const settled = fakeEngine({ settleAfter: 20 });
    await renderStill(settled, { samples: 1 });
    expect(count(settled.log.slice(0, settled.log.indexOf('snap')), 'render')).toBe(20);

    const never = fakeEngine({ settleAfter: Infinity });
    await renderStill(never, { samples: 1, settleCap: 40 });
    expect(count(never.log.slice(0, never.log.indexOf('snap')), 'render')).toBe(40);
  });

  it('one sample is the picture Play shows: no jitter of its own', async () => {
    const e = fakeEngine();
    await renderStill(e, { samples: 1 });
    expect(e.log.filter(l => l.startsWith('sample'))).toEqual(['sample 0/1 none', 'sample 0/1 none']);
  });

  it('waits for assets before settling and again before the samples', async () => {
    const e = fakeEngine();
    await renderStill(e, { samples: 2 });
    const first = e.log.indexOf('assets'), second = e.log.lastIndexOf('assets');
    expect(first).toBe(0);
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThan(e.log.indexOf('snap'));
  });

  it('refuses to read a frame that was never drawn', async () => {
    const e = fakeEngine({ presented: false });
    await expect(renderStill(e, { samples: 2 })).rejects.toThrow(/not drawn/);
    expect(e.log).not.toContain('read');
  });

  it('stops when cancelled, without reading', async () => {
    const e = fakeEngine({ settleAfter: Infinity });
    const ctl = new AbortController();
    const p = renderStill(e, { samples: 8, signal: ctl.signal, onProgress: (pr) => { if (pr.renders >= 16) ctl.abort(); } });
    await expect(p).rejects.toBeInstanceOf(StillCancelledError);
    expect(e.log).not.toContain('read');
  });

  it('reports its progress: warm-up, then each sample', async () => {
    const e = fakeEngine({ settleAfter: 16 });
    const seen: string[] = [];
    await renderStill(e, { samples: 8, onProgress: p => seen.push(`${p.phase} ${p.sample}/${p.samples}`) });
    expect(seen[0]).toBe('warmup 0/8');
    expect(seen.slice(-2)).toEqual(['sampling 4/8', 'sampling 8/8']);
  });
});
