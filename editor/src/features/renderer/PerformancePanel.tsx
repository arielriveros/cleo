import { useEffect, useRef, useState } from 'react';
import { gpuProfiler, frameHistory, frameStats, sceneStatsDetail, TextureManager, TOGGLEABLE_PASSES } from 'cleo';
import { useCleoEngine } from '../EngineContext';
import { Section, Slider, Toggle, SegmentedControl, Button, Hint } from '../../components/ui';
import Sparkline from './Sparkline';

// The renderer's performance panel: what the frame costs, and where. Cost is attributed two ways:
//
//  1. GPU timers, gated by the backend — WebGL2 needs EXT_disjoint_timer_query_webgl2, WebGPU needs the
//     adapter's `timestamp-query`. `gpuProfiler.attribution` says which name space the rows are in:
//     WebGL2 times renderer scopes, WebGPU times render passes, and they are not the same list.
//  2. Per-pass kill switches, which measure a pass's marginal cost including downstream savings.
//
// Explanatory prose belongs in `title` tooltips, not visible captions: this is a long column already.

const REFRESH_MS = 250; // fast enough to feel live, slow enough not to churn React
/** Slack on the frame budget before the readout turns red — see `overBudget`. */
const BUDGET_TOLERANCE = 0.05;
const MB = 1024 * 1024;

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

// Counters sampled EVERY frame and reported as mean + range, never grabbed once per refresh: shadow
// cascades are staggered on a 4-frame cycle, so draw calls and triangles swing several-fold frame to
// frame and a single raw sample reads as noise.
const RANGED = ['drawCalls', 'instancedDrawCalls', 'objects', 'instances', 'triangles',
                'culledObjects', 'culledInstances', 'fullscreenPasses', 'shadedMpx',
                'stateChanges', 'stateChangesSaved'] as const;
type RangedKey = typeof RANGED[number];
type Range = { min: number; max: number; mean: number };

const ZERO_RANGE: Range = { min: 0, max: 0, mean: 0 };
const EMPTY_RANGES = Object.fromEntries(RANGED.map(k => [k, ZERO_RANGE])) as Record<RangedKey, Range>;

function Row(props: { label: string; value: string; hl?: boolean; title?: string }) {
  return (
    <div className='flex justify-between gap-3 leading-5' title={props.title}>
      <span className='text-muted'>{props.label}</span>
      <span className={`font-mono ${props.hl ? 'text-success font-semibold' : ''}`}>{props.value}</span>
    </div>
  );
}

/** Mean over the refresh window, with the min-max spread beside it when the counter actually moved. */
function RangeRow(props: { label: string; r: Range; dp?: number; unit?: string; hl?: boolean; title?: string }) {
  const { r, dp = 0, unit = '' } = props;
  const f = (x: number) => (dp > 0 ? fmt(x, dp) : Math.round(x).toLocaleString());
  return (
    <div className='flex justify-between gap-3 leading-5' title={props.title}>
      <span className='text-muted'>{props.label}</span>
      <span className={`font-mono tabular-nums ${props.hl ? 'text-success font-semibold' : ''}`}>
        {f(r.mean)}{unit}
        {r.max > r.min && <span className='text-muted ml-1.5'>{f(r.min)}–{f(r.max)}{unit}</span>}
      </span>
    </div>
  );
}

/** Everything the panel samples once per refresh, in one shape so one loop can fill it. */
type Sample = {
  fps: number; frameMs: number; p50: number; p95: number; worst: number;
  cpuMs: number; gpuMs: number; gpuAvailable: boolean; gpuOn: boolean;
  physicsMs: number; stepMs: number; writeBackMs: number; rayMs: number; rayCount: number;
  bodies: number; contacts: number;
  sceneMs: number; transformMs: number; scriptMs: number; animatorMs: number; rigMs: number; nodes: number;
  textures: number; textureMB: number; gpuMB: number;
  heapUsedMB: number | null; heapLimitMB: number | null;
  lights: number; sprites: number;
  width: number; height: number; renderWidth: number; renderHeight: number; renderScale: number;
  pipeline: string; backend: string;
};

