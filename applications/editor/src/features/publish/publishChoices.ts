// What a publish makes of Options ▸ Project ▸ Published game: the scenes the game carries and the graphics config it
// starts the engine with. Pure, so the tests read the same decisions the build makes (buildMultiSceneGameData).

/** The scene a published game starts in: the main scene when it is one of `sceneIds`, else the first of them. */
export function publishedStartScene(sceneIds: readonly string[], mainSceneId: string): string | undefined {
  return sceneIds.includes(mainSceneId) ? mainSceneId : sceneIds[0];
}

/** Whether a scene ships: every scene but the ones left out, and the start scene always. */
export function shipsScene(id: string, startId: string | undefined, excluded: ReadonlySet<string>): boolean {
  return id === startId || !excluded.has(id);
}

/**
 * The graphics parts of a published game's config a publish decides: the API it runs on (absent: the player's
 * page decides, as Play in window does), and `webgl2: false` for a game that ships no WebGL 2 shaders. A game made
 * to run on WebGL 2 always ships them, whatever the fallback switch says.
 */
export function publishedGraphics(backend: 'webgpu' | 'webgl2' | undefined, webgl2Fallback: boolean | undefined): { backend?: 'webgpu' | 'webgl2'; webgl2?: false } {
  const out: { backend?: 'webgpu' | 'webgl2'; webgl2?: false } = {};
  if (backend) out.backend = backend;
  if (webgl2Fallback === false && backend !== 'webgl2') out.webgl2 = false;
  return out;
}
