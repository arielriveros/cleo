import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractEmbeddedClips, type AnimationAsset } from '../src/utils/animationAssets';
import { extractRigs, moveClipsToRigs } from '../src/utils/rigMigration';
import { skinnedModelJsonOf, skinnedModelJsonsOf } from '../src/utils/modelClips';
import { registerRigResolver, resolveModelAnimations, invalidateAnimationCache } from '../src/utils/animationResolve';
import { sourceSkinFor, type RigAsset } from '../src/utils/rigAssets';
import { attachSharedClips } from '../src/features/publish/buildGameData';
import { attachTemplateAnimations } from '../src/player/animations';

/**
 * The Night Shift example against the editor's OWN migration and resolve code, not against a reading of
 * what those are supposed to produce.
 *
 * tests/nightShiftProject.test.ts checks the generated folder's shape. This checks the two things that
 * shape exists to make true, and that only the real implementations can answer:
 *
 *  - **The bundle boots clean.** Every migration `EngineContext` runs at project load must be a NO-OP.
 *    A generator that ships a nearly-migrated shape is worse than one that ships the old shape, because
 *    the migrations then mutate a project the author believes is finished — `moveClipsToRigs` in
 *    particular resolves a clip-name collision by SKIPPING the loser and only reporting it.
 *  - **Both characters really do end up playing the same clips.** That is the whole point of the
 *    rebuild, and it is decided by a retarget that no JSON inspection can stand in for.
 *
 * Skipped rather than failed when the folder is absent, as bundleAssetsRealProject.test.ts is.
 */

const DIR = path.join(__dirname, '..', 'public', 'examples', 'night-shift');
const present = fs.existsSync(path.join(DIR, 'manifest.json'));

const lib = (n: string) => JSON.parse(fs.readFileSync(path.join(DIR, 'libraries', `${n}.json`), 'utf8'));