const EMPTY: Sample = {
  fps: 0, frameMs: 0, p50: 0, p95: 0, worst: 0,
  cpuMs: 0, gpuMs: 0, gpuAvailable: false, gpuOn: false,
  physicsMs: 0, stepMs: 0, writeBackMs: 0, rayMs: 0, rayCount: 0, bodies: 0, contacts: 0,
  sceneMs: 0, transformMs: 0, scriptMs: 0, animatorMs: 0, rigMs: 0, nodes: 0,
  textures: 0, textureMB: 0, gpuMB: 0, heapUsedMB: null, heapLimitMB: null,
  lights: 0, sprites: 0,
  width: 0, height: 0, renderWidth: 0, renderHeight: 0, renderScale: 1,
  pipeline: '—', backend: '—',
};

export default function PerformancePanel() {
  const { instance } = useCleoEngine();
  const renderer: any = instance?.renderer ?? null;

  const [enabled, setEnabled] = useState(() => gpuProfiler.enabled);
  const [budgetHz, setBudgetHz] = useState(120);
  const [quality, setQuality] = useState<string>(() => renderer?.quality ?? 'high');
  const [renderScale, setRenderScale] = useState<number>(() => renderer?.renderScale ?? 1);
  const [detail, setDetail] = useState(sceneStatsDetail.enabled);
  // Mirror of renderer.passEnabled so the switches re-render. The renderer stays the source of truth
  // and is written through setPassEnabled.
  const [passes, setPasses] = useState<Record<string, boolean>>({});

  const [rows, setRows] = useState<PassRow[]>([]);
  const [d, setD] = useState<Sample>(EMPTY);
  const [r, setR] = useState<Record<RangedKey, Range>>(EMPTY_RANGES);
  const [history, setHistory] = useState<number[]>([]);

  const frames = useRef(0);
  const acc = useRef(0);
  const last = useRef(performance.now());
  /** Per-counter accumulator for the current refresh window; drained and zeroed on each boundary. */
  const bins = useRef(RANGED.map(() => ({ min: Infinity, max: -Infinity, sum: 0, n: 0 })));

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

      // Geometry/fill counters are sampled every frame, not once per refresh (see RANGED).
      {
        const s: any = renderer?.stats ?? null;
        for (let i = 0; i < RANGED.length; i++) {
          const key = RANGED[i];
          const v = key === 'stateChanges' || key === 'stateChangesSaved'
            ? frameStats[key]
            : (s?.[key] ?? 0);
          const bin = bins.current[i];
          if (v < bin.min) bin.min = v;
          if (v > bin.max) bin.max = v;
          bin.sum += v;
          bin.n++;
        }
      }

      // rAF fires once per display frame, so this interval is the real frame rate. The percentile
      // history must be filled by the engine's game loop, not here: this component unmounts outside
      // renderer mode, and a history with holes makes the percentiles lie.
      if (acc.current >= REFRESH_MS) {
        const stats: any = renderer?.stats ?? null;
        // Physics only steps in Play mode, so these read 0 while stopped.
        const phys: any = instance?.physics ? (instance.physics as any).stats : null;
        const scene: any = instance?.scene ?? null;
        const sceneS: any = scene ? (scene as any).stats : null;

        let textures = 0, textureBytes = 0;
        try {
          const map = TextureManager.Instance.textures;
          textures = map.size;
          for (const t of map.values()) textureBytes += (t as any)?.byteSize ?? 0;
        } catch { /* registry not ready */ }
        const mem = (performance as any).memory ?? null;

        setRows(gpuProfiler.passes.map((p) => ({ name: p.name, avgMs: p.avgMs, maxMs: p.maxMs })));
        setD({
          fps: (frames.current * 1000) / acc.current,
          frameMs: acc.current / frames.current,
          p50: frameHistory.frame.percentile(0.5),
          p95: frameHistory.frame.percentile(0.95),
          worst: frameHistory.frame.max,
          cpuMs: stats?.frameMs ?? 0,
          gpuMs: gpuProfiler.totalMs,
          gpuAvailable: gpuProfiler.available,
          gpuOn: gpuProfiler.enabled,
          physicsMs: phys?.totalMs ?? 0,
          stepMs: phys?.stepMs ?? 0,
          writeBackMs: phys?.writeBackMs ?? 0,
          rayMs: phys?.rayMs ?? 0,
          rayCount: phys?.rayCount ?? 0,
          bodies: phys?.bodies ?? 0,
          contacts: phys?.contacts ?? 0,
          sceneMs: sceneS?.totalMs ?? 0,
          transformMs: sceneS?.transformMs ?? 0,
          scriptMs: sceneS?.scriptMs ?? 0,
          animatorMs: sceneS?.animatorMs ?? 0,
          rigMs: sceneS?.rigMs ?? 0,
          nodes: sceneS?.nodes ?? 0,
          textures,
          textureMB: textureBytes / MB,
          gpuMB: (stats?.gpuBytes ?? 0) / MB,
          heapUsedMB: mem ? mem.usedJSHeapSize / MB : null,
          heapLimitMB: mem ? mem.jsHeapSizeLimit / MB : null,
          lights: scene?.lights?.size ?? 0,
          sprites: scene?.sprites?.size ?? 0,
          width: stats?.width ?? 0,
          height: stats?.height ?? 0,
          renderWidth: stats?.renderWidth ?? 0,
          renderHeight: stats?.renderHeight ?? 0,
          renderScale: stats?.renderScale ?? 1,
          pipeline: stats?.pipeline ?? '—',
          backend: renderer?.backend ?? '—',
        });
        const drained: any = {};
        for (let i = 0; i < RANGED.length; i++) {
          const bin = bins.current[i];
          drained[RANGED[i]] = bin.n > 0
            ? { min: bin.min, max: bin.max, mean: bin.sum / bin.n }
            : ZERO_RANGE;
          bin.min = Infinity; bin.max = -Infinity; bin.sum = 0; bin.n = 0;
        }
        setR(drained as Record<RangedKey, Range>);

        setHistory(frameHistory.frame.toArray());
        frames.current = 0;
        acc.current = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [renderer, instance]);

  const budgetMs = 1000 / budgetHz;
  // A vsynced frame sits AT the budget, not under it, so an exact comparison flickers red.
  const overBudget = d.frameMs > budgetMs * (1 + BUDGET_TOLERANCE);
  // Bars scale against the slowest pass, not the frame budget: a budget-relative scale renders every
  // pass as an invisible sliver.
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
      `frame ${fmt(d.frameMs)}ms (${fmt(d.fps, 0)} fps) - p50 ${fmt(d.p50)} - p95 ${fmt(d.p95)} - worst ${fmt(d.worst)}`,
      `cpu render ${fmt(d.cpuMs)}ms - gpu ${fmt(d.gpuMs)}ms`,
      // Ranges, not a single frame: a staggered-cascade scene depends on which frame you catch.
      `draws ${fmt(r.drawCalls.mean, 0)} (${r.drawCalls.min}-${r.drawCalls.max})`
        + ` - screen passes ${fmt(r.fullscreenPasses.mean, 0)} - fill ${fmt(r.shadedMpx.mean, 1)} Mpx`,
      `triangles ${fmt(r.triangles.mean, 0)} (${r.triangles.min}-${r.triangles.max})`
        + ` - culled ${fmt(r.culledObjects.mean, 0)} obj / ${fmt(r.culledInstances.mean, 0)} inst`,
      `physics ${fmt(d.physicsMs)}ms - scene ${fmt(d.sceneMs)}ms`,
      `quality ${quality} - renderScale ${renderScale} - ${d.backend}/${d.pipeline}`,
      '',
      ...rows.map(r => `${r.name.padEnd(20)} ${fmt(r.avgMs).padStart(8)} ms  (max ${fmt(r.maxMs)})`),
    ];
    navigator.clipboard?.writeText(lines.join('\n'));
  };

  if (!renderer) return <div className='p-3 text-muted text-xs'>No renderer.</div>;

  const unattributed = Math.max(0, d.frameMs - d.cpuMs - d.physicsMs - d.sceneMs);

  return (
    // The content column is capped rather than filling the dock group: renderer mode hides the rest of
    // the right rail, so this group can end up 700px+ wide. The panel itself stays resizable.
    <div className='h-full overflow-y-auto p-3 text-[11px] text-white'>
      <div className='w-full max-w-[420px]'>
      <Section
        title='Frame'
        hint={'Mean alone hides hitching: a flat 12 ms and a 9 ms mean with a 30 ms p95 read identically '
            + 'in a single number and are completely different problems. The budget selector only moves '
            + 'the target line on the graph.'}
      >
        <div className='flex items-baseline justify-between'>
          <span className={`font-mono text-lg ${overBudget ? 'text-danger' : 'text-success'}`}>
            {fmt(d.frameMs, 1)} ms
          </span>
          <span className='text-muted font-mono'>{fmt(d.fps, 0)} fps</span>
        </div>
        <Sparkline values={history} height={56} budgetMs={budgetMs} className='my-2' />
        <div className='flex justify-between text-muted font-mono'>
          <span>p50 {fmt(d.p50, 1)}</span>
          <span>p95 {fmt(d.p95, 1)}</span>
          <span>worst {fmt(d.worst, 1)}</span>
        </div>
        <div className='mt-2' title={`Target line on the graph — ${fmt(budgetMs, 2)} ms per frame.`}>
          <SegmentedControl value={budgetHz} options={BUDGETS} onChange={v => setBudgetHz(v as number)} />
        </div>
      </Section>

      <Section
        title='Frame budget'
        hint={'Where the frame actually goes. Render is CPU time only — it returns as soon as the commands '
            + 'are queued, so GPU cost shows up under GPU passes, not here. Unattributed is whatever the '
            + 'three measured phases do not account for: browser work, GPU sync, rAF idle.'}
      >
        <Row label='Render (CPU)' value={`${fmt(d.cpuMs, 1)} ms`} />
        {d.gpuOn
          ? <Row label='Render (GPU)' value={`${fmt(d.gpuMs)} ms`} hl={d.gpuMs > budgetMs} />
          : <Row label='Render (GPU)' value={d.gpuAvailable ? 'off' : 'n/a'}
                 title={d.gpuAvailable ? 'Enable timer queries under GPU passes.' : (gpuProfiler.unavailableReason ?? 'GPU timing is unavailable.')} />}
        {/* Split rather than one total on purpose: `step` is cannon's solver (the part a worker could
            take off this thread) while `write-back` is scene-graph sync that would stay here regardless. */}
        <Row label='Physics' value={`${fmt(d.physicsMs)} ms`} hl={d.physicsMs > 5}
             title='Only steps in Play mode — 0 while stopped is the honest answer, not a missing value.' />
        <Row label='· step' value={`${fmt(d.stepMs)} ms`} title="cannon's solver — the part a worker could take off this thread." />
        <Row label='· write-back' value={`${fmt(d.writeBackMs)} ms`} title='Scene-graph sync, which would stay on this thread regardless.' />
        <Row label='· rays' value={`${fmt(d.rayMs)} ms · ${d.rayCount.toLocaleString()}`} />
        {/* The slice between physics and render: scripts, animators, transform propagation, camera rigs. */}
        <Row label='Scene' value={`${fmt(d.sceneMs)} ms`} hl={d.sceneMs > 5}
             title='Scripts, animators, transform propagation and camera rigs.' />
        <Row label='· transforms' value={`${fmt(d.transformMs)} ms`} />
        <Row label='· rigs' value={`${fmt(d.rigMs)} ms`} />
        {detail && <>
          <Row label='· scripts' value={`${fmt(d.scriptMs)} ms`} />
          <Row label='· animators' value={`${fmt(d.animatorMs)} ms`} />
        </>}
        {/* Off by default: two performance.now() per node per frame inflates Scene/nodeLoop by 50-160%,
            so it would corrupt the totals above if it were always on. */}
        <button
          className='w-full text-left text-muted hover:text-white leading-5'
          onClick={() => { sceneStatsDetail.enabled = !detail; setDetail(!detail); }}
          title="Times each node's onUpdate and animator separately. Costs ~240ns per node per frame, which inflates the Scene total while enabled."
        >
          {detail ? '− hide script/animator split' : '+ script/animator split'}
        </button>
        <Row label='Unattributed' value={`${fmt(unattributed)} ms`} />
      </Section>

      <Section
        title='GPU passes'
        hint={'Timer queries give a direct per-pass number, but the extension is gated by driver and '
            + 'browser flags. When it is missing, use the pass switches below to attribute cost by A/B '
            + 'instead — they need no extension and also capture downstream savings a timer would miss.'}
      >
        <Toggle
          label='Timer queries'
          checked={enabled}
          onChange={v => { gpuProfiler.enabled = v; setEnabled(v); }}
          title={gpuProfiler.attribution === 'passes'
            ? 'WebGPU timestamp queries. Times each render pass at its own pass boundary.'
            : 'EXT_disjoint_timer_query_webgl2. Wraps each renderer scope in a GPU timer.'}
        />
        {!gpuProfiler.available && (
          <Hint>{gpuProfiler.unavailableReason ?? 'GPU timing is unavailable here.'} Use the pass switches below.</Hint>
        )}
        {/* One line, driven by `attribution`. The two backends do not measure the same thing and the
            rows are not interchangeable between them, so a reader comparing a WebGPU capture against a
            WebGL2 one needs to be told before they draw a conclusion from the difference. */}
        {gpuProfiler.available && gpuProfiler.attribution === 'passes' && (
          <Hint>
            Rows are render PASSES, not the renderer scopes WebGL2 times. Passes with no matching scope
            appear as <code>pass:…</code>; <code>frameEnd</code> has no row because per-pass timestamps
            already exclude the driver's end-of-frame drain it exists to absorb. Absolute values run
            high — the renderer submits one command buffer per pass today, so each pass pays a
            submission at both ends of its own window. Compare passes with each other, not with WebGL2.
          </Hint>
        )}
        {enabled && gpuProfiler.available && rows.length === 0 &&
          <div className='text-muted mt-2'>waiting for results…</div>}
        {enabled && rows.length > 0 && (
          <div className='mt-2 space-y-[3px]'>
            {rows.map(r => (
              <div key={r.name} className='leading-4' title={`max ${fmt(r.maxMs)} ms`}>
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
              <span className='font-mono'>{fmt(d.gpuMs)} ms</span>
            </div>
          </div>
        )}
      </Section>

      <Section
        title='Geometry'
        hint={'Mean over the last refresh, with the frame-to-frame range beside it. A wide range with a '
            + 'still camera is usually shadow cascade staggering, which re-draws every caster on a '
            + '4-frame cycle — not a bug. A low draw count next to a high Mpx figure below means the '
            + 'frame is spent on fullscreen passes, not on meshes.'}
      >
        <RangeRow label='Draw calls' r={r.drawCalls} />
        <RangeRow label='Instanced' r={r.instancedDrawCalls} />
        <RangeRow label='Objects' r={r.objects} />
        <RangeRow label='Instances' r={r.instances} />
        <RangeRow label='Triangles' r={r.triangles} />
        {/* Two counters, not one: models and foliage blades are different units and summing them made
            a landscape's grass swamp the model count entirely. */}
        <RangeRow label='Culled (objects)' r={r.culledObjects}
                  title='Scene meshes rejected by the camera frustum test before any draw.' />
        <RangeRow label='Culled (instances)' r={r.culledInstances}
                  title='Foliage instances rejected by the distance or frustum test, counted per blade.' />
        <Row label='Nodes' value={d.nodes.toLocaleString()} />
      </Section>

      <Section
        title='Fill rate'
        hint={'Fill counts each fullscreen pass at ITS OWN resolution, so a half-res pass contributes a '
            + 'quarter as much as a full-res one. It is the number that explains a frame whose triangle '
            + 'count is trivial.'}
      >
        <RangeRow label='Screen passes' r={r.fullscreenPasses} />
        <RangeRow label='Shaded' r={r.shadedMpx} dp={1} unit=' Mpx' hl={r.shadedMpx.mean > 40} />
        <RangeRow label='State changes' r={r.stateChanges}
                  title='GL state calls the cache could not elide (a genuine difference).' />
        <RangeRow label='· saved' r={r.stateChangesSaved}
                  title='Redundant GL state calls the state cache absorbed.' />
      </Section>

      <Section
        title='Memory'
        hint={'GPU est. is computed from each texture&apos;s requested format and mip chain, so it is an '
            + 'estimate of texture memory, not total VRAM.'}
      >
        <Row label='Textures' value={`${d.textures.toLocaleString()} · ${fmt(d.textureMB, 1)} MB`} />
        <Row label='GPU est.' value={`${fmt(d.gpuMB, 1)} MB`} />
        <Row label='JS heap'
             value={d.heapUsedMB != null ? `${fmt(d.heapUsedMB, 0)} / ${fmt(d.heapLimitMB!, 0)} MB` : 'n/a'}
             title={d.heapUsedMB != null ? undefined : 'performance.memory is Chromium-only.'} />
      </Section>

      <Section title='Scene' hint='Counts and the resolution the pipeline is actually shading at.'>
        <Row label='Lights' value={d.lights.toLocaleString()} />
        <Row label='Sprites' value={d.sprites.toLocaleString()} />
        <Row label='Resolution' value={`${d.width}×${d.height}`} />
        {d.renderScale < 1 && (
          <Row label='· internal' value={`${d.renderWidth}×${d.renderHeight} (${fmt(d.renderScale * 100, 0)}%)`}
               title='Render scale is below 100%, so the pipeline shades fewer pixels than the display shows.' />
        )}
        <Row label='Backend' value={d.backend} />
        <Row label='Pipeline' value={d.pipeline} />
      </Section>

      <Section
        title='Quality'
        hint={'Ultra reproduces the engine&apos;s original defaults exactly; High is the current default. '
            + 'Render scale is the internal resolution — halving it quarters every fullscreen pass, so if '
            + 'that barely moves the frame time the frame is not fill-rate bound.'}
      >
        <SegmentedControl
          value={quality}
          options={QUALITY_OPTIONS}
          onChange={v => {
            renderer.quality = v;
            setQuality(v as string);
            setRenderScale(renderer.renderScale);
          }}
        />
        <div className='mt-2'>
          <Slider
            label='Render scale'
            value={renderScale}
            min={0.25}
            max={1}
            step={0.05}
            readout={v => `${Math.round(v * 100)}%`}
            title='Internal resolution. Halving it quarters every fullscreen pass.'
            onChange={v => { renderer.renderScale = v; setRenderScale(renderer.renderScale); }}
          />
        </div>
      </Section>

      <Section
        title='Pass switches'
        hint={"Turn a pass off and watch the frame graph. The drop is that pass's true marginal cost, "
            + 'including downstream savings a GPU timer around the draw call would not capture. The '
            + 'list is the same on every backend on purpose: bisection is exactly the fallback for a '
            + 'cost the timers cannot see, so it must not shrink where the timers are weaker.'}
      >
        <div className='grid grid-cols-2 gap-x-3'>
          {TOGGLEABLE_PASSES.map(name => (
            <Toggle
              key={name}
              label={name}
              checked={passes[name] !== false}
              onChange={v => togglePass(name, v)}
              title={`Disable the ${name} pass and watch the frame graph.`}
            />
          ))}
        </div>
        <div className='mt-2 flex flex-wrap gap-2'>
          <Button onClick={resetPasses} title='Re-enable every pass.'>Enable all</Button>
          <Button onClick={() => gpuProfiler.reset()} title='Clear the accumulated per-pass averages.'>Reset timings</Button>
          <Button onClick={copyReport} title='Copy these numbers as plain text.'>Copy report</Button>
        </div>
      </Section>
      </div>
    </div>
  );
}
