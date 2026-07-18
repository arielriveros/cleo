import { Scene, Skybox, SkyboxNode, Texture, Loader } from 'cleo';
import rightUrl from '../../images/cubemap/right.jpg';
import leftUrl from '../../images/cubemap/left.jpg';
import topUrl from '../../images/cubemap/top.jpg';
import bottomUrl from '../../images/cubemap/bottom.jpg';
import frontUrl from '../../images/cubemap/front.jpg';
import backUrl from '../../images/cubemap/back.jpg';

type Faces = {
  posX: HTMLImageElement; negX: HTMLImageElement;
  posY: HTMLImageElement; negY: HTMLImageElement;
  posZ: HTMLImageElement; negZ: HTMLImageElement;
};

// Cubemap face images (posX=right, negX=left, posY=top, negY=bottom, posZ=front, negZ=back — the same
// mapping the demo scene uses). Loaded once per session; every preview scene shares them.
let facesPromise: Promise<Faces> | null = null;
function loadFaces(): Promise<Faces> {
  if (!facesPromise) {
    facesPromise = Promise.all(
      [rightUrl, leftUrl, topUrl, bottomUrl, frontUrl, backUrl].map(url => Loader.loadImage(url))
    ).then(([posX, negX, posY, negY, posZ, negZ]) => ({ posX, negX, posY, negY, posZ, negZ }));
  }
  return facesPromise;
}

// One shared env-map cubemap for every preview scene (a GL texture is context-global and the editor
// renders everything in one context), so thumbnail batches don't re-upload six faces per capture.
let envmap: Texture | null = null;

/**
 * Give a preview scene the editor's environment cubemap: `scene.environmentMap` drives reflections on
 * PBR/Blinn materials, and (unless `skybox: false`) a SkyboxNode draws it as the background. The two are
 * independent in the engine — thumbnail captures (Renderer.screenshotOffscreen) skip every background
 * draw but still bind the environment map, so thumbnails keep the reflections without the sky. Thumbnail
 * scenes pass `skybox: false` to also skip the per-scene Skybox upload the renderer would never draw.
 * Resolves once the environment is applied; never rejects (a failed load just leaves the scene as-is).
 */
export async function applyPreviewEnvironment(
  scene: Scene,
  opts?: { skybox?: boolean; silently?: <T>(fn: () => T) => T },
): Promise<void> {
  try {
    const faces = await loadFaces();
    if (!envmap) {
      envmap = new Texture({ target: 'cubemap', flipY: true });
      envmap.create(faces, faces.posX.width, faces.posX.height);
    }
    // The scene mutation is wrapped rather than the whole function on purpose. Adding the SkyboxNode
    // emits SCENE_CHANGED, which the editor reads as "the user edited something" — and because the faces
    // load asynchronously, that lands long after the opening settle window has re-armed dirty-tracking,
    // marking a tab the user has not touched as unsaved. Callers pass `silently` (EngineContext's
    // withoutDirty) to suppress it. Wrapping only this synchronous block, rather than holding the
    // suppression across the await, keeps the window at zero: a genuine edit made while the cubemap is
    // still loading still marks the tab dirty.
    const run = opts?.silently ?? (<T,>(fn: () => T): T => fn());
    run(() => {
      scene.environmentMap = envmap;
      if (opts?.skybox !== false) {
        // Each scene gets its own Skybox: SkyboxNode.initializeSkybox() is per-node lazy VAO setup, so
        // sharing one Skybox instance across scenes would re-initialize the same mesh.
        scene.addNode(new SkyboxNode('__editor__skybox', new Skybox(faces)));
      }
    });
  } catch (e) {
    console.error('Failed to load preview environment:', e);
  }
}
