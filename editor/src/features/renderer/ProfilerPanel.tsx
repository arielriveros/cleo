import { useEffect, useRef, useState } from 'react';
import { gpuProfiler, frameHistory, frameStats, TOGGLEABLE_PASSES } from 'cleo';
import { useCleoEngine } from '../EngineContext';
import { Section, Slider, Toggle, SegmentedControl, Button, Hint } from '../../components/ui';
import Sparkline from './Sparkline';

// Deep-dive render profiler. The compact HUD (RendererStats) answers "is the frame fast"; this panel
// answers "which pass is spending the time, and what happens if I drop it".
//
// Two independent ways to attribute cost, because neither is always available or always sufficient:
//
//  1. GPU timer queries (EXT_disjoint_timer_query_webgl2) give a direct per-pass number, but the
//     extension is gated by driver and browser flags and is simply absent on some machines.
//  2. Per-pass kill switches measure a pass's MARGINAL cost by removing it and watching the frame
//     time. That needs no extension, and it captures downstream savings (bandwidth, dependent
//     passes) that a timer wrapped around the draw call does not.
//
// Both are here on purpose: the timer tells you where to look, the switch tells you what removing it
// would actually buy.

const REFRESH_MS = 250; // matches the HUD; fast enough to feel live, slow enough not to churn React
/** Slack on the frame budget before the readout turns red — see `overBudget`. */
const BUDGET_TOLERANCE = 0.05;

const fmt = (x: number, dp = 2) =>
  x.toLocaleString(undefined, { maximumFractionDigits: dp, minimumFractionDigits: dp });

/** Frame budgets for the common refresh rates, drawn as a target line on the graph. */
const BUDGETS = [
  { value: 60, label: '60Hz' },
  { value: 120, label: '120Hz' },
  { value: 144, label: '144Hz' },
];

const QUALITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Med' },
  { value: 'high', label: 'High' },
  { value: 'ultra', label: 'Ultra' },
];

type PassRow = { name: string; avgMs: number; maxMs: number };

function Row(props: { label: string; value: string }) {
  return (
    <div className='flex justify-between gap-3 leading-5'>
      <span className='text-muted'>{props.label}</span>
      <span className='font-mono'>{props.value}</span>
    </div>
  );
}

