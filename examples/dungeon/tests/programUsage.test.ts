import { describe, it, expect } from 'vitest';
import '@engine-tests/helpers/features';
import { createProgramUsage, usageFromSceneJson, programsFor, castsShadows } from '@engine/graphics/programUsage';
import { dataReady, readThisExample } from '@tools/exampleKit/testKit';

// A published game builds only the programs `programsFor` lists (src/graphics/programUsage.ts; its other tests are
// tests/programUsage.test.ts): the Dungeon's knight and enemies are skinned.

describe.skipIf(!dataReady())('programsFor the Dungeon', () => {
    it('lists the skinned programs for the Dungeon, whose knight and enemies are skinned', async () => {
        const { bundle } = await readThisExample();
        const DUNGEON = bundle.scenes[bundle.manifest.mainSceneId];
        const use = createProgramUsage();
        usageFromSceneJson(DUNGEON.scene, use, castsShadows(DUNGEON.scene));
        const list = programsFor(use);
        for (const name of ['pbrSkinned~pcf', 'pbrGeometrySkinned~flat', 'pbrGeometry~flat']) expect(list, name).toContain(name);
    });
});
