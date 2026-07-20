import { useEffect, useState } from 'react';
import { TextureManager, sceneStatsDetail } from 'cleo';
import { useCleoEngine } from '../EngineContext';

// Live performance HUD shown top-right in renderer mode. Runs its own requestAnimationFrame loop to
// measure FPS/frame-time (all rAF callbacks fire once per display frame, so the interval = real FPS),
// and reads the engine's per-frame counters (renderer.stats), texture registry, scene counts and JS
// heap. Display state updates ~4x/sec (not every frame) to avoid churning React.

const MB = 1024 * 1024;
const fmt = (x: number, dp = 0) => x.toLocaleString(undefined, { maximumFractionDigits: dp, minimumFractionDigits: dp });

type Display = {
  fps: number; frameMs: number; renderMs: number;
  drawCalls: number; instancedDrawCalls: number; objects: number; instances: number; triangles: number;
  physicsMs: number; stepMs: number; writeBackMs: number; rayMs: number; rayCount: number;
  bodies: number; contacts: number;
  sceneMs: number; transformMs: number; scriptMs: number; animatorMs: number; rigMs: number; nodes: number;
  textures: number; textureMB: number; gpuMB: number;
  heapUsedMB: number | null; heapLimitMB: number | null;
  lights: number; sprites: number; width: number; height: number; pipeline: string;
};

function Row(props: { label: string; value: string; hl?: boolean }) {
  return (
    <div className='flex justify-between gap-3 leading-5'>
      <span className='text-muted'>{props.label}</span>
      <span className={`font-mono ${props.hl ? 'text-success font-semibold' : ''}`}>{props.value}</span>
    </div>
  );
}

const Divider = () => <div className='my-1 border-t border-control' />;