export default function ProfilerPanel() {
  const { instance } = useCleoEngine();
  const renderer: any = instance?.renderer ?? null;

  const [enabled, setEnabled] = useState(() => gpuProfiler.enabled);
  const [budgetHz, setBudgetHz] = useState(120);
  const [quality, setQuality] = useState<string>(() => renderer?.quality ?? 'high');
  const [renderScale, setRenderScale] = useState<number>(() => renderer?.renderScale ?? 1);
  // Mirror of renderer.passEnabled, held in React state so the switches re-render. The renderer
  // stays the source of truth and is written through setPassEnabled.
  const [passes, setPasses] = useState<Record<string, boolean>>({});

  const [rows, setRows] = useState<PassRow[]>([]);
  const [summary, setSummary] = useState({
    fps: 0, frameMs: 0, p50: 0, p95: 0, worst: 0,
    cpuMs: 0, gpuMs: 0, fullscreenPasses: 0, shadedMpx: 0, drawCalls: 0,
    stateChanges: 0, stateChangesSaved: 0,
  });
  const [history, setHistory] = useState<number[]>([]);

  const frames = useRef(0);
  const acc = useRef(0);
  const last = useRef(performance.now());

  // Seed the mirrors once the renderer exists.
  useEffect(() => {
    if (!renderer) return;
    setPasses({ ...renderer.passEnabled });
    setQuality(renderer.quality);
    setRenderScale(renderer.renderScale);
  }, [renderer]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      acc.current += now - last.current;
      last.current = now;
      frames.current++;

      if (acc.current >= REFRESH_MS) {
        const stats: any = renderer?.stats ?? null;
        setRows(gpuProfiler.passes.map((p) => ({ name: p.name, avgMs: p.avgMs, maxMs: p.maxMs })));
        setSummary({
          fps: (frames.current * 1000) / acc.current,
          frameMs: acc.current / frames.current,
          p50: frameHistory.frame.percentile(0.5),
          p95: frameHistory.frame.percentile(0.95),
          worst: frameHistory.frame.max,
          cpuMs: stats?.frameMs ?? 0,
          gpuMs: gpuProfiler.totalMs,
          fullscreenPasses: stats?.fullscreenPasses ?? 0,
          shadedMpx: stats?.shadedMpx ?? 0,
          drawCalls: stats?.drawCalls ?? 0,
          stateChanges: frameStats.stateChanges,
          stateChangesSaved: frameStats.stateChangesSaved,
        });
        setHistory(frameHistory.frame.toArray());
        frames.current = 0;
        acc.current = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [renderer]);

  const budgetMs = 1000 / budgetHz;
  // A vsynced frame sits AT the budget, not under it, so an exact comparison flickers red half the
  // time on a machine that is comfortably hitting its refresh rate. The tolerance makes "locked to
  // vsync" read as green, which is what it is.
  const overBudget = summary.frameMs > budgetMs * (1 + BUDGET_TOLERANCE);
  // Bars scale against the slowest pass, not the frame budget: passes are usually a small fraction
  // of the frame, and a budget-relative scale would render them all as invisible slivers.
  const maxPassMs = rows.length > 0 ? Math.max(...rows.map(r => r.avgMs)) : 1;

  const togglePass = (name: string, on: boolean) => {
    renderer?.setPassEnabled(name, on);
    setPasses(prev => ({ ...prev, [name]: on }));
  };

  const resetPasses = () => {
    renderer?.resetPasses();
    setPasses({ ...renderer.passEnabled });
  };

  /** Plain-text dump of the current numbers, for pasting into an issue or a before/after comparison. */
  const copyReport = () => {
    const lines = [
      `frame ${fmt(summary.frameMs)}ms (${fmt(summary.fps, 0)} fps) - p50 ${fmt(summary.p50)} - p95 ${fmt(summary.p95)} - worst ${fmt(summary.worst)}`,
      `cpu render ${fmt(summary.cpuMs)}ms - gpu ${fmt(summary.gpuMs)}ms`,
      `draws ${summary.drawCalls} - screen passes ${summary.fullscreenPasses} - fill ${fmt(summary.shadedMpx, 1)} Mpx`,
      `quality ${quality} - renderScale ${renderScale}`,
      '',
      ...rows.map(r => `${r.name.padEnd(20)} ${fmt(r.avgMs).padStart(8)} ms  (max ${fmt(r.maxMs)})`),
    ];
    navigator.clipboard?.writeText(lines.join('\n'));
  };

  if (!renderer) return <div className='p-3 text-muted text-xs'>No renderer.</div>;

  return (
    <div className='h-full overflow-y-auto p-3 text-[11px] text-white'>
      <Section title='Frame'>
        <div className='flex items-baseline justify-between'>
          <span className={`font-mono text-lg ${overBudget ? 'text-danger' : 'text-success'}`}>
            {fmt(summary.frameMs, 1)} ms
          </span>
          <span className='text-muted font-mono'>{fmt(summary.fps, 0)} fps</span>
        </div>
        <Sparkline values={history} height={56} budgetMs={budgetMs} className='my-2' />
        {/* Mean alone hides hitching: a flat 12ms and a 9ms mean with a 30ms p95 read identically
            in a single number and are completely different problems. */}
        <div className='flex justify-between text-muted font-mono'>
          <span>p50 {fmt(summary.p50, 1)}</span>
          <span>p95 {fmt(summary.p95, 1)}</span>
          <span>worst {fmt(summary.worst, 1)}</span>
        </div>
        <div className='mt-2'>
          <SegmentedControl value={budgetHz} options={BUDGETS} onChange={v => setBudgetHz(v as number)} />
          <Hint>Target line on the graph — {fmt(budgetMs, 2)} ms per frame.</Hint>
        </div>
      </Section>

      <Section title='GPU passes'>
        <Toggle
          label='Timer queries'
          checked={enabled}
          onChange={v => { gpuProfiler.enabled = v; setEnabled(v); }}
        />
        {!gpuProfiler.available && (
          <Hint>
            EXT_disjoint_timer_query_webgl2 is unavailable on this driver/browser, so per-pass timings
            cannot be read. Use the pass switches below to attribute cost by A/B instead — they need
            no extension.
          </Hint>
        )}
        {enabled && gpuProfiler.available && rows.length === 0 &&
          <div className='text-muted mt-2'>waiting for results…</div>}
        {enabled && rows.length > 0 && (
          <div className='mt-2 space-y-[3px]'>
            {rows.map(r => (
              <div key={r.name} className='leading-4'>
                <div className='flex justify-between'>
                  <span className='truncate'>{r.name}</span>
                  <span className='font-mono text-muted ml-2 shrink-0'>{fmt(r.avgMs)} ms</span>
                </div>
                <div className='h-1 bg-control rounded-sm overflow-hidden'>
                  <div
                    className={r.avgMs > budgetMs * 0.33 ? 'h-full bg-danger' : 'h-full bg-success'}
                    style={{ width: `${Math.max(1, (r.avgMs / maxPassMs) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
            <div className='flex justify-between pt-1 font-semibold'>
              <span>total</span>
              <span className='font-mono'>{fmt(summary.gpuMs)} ms</span>
            </div>
          </div>
        )}
      </Section>

      <Section title='Fill rate'>
        {/* On a scene with trivial geometry these lines are the whole story: a low draw count next to
            a high Mpx figure means the frame is spent on fullscreen passes, not on meshes. */}
        <Row label='Draw calls' value={summary.drawCalls.toLocaleString()} />
        <Row label='Screen passes' value={summary.fullscreenPasses.toLocaleString()} />
        <Row label='Shaded' value={`${fmt(summary.shadedMpx, 1)} Mpx`} />
        <Row
          label='State changes'
          value={`${summary.stateChanges.toLocaleString()} (${summary.stateChangesSaved.toLocaleString()} saved)`}
        />
      </Section>

      <Section title='Quality'>
        <SegmentedControl
          value={quality}
          options={QUALITY_OPTIONS}
          onChange={v => {
            renderer.quality = v;
            setQuality(v as string);
            setRenderScale(renderer.renderScale);
          }}
        />
        <Hint>Ultra reproduces the engine&apos;s original defaults exactly. High is the new default.</Hint>
        <div className='mt-2'>
          <Slider
            label='Render scale'
            value={renderScale}
            min={0.25}
            max={1}
            step={0.05}
            readout={v => `${Math.round(v * 100)}%`}
            onChange={v => { renderer.renderScale = v; setRenderScale(renderer.renderScale); }}
          />
          <Hint>
            Internal resolution. Halving it quarters every fullscreen pass — if that barely moves the
            frame time, the frame is not fill-rate bound.
          </Hint>
        </div>
      </Section>

      <Section title='Pass switches'>
        <Hint>Turn a pass off and watch the frame graph. The drop is that pass&apos;s true marginal cost.</Hint>
        <div className='mt-2 grid grid-cols-2 gap-x-3'>
          {TOGGLEABLE_PASSES.map(name => (
            <Toggle
              key={name}
              label={name}
              checked={passes[name] !== false}
              onChange={v => togglePass(name, v)}
            />
          ))}
        </div>
        <div className='mt-2 flex flex-wrap gap-2'>
          <Button onClick={resetPasses}>Enable all</Button>
          <Button onClick={() => gpuProfiler.reset()}>Reset timings</Button>
          <Button onClick={copyReport}>Copy report</Button>
        </div>
      </Section>
    </div>
  );
}
