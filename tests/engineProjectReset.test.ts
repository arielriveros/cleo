import { describe, it, expect } from 'vitest';
import { PhysicsSystem } from '../src/physics/physicsSystem';
import { TextureManager } from '../src/graphics/systems/textureManager';
import { LoopbackPort } from '../src/physics/worker/ports';
import { makeBody, sphere } from './helpers/physicsBodies';

// What the editor needs of the engine to open another project in the same window (applications/editor's
// features/projects/projectSwitch.ts): a physics system it can let go of, and textures it can drop.

describe('closing a project in a running engine', () => {
  it('disposes a physics system: its bodies, its worker and its world', () => {
    const p = new PhysicsSystem({ gravity: [0, -9.81, 0], backend: 'cannon' });
    p.initialize();
    (p as any)._scene = { nodes: [], landscapes: [], tilemaps: [], activeCamera: null };
    const port = new LoopbackPort();
    p.setWorkerMode('on', () => port);
    const body = makeBody(sphere(0.5), { mass: 1, position: [0, 2, 0] });
    p.addBody(body);
    p.update(1 / 60);
    p.endFrame(1 / 60);
    p.dispose();
    expect(p.hasBody(body)).toBe(false);
    expect(p.capabilities).toBeNull();
    // Nothing steps or throws once it is gone.
    expect(() => p.update(1 / 60)).not.toThrow();
  });

  it('lets go of its scene, keeping its world, until another is bound', () => {
    const p = new PhysicsSystem({ gravity: [0, -9.81, 0], backend: 'cannon' });
    p.initialize();
    const scene = { nodes: [], landscapes: [], tilemaps: [], activeCamera: null } as any;
    p.scene = scene;
    p.addBody(makeBody(sphere(0.5), { mass: 1 }));
    p.releaseScene();
    expect(p.bodies.length).toBe(0);
    expect(p.capabilities).not.toBeNull();
    expect(() => p.update(1 / 60)).not.toThrow();
  });

  it('drops every texture but the ones kept, freeing each one\'s GPU texture', () => {
    const tm = TextureManager.Instance;
    const freed: string[] = [];
    const fake = (id: string) => ({ delete: () => freed.push(id), revokeObjectUrl: () => {} }) as any;
    for (const id of ['Null', '__editor__light_icon', 'project-albedo', 'project-normal']) tm.addTexture(fake(id), id);
    const before = tm.imageRevision;
    tm.clearExcept(new Set(['Null', '__editor__light_icon']));
    expect([...tm.textures.keys()].filter(id => ['Null', '__editor__light_icon', 'project-albedo', 'project-normal'].includes(id)).sort())
      .toEqual(['Null', '__editor__light_icon']);
    expect(freed.sort()).toEqual(['project-albedo', 'project-normal']);
    expect(tm.imageRevision).toBeGreaterThan(before);
  });
});