export default function RendererStats() {
  const { instance } = useCleoEngine();
  const [d, setD] = useState<Display | null>(null);
  const [detail, setDetail] = useState(sceneStatsDetail.enabled);

  useEffect(() => {
    let raf = 0, frames = 0, acc = 0, last = performance.now();

    const sample = (fps: number, frameMs: number): Display => {
      const stats: any = instance?.renderer ? (instance.renderer as any).stats : null;
      // Physics only steps in Play mode (the editing scene's nodes have no bodies), so these read 0
      // while stopped — that is the honest answer, not a missing value.
      const phys: any = instance?.physics ? (instance.physics as any).stats : null;
      const scene: any = instance?.scene ?? null;
      const sceneS: any = scene ? (scene as any).stats : null;
      let textures = 0, textureBytes = 0;
      try {
        const map = TextureManager.Instance.textures;
        textures = map.size;
        for (const t of map.values()) textureBytes += (t as any).byteSize ?? 0;
      } catch { /* ignore */ }
      const mem = (performance as any).memory;
      return {
        fps, frameMs, renderMs: stats?.frameMs ?? 0,
        drawCalls: stats?.drawCalls ?? 0,
        instancedDrawCalls: stats?.instancedDrawCalls ?? 0,
        objects: stats?.objects ?? 0,
        instances: stats?.instances ?? 0,
        triangles: Math.round(stats?.triangles ?? 0),
        physicsMs: phys?.frameMs ?? 0,
        stepMs: phys?.stepMs ?? 0,
        writeBackMs: phys?.writeBackMs ?? 0,
        rayMs: phys?.rayMs ?? 0,
        rayCount: phys?.rayCount ?? 0,
        bodies: phys?.bodies ?? 0,
        contacts: phys?.contacts ?? 0,
        sceneMs: sceneS?.frameMs ?? 0,
        transformMs: sceneS?.transformMs ?? 0,
        scriptMs: sceneS?.scriptMs ?? 0,
        animatorMs: sceneS?.animatorMs ?? 0,
        rigMs: sceneS?.rigMs ?? 0,
        nodes: sceneS?.nodes ?? 0,
        textures, textureMB: textureBytes / MB,
        gpuMB: (stats?.gpuBytes ?? 0) / MB,
        heapUsedMB: mem ? mem.usedJSHeapSize / MB : null,
        heapLimitMB: mem ? mem.jsHeapSizeLimit / MB : null,
        lights: scene?.lights?.size ?? 0,
        sprites: scene?.sprites?.size ?? 0,
        width: stats?.width ?? 0, height: stats?.height ?? 0,
        pipeline: stats?.pipeline ?? '—',
      };
    };

    const tick = () => {
      const now = performance.now();
      acc += now - last; last = now; frames++;
      if (acc >= 250) { // refresh the display ~4x/sec
        setD(sample((frames * 1000) / acc, acc / frames));
        frames = 0; acc = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [instance]);

  return (
    <div data-cleo-overlay className='absolute top-2 right-2 z-20 w-52 bg-surface-raised/95 border border-control rounded-md p-3 text-white shadow-lg select-none text-[11px]'>
      <div className='font-semibold text-sm mb-2'>Performance</div>
      {!d ? <div className='text-muted'>Sampling…</div> : (
        <>
          <Row label='FPS' value={fmt(d.fps)} hl />
          <Row label='Frame' value={`${fmt(d.frameMs, 1)} ms`} />
          <Row label='Render (CPU)' value={`${fmt(d.renderMs, 1)} ms`} />
          <Divider />
          <Row label='Draw calls' value={fmt(d.drawCalls)} />
          <Row label='Instanced' value={fmt(d.instancedDrawCalls)} />
          <Row label='Objects' value={fmt(d.objects)} />
          <Row label='Instances' value={fmt(d.instances)} />
          <Row label='Triangles' value={fmt(d.triangles)} />
          <Divider />
          {/* Split rather than one total on purpose: `step` is cannon's solver (the part a worker
              could take off this thread) while `write-back` is scene-graph sync that would stay
              here regardless. Deciding whether physics belongs in a worker needs them apart. */}
          <Row label='Physics' value={`${fmt(d.physicsMs, 2)} ms`} hl={d.physicsMs > 5} />
          <Row label='· step' value={`${fmt(d.stepMs, 2)} ms`} />
          <Row label='· write-back' value={`${fmt(d.writeBackMs, 2)} ms`} />
          <Row label='· rays' value={`${fmt(d.rayMs, 2)} ms · ${fmt(d.rayCount)}`} />
          <Row label='Bodies' value={`${fmt(d.bodies)} · ${fmt(d.contacts)} contacts`} />
          <Divider />
          {/* The slice between physics and render: scripts, animators, transform propagation and
              camera rigs. With Render and Physics above, the frame is now fully attributed. */}
          <Row label='Scene' value={`${fmt(d.sceneMs, 2)} ms`} hl={d.sceneMs > 5} />
          <Row label='· transforms' value={`${fmt(d.transformMs, 2)} ms`} />
          <Row label='· rigs' value={`${fmt(d.rigMs, 2)} ms`} />
          {detail && <>
            <Row label='· scripts' value={`${fmt(d.scriptMs, 2)} ms`} />
            <Row label='· animators' value={`${fmt(d.animatorMs, 2)} ms`} />
          </>}
          {/* Off by default: two performance.now() per node per frame inflates Scene/nodeLoop by
              50-160%, so it would corrupt the totals above if it were always on. */}
          <button
            className='w-full text-left text-muted hover:text-white leading-5'
            onClick={() => { sceneStatsDetail.enabled = !detail; setDetail(!detail); }}
            title='Times each node&apos;s onUpdate and animator separately. Costs ~240ns per node per frame, which inflates the Scene total while enabled.'
          >
            {detail ? '− hide script/animator split' : '+ script/animator split'}
          </button>
          <Row label='Nodes' value={fmt(d.nodes)} />
          <Divider />
          {/* Whatever the three measured phases do not account for: browser work, GPU sync, rAF idle. */}
          <Row label='Unattributed' value={`${fmt(Math.max(0, d.frameMs - d.renderMs - d.physicsMs - d.sceneMs), 2)} ms`} />
          <Divider />
          <Row label='Textures' value={`${fmt(d.textures)} · ${fmt(d.textureMB, 1)} MB`} />
          <Row label='GPU est.' value={`${fmt(d.gpuMB, 1)} MB`} />
          <Row label='JS heap' value={d.heapUsedMB != null ? `${fmt(d.heapUsedMB)} / ${fmt(d.heapLimitMB!)} MB` : 'n/a'} />
          <Divider />
          <Row label='Lights' value={fmt(d.lights)} />
          <Row label='Sprites' value={fmt(d.sprites)} />
          <Row label='Resolution' value={`${d.width}×${d.height}`} />
          <Row label='Pipeline' value={d.pipeline} />
        </>
      )}
    </div>
  );
}