describe.skipIf(!present)('the Night Shift example on rigs', () => {
    const models = () => lib('models');
    const rigs = (): RigAsset[] => lib('rigs');
    const animations = (): AnimationAsset[] => lib('animations');

    /** Clip names an animation asset contributes — what `moveClipsToRigs` detects collisions with. */
    const clipNamesOf = (id: string) =>
        (animations().find(a => a.id === id)?.clips ?? []).map(c => c.name);

    describe('the migrations EngineContext runs at load', () => {
        it('finds no clip left to extract', () => {
            const result = extractEmbeddedClips(
                models(), animations(), skinnedModelJsonOf,
                (asset: any) => asset,   // never reached: nothing should be extracted
            );
            expect(result.extracted).toBe(0);
            expect(result.shared).toBe(0);
        });

        it('finds no rig left to mint, and nothing left to link', () => {
            const result = extractRigs(models(), animations(), rigs(), skinnedModelJsonsOf);
            expect(result.created).toBe(0);
            expect(result.linkedModels).toBe(0);
            expect(result.linkedAnimations).toBe(0);
            // Idempotence also means it did not decide one of the shipped rigs was richer and rewrite it.
            expect(result.rigs).toHaveLength(rigs().length);
        });

        it('finds no clip left to move up to a rig, and no field left to re-point', () => {
            const result = moveClipsToRigs(models(), rigs(), lib('animationFields'), clipNamesOf);
            expect(result.moved).toBe(0);
            expect(result.repointed).toBe(0);
            // Vacuous while nothing moves — the clips already belong to the rigs, so there is nothing for
            // this pass to collide. The collision that DOES threaten a shared clip set is caught below,
            // by resolving both characters for real.
            expect(result.clashes).toEqual([]);
        });
    });

    describe('what each character actually ends up playing', () => {
        beforeAll(() => {
            const byId = new Map(rigs().map(r => [r.id, r]));
            registerRigResolver(id => byId.get(id) ?? null);
        });
        afterAll(() => { registerRigResolver(null); invalidateAnimationCache(); });

        it('gives both characters the same clip set, retargeted onto their own skeletons', () => {
            const resolved = models().map((m: any) => ({
                name: m.name,
                clips: resolveModelAnimations(m, animations()),
            }));
            expect(resolved).toHaveLength(2);

            const names = resolved.map(r => r.clips.map(c => c.name).sort());
            expect(names[0].length).toBeGreaterThan(0);
            expect(names[0]).toEqual(names[1]);

            // Every clip in the library reaches every character. Two rigs, one clip set — which works
            // only because `normalizeBoneName` strips the `mixamorigN:` namespace the two exports differ
            // by, so a curve authored on either matches the other by bone name.
            expect(names[0]).toEqual(animations().flatMap(a => a.clips.map(c => c.name)).sort());
        });

        it('never de-dupes a clip name, which is how a shared set fails quietly', () => {
            // `AnimatedModel.addAnimation` resolves a repeat to `Idle (2)` — a name no state machine and
            // no blend-space sample says. Duplicates here are exactly what the `Zombie ` prefix prevents.
            for (const model of models()) {
                const names = resolveModelAnimations(model, animations()).map(c => c.name);
                expect(new Set(names).size, `${model.name} has a repeated clip name`).toBe(names.length);
            }
        });

        /**
         * The zombie is never PLACED. It only ever exists as `scene.instantiate('Zombie')`, which
         * deep-copies the baked template JSON — so nothing that runs at scene load can reach it, and
         * `AnimatedModel.serialize` has already dropped its asset-backed clips from every scene blob.
         *
         * Both runtimes therefore have to bake the clips into the template subtree itself, and they do
         * it in different places: editor play through `attachSharedClips`, the published player through
         * `attachTemplateAnimations`. These check that a spawned enemy actually gets a clip set, because
         * the failure is a horde of T-posing zombies with nothing logged.
         */
        describe('a character that only ever arrives through scene.instantiate', () => {
            const zombieTemplate = () =>
                JSON.parse(JSON.stringify(lib('templates').find((t: any) => t.name === 'Zombie')));

            /** The clip names the Zombie state machine resolves against the live model. */
            const wantedClips = (nodeJson: any): string[] => {
                const out: string[] = [];
                const walk = (n: any) => {
                    for (const s of n.stateMachine?.states ?? []) if (s.clipName) out.push(s.clipName);
                    for (const c of n.children ?? []) walk(c);
                };
                walk(nodeJson);
                return out;
            };

            it('gets its clips baked in for editor play', () => {
                const template = zombieTemplate();
                const ch10 = template.nodeJson.children.find((c: any) => c.type === 'model');
                expect(ch10.model.animations, 'the template must ship with no embedded clips').toBeNull();

                const patched = attachSharedClips(template.nodeJson, models(), animations());
                expect(patched).toBe(1);

                const names = ch10.model.animations.map((c: any) => c.name);
                expect(new Set(names).size).toBe(names.length);
                for (const clip of wantedClips(template.nodeJson))
                    expect(names, `the machine asks for "${clip}"`).toContain(clip);
            });

            it('gets its clips baked in for the published player', () => {
                // The pack shape `buildMultiSceneGameData` produces: clips once at the top level with the
                // rig flattened into each one, plus model -> animation ids.
                const rigClips = new Map(rigs().map(r => [r.id, r.animationIds ?? []]));
                const modelAnimations: Record<string, string[]> = {};
                for (const m of models())
                    modelAnimations[m.id] = [...(m.rigId ? rigClips.get(m.rigId) ?? [] : [])];
                const data = {
                    animations: animations().map(a => ({ ...a, sourceSkin: sourceSkinFor(a, rigs()) })),
                    modelAnimations,
                } as any;

                const template = zombieTemplate();
                const ch10 = template.nodeJson.children.find((c: any) => c.type === 'model');
                attachTemplateAnimations([{ name: template.name, node: template.nodeJson }], data);

                const names = ch10.model.animations.map((c: any) => c.name);
                expect(new Set(names).size).toBe(names.length);
                for (const clip of wantedClips(template.nodeJson))
                    expect(names, `the machine asks for "${clip}"`).toContain(clip);
            });
        });

        it('bakes the placed player its clips too, which serialize had dropped', () => {
            // The mannequin IS placed, so the published player reaches it through `attachSharedAnimations`
            // at scene load. Editor play has no such pass, and `AnimatedModel.serialize` strips every
            // asset-backed clip on the way into the play JSON — so without this the player T-posed the
            // moment its clips moved onto a rig.
            const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
            const scene = JSON.parse(
                fs.readFileSync(path.join(DIR, 'scenes', `${manifest.mainSceneId}.json`), 'utf8'));

            const patched = attachSharedClips(scene.scene, models(), animations());
            expect(patched).toBeGreaterThan(0);

            const find = (n: any, name: string): any =>
                n.name === name ? n : (n.children ?? []).reduce((a: any, c: any) => a ?? find(c, name), null);
            const ch36 = find(scene.scene, 'Ch36');
            const names = ch36.model.animations.map((c: any) => c.name);
            for (const clip of ['Idle', 'Run', 'Walk', 'RunStrafeLeft', 'WalkBackwards'])
                expect(names, clip).toContain(clip);
        });

        it('stamps every resolved clip with the asset it came from', () => {
            // `AnimatedModel.serialize` drops a clip carrying `assetId`. That stamp is what stops a
            // resolved clip being written back into a scene, a template or a published build — which
            // would re-create the embedded copies this rebuild removed.
            for (const model of models())
                for (const clip of resolveModelAnimations(model, animations()) as any[])
                    expect(clip.assetId, `${model.name}/${clip.name}`).toBeTruthy();
        });
    });
});
