// A project folder published as a web game, in memory, the way the editor's Publish ▸ Web does it
// (features/publish/publishClient.ts): the player's page and modules (applications/editor/public/player, built by
// `npm run build:player`), the game's shaders, game.bin and game.scripts.js. The host runs the very same game.bin,
// so the game a browser opens and the one the host runs have one content hash.
//
// For development and the guides: `cleo-host --example <folder> --serve` publishes the example, hosts it and
// serves the page, ready to join.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURES, programModules } from 'cleo';
import { packGameBin } from '../../editor/src/features/publish/pack';
import { buildScriptsSource, extractScripts } from '../../editor/src/features/publish/extractScripts';
import { playerFeaturesFor, playerFilesFor, withModulePreloads, type PlayerBuild } from '../../editor/src/features/publish/playerManifest';
import { selectShaders } from '../../editor/src/features/publish/shaderSelection';
import { exampleGameData, type ExampleGameOptions } from './exampleGame';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Where `npm run build:player` leaves the player. */
export const PLAYER_DIR = path.resolve(here, '../../editor/public/player');

export interface WebBuild {
    /** game.bin, as the host loads it too. */
    bin: Uint8Array;
    /** game.scripts.js. */
    scripts: string;
    /** Every file of the published game by its path in the game's folder (index.html, game.js, chunks/…, game.bin…). */
    files: Map<string, Uint8Array>;
}

/** Publish the project folder at `dir` as a web game. Every engine feature is in (an example has no feature list). */
export async function buildExampleWeb(dir: string, options: ExampleGameOptions = {}): Promise<WebBuild> {
    const buildFile = path.join(PLAYER_DIR, 'build.json');
    if (!existsSync(buildFile)) throw new Error(`No player build at ${PLAYER_DIR}: run "npm run build:player" first.`);
    const build: PlayerBuild = JSON.parse(readFileSync(buildFile, 'utf8'));

    const data = await exampleGameData(dir, options);
    data.config.features = FEATURES.map((f) => f.id).sort();
    const wanted = playerFilesFor(build, playerFeaturesFor(data.config, build));
    const library = JSON.parse(readFileSync(path.join(PLAYER_DIR, build.shaders!.file), 'utf8')).modules;
    data.shaderLibrary = selectShaders(library, {
        programs: data.config?.graphics?.programs,
        programModules: programModules(),
        webgl2: data.config?.graphics?.webgl2 !== false,
        leaveOut: new Set(),
    });
    const { scripts, paths, modules } = extractScripts(data);
    const scriptsJs = buildScriptsSource(scripts, paths, modules);
    const bin = new Uint8Array(packGameBin(data).buffer);

    const files = new Map<string, Uint8Array>();
    const text = (s: string) => new TextEncoder().encode(s);
    files.set('index.html', text(withModulePreloads(readFileSync(path.join(PLAYER_DIR, 'index.html'), 'utf8'), build, wanted)));
    for (const f of wanted) files.set(f, new Uint8Array(readFileSync(path.join(PLAYER_DIR, f))));
    files.set('game.bin', bin);
    files.set('game.scripts.js', text(scriptsJs));
    return { bin, scripts: scriptsJs, files };
}
