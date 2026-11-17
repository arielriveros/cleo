// The water flow bake, off the main thread (water/bake/shallowWater.ts): the editor prepares the setup (it
// reads the scene: ground, obstacles, joined water), this runs the solver, reporting progress, and posts the
// settled water back. One worker per bake; cancelling terminates it.
import { ShallowWaterBake, type WaterBakeSetup } from 'cleo/water/bake/shallowWater';

self.onmessage = (event: MessageEvent<{ setup: WaterBakeSetup }>) => {
  try {
    const bake = new ShallowWaterBake(event.data.setup);
    let last = 0;
    while (!bake.done) {
      bake.step(25);
      const now = performance.now();
      if (now - last > 100) { (self as any).postMessage({ progress: bake.progress }); last = now; }
    }
    const info = bake.result();
    (self as any).postMessage({ info }, [info.info0.buffer, info.info1.buffer]);
  } catch (e) {
    (self as any).postMessage({ error: e instanceof Error ? e.message : String(e) });
  }
};
