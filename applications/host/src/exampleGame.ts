// A game.bin built straight from a project folder in the editor's bundle format (the checked-in examples under
// applications/editor/public/examples): for running a game on the host during development, and for the host's
// tests, without opening the editor to publish it.
//
// The same game data a Play-in-window pack carries — scenes, baked templates (scripts injected, materials
// resolved), the shared animation clips, the input map — packed with the editor's own packer. Scripts stay source
// (the engine compiles them at parse), textures and sounds are left out (the host never draws or plays them).
// What it does NOT do that Publish does: re-resolve scenes against the asset libraries, strip features, stamp
// dimensions. Fine for the checked-in examples, which are saved resolved.

import path from 'node:path';
import { readExample } from '../../../tools/exampleKit/readExample.mjs';
import { packGameBin } from '../../editor/src/features/publish/pack';
import { attachScriptModules, bakeTemplates } from '../../editor/src/features/publish/buildGameData';
import { sharedAnimationData } from '../../editor/src/features/publish/sharedAnimations';

export interface ExampleGameOptions {
    /** Physics backend to record in the game's config. Default: the engine's default. */
    physicsBackend?: string;
    /** Change the game data before it is packed (a test raising a match's bot count, say). */
    edit?: (data: Record<string, any>) => void;
}

/** Pack the project folder at `dir` into game.bin bytes. */
export async function packExampleGame(dir: string, options: ExampleGameOptions = {}): Promise<Uint8Array> {
    const { bundle } = await readExample(path.resolve(dir));
    const libs = bundle.libraries ?? {};
    const scenes: Record<string, { name: string; scene: unknown }> = {};
    for (const meta of bundle.manifest.sceneMetas ?? []) {
        const file = bundle.scenes?.[meta.id];
        if (file?.scene) scenes[meta.id] = { name: meta.name, scene: structuredClone(file.scene) };
    }
    const entry = bundle.manifest.mainSceneId in scenes ? bundle.manifest.mainSceneId : Object.keys(scenes)[0];
    if (!entry) throw new Error(`${dir} has no scenes`);

    const data: Record<string, any> = {
        version: 2,
        entry,
        scenes,
        templates: bakeTemplates(libs.templates ?? [], libs.materials, libs.scripts),
        textureBytes: [],
    };
    // Script modules (shared code scripts import), as the editor resolves them: each script asset's path in the
    // project's file tree, every scene and template stamped with its scripts' paths, the import closure shipped.
    const scriptPaths = new Map<string, string>(
        (bundle.vfs?.entries ?? []).filter((e: any) => e.kind === 'script').map((e: any) => [e.assetId, e.path] as [string, string]));
    if (libs.scripts?.length && scriptPaths.size) {
        const all: any = { scene: { children: Object.values(scenes).map((e) => e.scene) }, templates: data.templates };
        attachScriptModules(all, libs.scripts, scriptPaths);
        if (all.modules) data.modules = all.modules;
    }
    const shared = sharedAnimationData(libs);
    if (shared.animations.length) {
        data.animations = shared.animations;
        data.modelAnimations = shared.modelAnimations;
        if (shared.retargets) data.retargets = shared.retargets;
    }
    const config: Record<string, any> = {};
    if (libs.inputMap) config.input = libs.inputMap;
    if (options.physicsBackend) config.physics = { backend: options.physicsBackend };
    data.config = config;
    options.edit?.(data);
    return new Uint8Array(packGameBin(data).buffer);
}
