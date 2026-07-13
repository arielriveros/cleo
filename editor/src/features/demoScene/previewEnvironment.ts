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
export async function applyPreviewEnvironment(scene: Scene, opts?: { skybox?: boolean }): Promise<void> {
  try {
    const faces = await loadFaces();
    if (!envmap) {
      envmap = new Texture({ target: 'cubemap', flipY: true });
      envmap.create(faces, faces.posX.width, faces.posX.height);
    }
    scene.environmentMap = envmap;
    if (opts?.skybox !== false) {
      // Each scene gets its own Skybox: SkyboxNode.initializeSkybox() is per-node lazy VAO setup, so
      // sharing one Skybox instance across scenes would re-initialize the same mesh.
      scene.addNode(new SkyboxNode('__editor__skybox', new Skybox(faces)));
    }
  } catch (e) {
    console.error('Failed to load preview environment:', e);
  }
}
