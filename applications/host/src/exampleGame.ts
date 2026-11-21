// A game.bin built straight from a project on disk (an example folder in examples/, or a bundle in the editor's
// format): for running a game on the host during development, and for tests, without opening the editor to
// publish it. The game data is what Play in window packs (applications/editor/src/features/publish/projectGameData.ts).

import path from 'node:path';
import { readExample } from '../../../tools/exampleKit/readExample.mjs';
import { packGameBin } from '../../editor/src/features/publish/pack';
import { projectGameData, type ProjectGameOptions } from '../../editor/src/features/publish/projectGameData';

export type ExampleGameOptions = ProjectGameOptions;

/** Pack the project at `dir` into game.bin bytes. */
export async function packExampleGame(dir: string, options: ExampleGameOptions = {}): Promise<Uint8Array> {
    return new Uint8Array(packGameBin(await exampleGameData(dir, options)).buffer);
}

/** The game data of the project at `dir`, as the editor's Play in window builds it, before packing. */
export async function exampleGameData(dir: string, options: ExampleGameOptions = {}): Promise<Record<string, any>> {
    const { bundle } = await readExample(path.resolve(dir));
    return projectGameData(bundle, options);
}
