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

// Face mapping: posX=right, negX=left, posY=top, negY=bottom, posZ=front, negZ=back.
// Loaded once per session; every preview scene shares them.
let facesPromise: Promise<Faces> | null = null;
function loadFaces(): Promise<Faces> {
  if (!facesPromise) {
    facesPromise = Promise.all(
      [rightUrl, leftUrl, topUrl, bottomUrl, frontUrl, backUrl].map(url => Loader.loadImage(url))
    ).then(([posX, negX, posY, negY, posZ, negZ]) => ({ posX, negX, posY, negY, posZ, negZ }));
  }
  return facesPromise;
}

// One shared env-map cubemap for every preview scene; a GL texture is context-global and the editor
// renders everything in one context.
let envmap: Texture | null = null;

/**
 * ONE skybox for every preview scene. A `Skybox` uploads its own 2048² cubemap — six faces plus mips,
 * ~130 MB of GPU memory and a ~250 ms synchronous upload — and nothing ever frees it. Built per preview,
 * every material / model / landscape-material tab (and "+ New …", which opens one) stacked another copy
 * until the GPU ran out of memory and the whole machine stalled. Shared like `envmap` above: the preview
 * scenes only ever draw it, and nothing disposes a SkyboxNode's skybox.
 */
let previewSkybox: Skybox | null = null;

/**
 * Give a preview scene the editor's environment cubemap: `scene.environmentMap` drives reflections, and
 * unless `skybox: false` a SkyboxNode draws it as the background. Thumbnail scenes pass `skybox: false`.
 * Resolves once the environment is applied; never rejects — a failed load leaves the scene as-is.
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
    // Only this synchronous block is wrapped, never the await: holding `silently` across the await
    // would swallow genuine edits made while the cubemap is still loading.
    const run = opts?.silently ?? (<T,>(fn: () => T): T => fn());
    run(() => {
      scene.environmentMap = envmap;
      if (opts?.skybox !== false) {
        // Each scene needs its own Skybox: initializeSkybox() is per-node lazy VAO setup, and sharing
        // one instance would re-initialize the same mesh.
        if (!previewSkybox) previewSkybox = new Skybox(faces);
        scene.addNode(new SkyboxNode('__editor__skybox', previewSkybox));
      }
    });
  } catch (e) {
    console.error('Failed to load preview environment:', e);
  }
}
