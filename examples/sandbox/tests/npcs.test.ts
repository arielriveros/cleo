import { describe, expect, it } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { TEST_PHYSICS } from '@engine-tests/helpers/testPhysics';
import { ALL, AWAY, DEG, SANDBOX_AI_DETAIL, TICK, actionsOf, finite, planar, play, present, reactionTrail, shoot, useNpcHooks } from './npcKit';

// The Sandbox's NPCs, played: the game as Play in window packs it, run headless on the host runtime (real models,
// their animators and reactions, the scripts, physics on the game clock), with only the NPCs a test asks for.
//
//   Civilian (blue)  SandboxCivilian: waits at what there is to look at, walks off elsewhere, looks at the player
//                    and moves on, runs from shots and cars
//   Enemy (red)      SandboxEnemy: patrols a route in pairs with a rifle, shoots the player on sight (the shotgun
//                    within 3 m, the pistol while hurt), takes cover when shot at, strafes off the path of a car
//                    the player drives
//
// Both are SandboxNpc, a SandboxCharacter (the player's body, model, rig and animations) with an AI Controller for a
// brain; they never die (a knock-down always gets up, and a stagger or a fall hurts them for 12 s: the pain pose),
// and the player is not knocked about by gunshots at all.

useNpcHooks();

describe.skipIf(!present)(`the Sandbox's NPCs (${TEST_PHYSICS})`, { timeout: 300_000 }, () => {
    it('places six civilians and four enemies, every one the Sandbox Character underneath', async () => {
        const p = await play({ npcs: Object.fromEntries(ALL.map(n => [n, true])) });
        const characters = [...p.r.scene.characters] as any[];
        expect(characters.map(c => c.team).sort()).toEqual(['civilian', 'civilian', 'civilian', 'civilian', 'civilian', 'civilian', 'enemy', 'enemy', 'enemy', 'enemy', 'player']);
        const machine = (c: any) => c.children.find((n: any) => n.nodeType === 'model')?.animator?.stateMachine;
        for (const c of characters) {
            // The player's body: the same Mannequin, posed by the same machine, with reactions.
            const model = c.children.find((n: any) => n.nodeType === 'model');
            expect(model?.name, c.team).toBe('Mannequin');
            expect(machine(c)?.name, c.team).toBe(machine(p.player)?.name);
            expect(c.reactions, c.team).toBeTruthy();
            expect(typeof c.struckByVehicle, c.team).toBe('function');
            expect(c.canDrive, c.team).toBe(c.team === 'player');
        }
        // Every one keeps going, on its feet: ten seconds of all of them at once.
        await p.run(10);
        for (const c of characters) {
            expect(finite(c.worldPosition), c.collider?.name).toBe(true);
            expect(c.worldPosition[1], `${c.collider?.name} on the ground`).toBeGreaterThan(-0.3);
        }
        // The enemies carry their rifles from the start; the civilians carry nothing.
        for (const c of characters.filter(c => c.team === 'enemy')) expect(c.weapon, c.collider?.name).toBe(2);
        for (const c of characters.filter(c => c.team === 'civilian')) expect(c.weapon, c.collider?.name).toBe(0);
    });

    it('a civilian waits at something to look at, then walks off to somewhere else on the nav mesh', async () => {
        const p = await play({ npcs: { 'Civilian 1': true }, player: { at: AWAY } });
        const civ = p.npc('Civilian 1');
        expect(civ.team).toBe('civilian');
        const from = [...civ.worldPosition];
        p.watch(civ);
        let farthest = 0;
        await p.run(25, () => { farthest = Math.max(farthest, planar(civ.worldPosition, from)); });
        const seen = p.states.get(civ)!;
        expect(seen[0]).toBe('wait');
        expect(seen).toContain('roam');
        expect(farthest).toBeGreaterThan(6);
        expect(finite(civ.worldPosition)).toBe(true);
        // On its feet on the ground all along, not through it.
        expect(civ.worldPosition[1]).toBeGreaterThan(-0.2);
    });

    it('a civilian looks at the player close by a few seconds, then moves on, and not at once again', async () => {
        // In the open, facing +X; the player 4 m off, 60 degrees to its right, inside its view.
        const p = await play({ npcs: { 'Civilian 1': { at: [32, 0, -24], yaw: 90 } }, player: { at: [34, 0.02, -27.46], yaw: 0 } });
        const civ = p.npc('Civilian 1');
        p.watch(civ);
        const toPlayer = () => { const me = civ.worldPosition, at = p.player.worldPosition; return Math.atan2(at[0] - me[0], at[2] - me[2]) * DEG; };
        const off = () => { const f = civ.worldForward; return Math.abs(((Math.atan2(f[0], f[2]) * DEG - toPlayer() + 540) % 360) - 180); };
        const before = off();
        let watching = -1, looking = Infinity;
        await p.run(4, (t) => {
            if (civ.state === 'watch' && watching < 0) watching = t;
            // Its head turned to the player (its look's yaw off the body), and the body turned, if at all, toward it.
            if (civ.state === 'watch' && t > watching + 1.5) looking = Math.min(looking, Math.abs(Math.abs(civ.lookYaw) - off()));
        });
        expect(watching, 'it noticed the player').toBeGreaterThanOrEqual(0);
        // Not at once: an ordinary person takes most of a second to notice someone (its noticeSeconds, 0.9).
        expect(watching).toBeGreaterThan(0.8);
        expect(watching).toBeLessThan(2.2);
        expect(before).toBeGreaterThan(45);
        expect(looking, 'its head on the player').toBeLessThan(12);
        // A few seconds, then off somewhere else; and not back to stare for a while.
        await p.run(6);
        expect(p.states.get(civ)!).toEqual(expect.arrayContaining(['wait', 'watch', 'roam']));
        const after = p.states.get(civ)!.lastIndexOf('watch');
        await p.run(8);
        expect(p.states.get(civ)!.lastIndexOf('watch'), 'it did not stare again').toBe(after);
    });

    it('a shot that nearly hits a civilian sends it running from the shooter', async () => {
        const p = await play({ npcs: { 'Civilian 1': { at: [32, 0, -24], yaw: 0 } }, player: { at: [32, 0.02, -36], yaw: 0 } });
        const civ = p.npc('Civilian 1');
        p.watch(civ);
        await p.run(1);
        const start = planar(civ.worldPosition, p.player.worldPosition);
        // A metre past its shoulder.
        shoot(p, [33.2, 1.2, -24]);
        // A startle first (0.4 to 0.8 s), then it runs.
        await p.run(0.3);
        expect(civ.state).not.toBe('flee');
        await p.run(0.8);
        expect(civ.state).toBe('flee');
        let fastest = 0;
        await p.run(4, () => { fastest = Math.max(fastest, civ.groundSpeed); });
        expect(planar(civ.worldPosition, p.player.worldPosition) - start, 'farther from the shooter').toBeGreaterThan(8);
        expect(fastest, 'running').toBeGreaterThan(4);
    });

    it('a civilian shot four times falls, lies, gets up on a get-up clip, still alive, and runs', async () => {
        const p = await play({ npcs: { 'Civilian 1': { at: [32, 0, -24], yaw: 180 } }, player: { at: [32, 0.02, -34], yaw: 0 } });
        const civ = p.npc('Civilian 1');
        p.watch(civ);
        const played = actionsOf(civ);
        const r = reactionTrail(civ);
        await p.run(1);
        // Four rifle rounds in the chest, a tenth of a second apart: they add up past its knock-down.
        let fired = 0;
        await p.run(25, (t) => {
            if (fired < 4 && t >= fired * 0.1) { shoot(p, [civ.worldPosition[0], civ.worldPosition[1] + 1.25, civ.worldPosition[2]]); fired++; }
            r.note();
            if (fired === 4 && t > 2 && civ.reactions.state === 'animated' && p.states.get(civ)!.includes('flee')) return true;
        });
        expect(r.trail.join('>')).toMatch(/falling.*down.*getUp.*animated/);
        expect(civ.reactions.alive).toBe(true);
        expect(p.states.get(civ)!).toEqual(expect.arrayContaining(['knocked', 'flee']));
        // Up on the Mannequin's own get-up clips (Getting Up face down, Stand Up face up), not on its strings alone.
        const ups = played.filter(a => a.clip === 'Getting Up' || a.clip === 'Stand Up');
        expect(ups.length).toBeGreaterThan(0);
        expect(ups.every(a => a.found)).toBe(true);
        expect(finite(civ.worldPosition)).toBe(true);
    });

    it('three rifle rounds at the rifle\'s cadence stagger a civilian: it steps and stays on its feet', async () => {
        const p = await play({ npcs: { 'Civilian 1': { at: [32, 0, -24], yaw: 180 } }, player: { at: [32, 0.02, -34], yaw: 0 } });
        const civ = p.npc('Civilian 1');
        const r = reactionTrail(civ);
        await p.run(1);
        // 450 rounds a minute: one every 0.133 s, in the chest.
        let fired = 0, steps = 0;
        await p.run(6, (t) => {
            if (fired < 3 && t >= fired * (60 / 450)) { shoot(p, [civ.worldPosition[0], civ.worldPosition[1] + 1.25, civ.worldPosition[2]]); fired++; }
            r.note();
            steps = Math.max(steps, civ.reactions.balance?.steps ?? 0);
        });
        expect(fired).toBe(3);
        expect(r.trail.join('>')).toMatch(/stagger/);
        expect(r.trail.join('>'), 'it stays on its feet').not.toMatch(/falling/);
        expect(steps, 'it steps').toBeGreaterThan(0);
        expect(civ.reactions.alive).toBe(true);
    });

    it('a shotgun blast at 3 m lands on a civilian as one heavy hit, not a pellet each, and knocks it down', async () => {
        const p = await play({ npcs: { 'Civilian 1': { at: [32, 0, -24], yaw: 180 } }, player: { at: [32, 0.02, -27], yaw: 0 } });
        const civ = p.npc('Civilian 1');
        const r = reactionTrail(civ);
        const hits: number[] = [];
        civ.addEventListener('reaction:Hit', (info: any) => hits.push(info?.impulse ?? 0));
        await p.run(1);
        // The SAPS-12 aimed: its nine pellets inside 2.6 degrees, all on the chest at this range.
        shoot(p, [civ.worldPosition[0], civ.worldPosition[1] + 1.25, civ.worldPosition[2]], 'Shotgun Grip', 2.6);
        await p.run(3, () => { r.note(); });
        expect(hits.length, `hits: ${hits}`).toBe(1);
        // Past the reaction set's stagger (60) and the NPC's knock-down shock (56): a pistol round is 14.
        expect(hits[0]).toBeGreaterThan(60);
        expect(r.trail.join('>')).toMatch(/falling/);
        expect(finite(civ.worldPosition)).toBe(true);
    });

    it('run over by the car, a civilian is thrown, gets up and runs from it', async () => {
        // In front of the parked car's bonnet (the car faces +X), the car sent at it at 8 m/s with nobody in it.
        const p = await play({ npcs: { 'Civilian 1': { at: [20.6, 0, 1.5], yaw: -90 } }, player: { at: AWAY } });
        const civ = p.npc('Civilian 1');
        const car = p.named('Car');
        p.watch(civ);
        const r = reactionTrail(civ);
        await p.run(0.5);
        car._state = 'driving';
        car.velocity = [8, 0, 0];
        let bent = 0;
        await p.run(20, (t) => {
            r.note();
            // Braced as it goes: its knees bend.
            const rg = civ.reactions.ragdoll, body = civ.reactions.body;
            if (rg && body && civ.reactions.state === 'falling' && t < 1.2) {
                const leg = body.legs.L, q = (i: number) => { const b = rg.parts[i].body.quaternion; return [b.x, b.y, b.z, b.w]; };
                const a = q(leg.root), b = q(leg.mid);
                bent = Math.max(bent, 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * DEG);
            }
            if (t > 3 && civ.reactions.state === 'animated' && p.states.get(civ)!.includes('flee')) return true;
        });
        // cannon's joint motors bend them the least.
        expect(bent, 'its knees bend').toBeGreaterThan(12);
        expect(r.trail.join('>')).toMatch(/falling.*getUp.*animated/);
        expect(civ.reactions.alive).toBe(true);
        expect(p.states.get(civ)!).toContain('flee');
        expect(finite(civ.worldPosition)).toBe(true);
    });

    it('a civilian steps out of the way of a car bearing down on it, and runs', async () => {
        const p = await play({ npcs: { 'Civilian 1': { at: [33, 0, 1.5], yaw: 0 } }, player: { at: AWAY } });
        const civ = p.npc('Civilian 1');
        const car = p.named('Car');
        p.watch(civ);
        const r = reactionTrail(civ);
        await p.run(0.5);
        car._state = 'driving';
        car.velocity = [8, 0, 0];
        let off = 0;
        await p.run(3, () => { r.note(); off = Math.max(off, Math.abs(civ.worldPosition[2] - 1.5)); });
        expect(off, 'off the car\'s line').toBeGreaterThan(1.6);
        expect(r.trail.join('>'), 'not hit').not.toMatch(/falling/);
        expect(p.states.get(civ)!).toContain('flee');
    });

    it('the car does not let an NPC drive it: only the player boards', async () => {
        const p = await play({ npcs: { 'Civilian 1': true }, player: { at: AWAY } });
        const civ = p.npc('Civilian 1');
        const car = p.named('Car');
        const zone = car.children.find((c: any) => c.name === 'Door Zone');
        await p.run(0.2);
        civ.teleport([zone.worldPosition[0], 0.02, zone.worldPosition[2]]);
        await p.run(0.2);
        expect(civ.canDrive).toBe(false);
        expect(car._driverAtDoor()).toBeNull();
        p.player.teleport([zone.worldPosition[0], 0.02, zone.worldPosition[2] + 0.4]);
        await p.run(0.2);
        expect(car._driverAtDoor()).toBe(p.player);
    });

    it('an enemy pair patrols its route with rifles, the second one behind the first', async () => {
        const p = await play({ npcs: { 'Enemy Pillars 1': true, 'Enemy Pillars 2': true }, player: { at: AWAY } });
        const a = p.npc('Enemy Pillars 1'), b = p.npc('Enemy Pillars 2');
        expect([a.team, b.team]).toEqual(['enemy', 'enemy']);
        p.watch(a, b);
        const [leader, follower] = a.id < b.id ? [a, b] : [b, a];
        const from = [...leader.worldPosition];
        let farthest = 0, apart = 0;
        await p.run(30, (t) => {
            farthest = Math.max(farthest, planar(leader.worldPosition, from));
            if (t > 4) apart = Math.max(apart, planar(leader.worldPosition, follower.worldPosition));
        });
        // The leader stops to look round at the points of its route; the follower keeps up behind it.
        expect(p.states.get(leader)!).toContain('patrol');
        expect(p.states.get(leader)!.every((s: string) => s === 'patrol' || s === 'look')).toBe(true);
        expect(p.states.get(follower)!).toEqual(['patrol']);
        expect(farthest, 'the leader walks its route').toBeGreaterThan(8);
        expect(apart, 'the follower keeps close').toBeLessThan(8);
        expect([a.weapon, b.weapon]).toEqual([2, 2]);
        // At the low ready on patrol, not aiming.
        expect(a.aiming || b.aiming).toBe(false);
    });

    it('an enemy that sees the player aims and fires at it, and its rounds do not knock the player about', async () => {
        // Down the pillars' route, 14 m in front of it.
        const p = await play({ npcs: { 'Enemy Pillars 1': true }, player: { at: [6, 0.02, -15], yaw: 90 } });
        const enemy = p.npc('Enemy Pillars 1');
        p.watch(enemy);
        const gun = enemy.children.find((c: any) => c.name === 'Weapons').children.find((c: any) => c.name === 'Rifle Grip');
        const r = reactionTrail(p.player);
        const mine = (node: any) => { for (let n = node; n; n = n.parent) if (n === p.player || n === p.player.collider) return true; return false; };
        let hits = 0, last: any = null, aimed = false;
        await p.run(8, () => {
            r.note();
            if (enemy.aiming) aimed = true;
            if (gun.lastHit && gun.lastHit !== last) {
                last = gun.lastHit;
                if (mine(last.node) || p.r.scene.physics.reactionsFor?.(last.node) === p.player.reactions) hits++;
            }
        });
        expect(p.states.get(enemy)!).toContain('engage');
        expect(aimed).toBe(true);
        expect(gun.shots).toBeGreaterThan(3);
        expect(hits, 'some of its rounds reach the player').toBeGreaterThan(0);
        // The player does not react to them at all (it would take the game from the hands playing it), and has no
        // health to lose.
        expect(r.trail).toEqual(['animated']);
        expect(p.player.reactions.wounds).toHaveLength(0);
        expect(p.player.reactions.alive).toBe(true);
        expect(finite(p.player.worldPosition)).toBe(true);
    });

    it('a round in a civilian throws nothing off it and leaves no hole, where one in the ground beside it throws sparks and leaves one', async () => {
        const p = await play({ npcs: { 'Civilian 1': { at: [32, 0, -24], yaw: 180 } }, player: { at: [32, 0.02, -34], yaw: 0 } });
        const civ = p.npc('Civilian 1');
        await p.run(1);
        const count = (name: string) => [...p.r.scene.nodes].filter((n: any) => n.name === name).length;
        const holes = count('Bullet Hole'), impacts = count('Bullet Impact');
        const hit = shoot(p, [civ.worldPosition[0], civ.worldPosition[1] + 1.25, civ.worldPosition[2]]);
        expect(hit, 'the round hits the civilian').toBeTruthy();
        // Sparks are a hard surface's: a body takes the round with its reaction alone.
        expect(count('Bullet Impact'), 'sparks off the civilian').toBe(impacts);
        expect(count('Bullet Hole'), 'a hole on the civilian').toBe(holes);
        const ground = shoot(p, [civ.worldPosition[0] + 1.5, 0, civ.worldPosition[2] - 2]);
        expect(ground, 'the round hits the ground').toBeTruthy();
        expect(count('Bullet Impact'), 'sparks off the ground').toBe(impacts + 1);
        expect(count('Bullet Hole'), 'a hole in the ground').toBe(holes + 1);
    });

    it('stays within its frame budget in a firefight with all ten of them', async () => {
        // The enemies at the pillars see the player and fight; the player shoots at every NPC in turn, a round every
        // fifth of a second, for 12 s (flinches, stumbles, knock-downs); the car runs into the crowd. Counted each
        // tick: the reacting bodies (powered ragdolls), the rays, the solver's iterations, and the tick's time.
        const p = await play({ npcs: Object.fromEntries(ALL.map(n => [n, true])), player: { at: [6, 0.02, -15], yaw: 90 } },
            { aiDetail: SANDBOX_AI_DETAIL });
        const physics: any = p.r.scene.physics;
        const npcs = ALL.map(n => p.npc(n));
        const car = p.named('Car');
        await p.run(1);
        const ms: number[] = [], rays: number[] = [], powered: number[] = [], iterations: number[] = [], searches: number[] = [];
        let shot = 0, struck = 0;
        await p.run(16, (t) => {
            if (t < 12 && t >= shot * 0.2) {
                const target = npcs[shot % npcs.length];
                shoot(p, [target.worldPosition[0], target.worldPosition[1] + 1.2, target.worldPosition[2]]);
                shot++;
            }
            if (t >= 3 && !struck) { struck = 1; car._state = 'driving'; car.velocity = [8, 0, 0]; }
        }, () => {
            ms.push(p.lastTickMs);
            rays.push(physics.stats.rayCount);
            powered.push(physics.poweredRagdollCount);
            iterations.push(physics.solverIterations);
            searches.push((p.r.scene as any).pathSearchesThisFrame ?? 0);
        });
        const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
        const pct = (a: number[], q: number) => sorted(a)[Math.min(a.length - 1, Math.floor(a.length * q))];
        const report = {
            ticks: ms.length, p50: pct(ms, 0.5), p95: pct(ms, 0.95), max: Math.max(...ms),
            raysP95: pct(rays, 0.95), raysMax: Math.max(...rays), poweredMax: Math.max(...powered),
            poweredMean: powered.reduce((a, b) => a + b, 0) / powered.length, iterationsMax: Math.max(...iterations),
            searchesMax: Math.max(...searches), knocked: npcs.filter(n => p.states.get(n)?.includes('knocked')).length,
        };
        console.log(`[npc budget ${TEST_PHYSICS}] ${JSON.stringify(report)}`);
        expect(report.ticks).toBeGreaterThan(400);
        // The budgets hold (measured 2026-11-27, the three backends in parallel: Jolt p50 51 ms, p95 80 ms a tick,
        // rays p95 87; before them 66, 126 and 125). The times are the machine's, so only the counts are asserted.
        expect(report.poweredMax, 'reacting bodies within Reacting bodies (6)').toBeLessThanOrEqual(6);
        expect(report.searchesMax, 'path searches within pathsPerFrame').toBeLessThanOrEqual(SANDBOX_AI_DETAIL.pathsPerFrame);
        expect(report.raysP95, 'rays a tick').toBeLessThan(150);
        if (physics.capabilities?.islandIterations) expect(report.iterationsMax, 'the world keeps its own iterations').toBeLessThanOrEqual(10);
    });

    // On its feet a reacting body's legs are kinematic on the animation, and a foot's IK ray took its own shin for the
    // ground (a kinematic body is ground): shot, both feet leapt 60 cm onto its legs, again and again. Its feet stay on
    // the ground now, foot placement and all, the shove letting them go rather than holding them to snap.
    it('shot standing, a civilian keeps its feet on the ground: no foot leaps onto its own legs', async () => {
        const p = await play({ npcs: { 'Civilian 1': { at: [32, 0, -28], yaw: 180 } }, player: { at: [32, 0.02, -34], yaw: 0 } });
        const civ = p.npc('Civilian 1');
        const model = civ.children.find((c: any) => c.nodeType === 'model');
        const skin = model.model.skin;
        const joint = (re: RegExp) => skin.joints.findIndex((j: any) => re.test(skin.nodeNames.get(j.nodeIndex) ?? ''));
        const feet = [joint(/LeftFoot$/), joint(/RightFoot$/)];
        expect(feet.every(i => i >= 0)).toBe(true);
        const bindAt = feet.map(i => mat4.getTranslation(vec3.create(), mat4.invert(mat4.create(), skin.joints[i].inverseBindMatrix)!));
        const drawn = () => feet.map((i, k) => {
            const at = vec3.transformMat4(vec3.create(), bindAt[k], model.animator.getFinalBoneMatrices()[i]);
            return vec3.transformMat4(at, at, model.worldTransform);
        });
        await p.run(1.5);
        const standing = Math.max(...drawn().map(v => v[1] - civ.worldPosition[1]));
        let prev: vec3[] | null = null, highest = 0, leap = 0;
        shoot(p, [civ.worldPosition[0], civ.worldPosition[1] + 1.3, civ.worldPosition[2]]);
        await p.run(0.35, undefined, () => {
            const now = drawn();
            for (const v of now) highest = Math.max(highest, v[1] - civ.worldPosition[1]);
            if (prev) leap = Math.max(leap, ...now.map((v, k) => vec3.distance(v, prev![k])));
            prev = now;
        });
        expect(civ.reactions.state, 'still on its feet').not.toMatch(/falling|tumble|down/);
        expect(highest - standing, 'how far a foot rose').toBeLessThan(0.15);
        expect(leap, 'the farthest a foot moved in a tick').toBeLessThan(0.2);
    });

    // Mixamo's get-up runs eight seconds. The brain took the NPC back the moment the reaction left getUp (the clip's last
    // quarter second and the blend still to play), and a long reaction tripped the stuck rescue in the middle of the
    // clip: either way it walked off while it still climbed up.
    it('knocked down, an enemy stays put until its get-up is over, even when that takes past its stuck rescue', async () => {
        // The player in its sight: up, it would go after it at once.
        const p = await play({ npcs: { 'Enemy Pillars 1': true }, player: { at: [6, 0.02, -15], yaw: 90 } });
        const en = p.npc('Enemy Pillars 1');
        // A rescue sooner than its fall, its lying and its clip take.
        en.stuckSeconds = 5;
        await p.run(1.5);
        en.reactions.push([0, 0.4, 3.5]);
        const { trail, note } = reactionTrail(en);
        let movedRising = 0, brainWhileRising = new Set<string>();
        await p.run(14, undefined, () => {
            note();
            if (/getUp|recover/.test(en.reactions.state)) {
                movedRising = Math.max(movedRising, Math.hypot(en.velocity[0], en.velocity[2]));
                brainWhileRising.add(en.state);
            }
        });
        expect(trail.join('>')).toMatch(/getUp>recover>animated/);
        expect(movedRising, 'moving while it got up').toBeLessThan(0.2);
        expect([...brainWhileRising]).toEqual(['knocked']);
    });

    it('knocked down and shot again while it gets up, a civilian goes back down and gets up again', async () => {
        const p = await play({ npcs: { 'Civilian 1': { at: [32, 0, -24], yaw: 180 } }, player: { at: [32, 0.02, -34], yaw: 0 } });
        const civ = p.npc('Civilian 1');
        const r = reactionTrail(civ);
        civ.reactions.trip();
        let again = false;
        await p.run(30, (t) => {
            r.note();
            if (!again && civ.reactions.state === 'getUp' && civ.reactions.stateTime > 0.6) {
                // At its chest, wherever the body has got to.
                const body = civ.reactions.body;
                shoot(p, body.simPosition(body.chest));
                again = true;
            }
            if (again && civ.reactions.state === 'animated') return true;
        });
        expect(again).toBe(true);
        // Up partway, knocked back, and up again in the end.
        expect(r.trail.join('>')).toMatch(/getUp>(falling|stagger).*animated/);
        expect(civ.reactions.alive).toBe(true);
    });

    it("goes down and up through its animator graph: Ragdoll while the body is down, Get Up on Mixamo's clip, then on its way", async () => {
        const p = await play({ npcs: { 'Civilian 1': { at: [32, 0, -24], yaw: 180 } }, player: { at: [32, 0.02, -34], yaw: 0 } });
        const civ = p.npc('Civilian 1');
        const a = civ.children.find((c: any) => c.nodeType === 'model' && c.animator).animator;
        const base: string[] = [];
        let movedRising = 0;
        civ.reactions.trip();
        await p.run(30, () => {
            const s = a.currentStateName;
            if (base[base.length - 1] !== s) base.push(s);
            if (s === 'Get Up') movedRising = Math.max(movedRising, Math.hypot(civ.velocity[0], civ.velocity[2]));
            if (base.includes('Get Up') && civ.reactions.state === 'animated' && s !== 'Get Up') return true;
        });
        // The graph followed the fall (Any State on Ragdolled), held the body down, and rose on its Get Up state.
        expect(base.join('>')).toMatch(/^[^>]+>Ragdoll>Get Up>/);
        expect(civ.reactions.state).toBe('animated');
        expect(movedRising, 'moving while it got up').toBeLessThan(0.2);
    });

    it('down on its front, it rolls onto its back and gets up on Stand Up, from where the body in the clip starts to rise', async () => {
        const p = await play({ npcs: { 'Civilian 1': { at: [32, 0, -24], yaw: 180 } }, player: { at: AWAY } });
        const civ = p.npc('Civilian 1');
        const played = actionsOf(civ);
        const a = civ.children.find((c: any) => c.nodeType === 'model' && c.animator).animator;
        await p.run(1);
        const { trail, note } = reactionTrail(civ);
        // Tripped, it falls forward onto its front.
        civ.reactions.trip();
        let lowest = 1, lyingAtRise: number | null = null, risingFor = 0, clip: any = null;
        await p.run(30, () => {
            note();
            const s = civ.reactions.state;
            if (s === 'down') lowest = Math.min(lowest, civ.reactions.lying);
            if (s === 'getUp') { if (lyingAtRise === null) lyingAtRise = civ.reactions.lying; risingFor += 1 / TICK; clip ??= a.currentAnimation; }
            if (trail.includes('getUp') && s === 'animated') return true;
        });
        expect(lowest, 'it lay on its front').toBe(-1);
        expect(lyingAtRise, 'on its back when it rose').toBe(1);
        expect(trail.join('>')).toMatch(/falling.*down>getUp>recover>animated/);
        // One get-up, on Stand Up, started past the 1.4 s it lies still at its start.
        expect(played.map(x => x.clip)).toEqual(['Stand Up']);
        expect(clip?.name).toBe('Stand Up');
        const length = Math.max(...clip.samplers.map((x: any) => x.input[x.input.length - 1]));
        expect(risingFor, `rising, of a ${length.toFixed(1)} s clip`).toBeLessThan(length - 1.2);
    });

    it('a round lands where it struck: the leg, the arm, the chest and the head each a wound of their own zone', async () => {
        // The player near (a flinch takes a body only near the camera), its back to it.
        const p = await play({ npcs: { 'Civilian 1': { at: [32, 0, -24], yaw: 180 } }, player: { at: [32, 0.02, -30], yaw: 180 } });
        const civ = p.npc('Civilian 1');
        await p.run(1);
        const zones: string[] = [];
        for (const part of ['Thigh L', 'Upper Arm R', 'Chest', 'Head']) {
            const f = civ.worldForward;
            civ.reactions.hit({ part, direction: [-f[0], 0, -f[2]], impulse: 8 });
            await p.run(0.1);
            // The newest on the physics clock (the reaction clock starts over with each body).
            const latest = [...civ.reactions.wounds].sort((a: any, b: any) => b.clock - a.clock)[0];
            zones.push(latest?.zone ?? 'none');
            await p.run(1.6);
        }
        expect(zones).toEqual(['leg', 'arm', 'chest', 'head']);
        expect(civ.reactions.alive).toBe(true);
    });

    it('staggered, an enemy is hurt twelve seconds: its left hand on its chest, the pistol in its right, then the rifle again', async () => {
        const p = await play({ npcs: { 'Enemy Pillars 1': { at: [32, 0, -24], yaw: 180 } }, player: { at: AWAY } });
        const en = p.npc('Enemy Pillars 1');
        const a = en.children.find((c: any) => c.nodeType === 'model' && c.animator).animator;
        await p.run(1);
        expect([en.hurt, en.weapon, en.controller.behaviorLayerState('Health'), en.controller.behaviorLayerState('Weapon')]).toEqual([false, 2, 'Fine', 'Rifle']);
        const knocks = en.reactions.knockCount;
        const { trail, note } = reactionTrail(en);
        // A shove past its stagger: it steps to stay up (or, past its steps, falls). Either way it is hurt.
        const f = en.worldForward;
        en.reactions.push([-f[0] * 1.5, 0, -f[2] * 1.5]);
        let hurtAt = -1, pistolAt = -1, healedAt = -1, rifleAgainAt = -1, pain = 0, painParam = 0, support = 1;
        await p.run(18, (t) => {
            note();
            if (en.hurt && hurtAt < 0) hurtAt = t;
            if (en.hurt && en.weapon === 1 && pistolAt < 0) pistolAt = t;
            if (en.hurt) { pain = Math.max(pain, en.painWeight); painParam = Math.max(painParam, Number(a.getParam('Pain'))); }
            if (en.hurt && en.weapon === 1 && pain === 1) support = Math.min(support, en.supportHand);
            if (hurtAt >= 0 && !en.hurt && healedAt < 0) healedAt = t;
            if (healedAt >= 0 && en.weapon === 2 && rifleAgainAt < 0) rifleAgainAt = t;
        });
        expect(trail.join('>')).toMatch(/stagger/);
        expect(en.reactions.knockCount).toBeGreaterThan(knocks);
        // Hurt at once, the pistol drawn; the hand on the chest at full weight, off the pistol.
        expect(hurtAt, 'hurt').toBeGreaterThanOrEqual(0);
        expect(hurtAt).toBeLessThan(1);
        expect(pistolAt, 'the pistol').toBeGreaterThanOrEqual(0);
        expect(pistolAt - hurtAt).toBeLessThan(3);
        expect([pain, painParam]).toEqual([1, 1]);
        expect(support, 'the left hand off the pistol').toBe(0);
        // Past ten seconds (the brain's twelve), then the rifle again and the pain eased off.
        expect(healedAt - hurtAt, 'hurt for').toBeGreaterThan(10);
        expect(rifleAgainAt, 'the rifle again').toBeGreaterThanOrEqual(0);
        expect([en.hurt, en.painWeight, en.controller.behaviorLayerState('Health')]).toEqual([false, 0, 'Fine']);
    });

    it('an enemy fights the player within 3 m with the shotgun, and farther with the rifle', async () => {
        const p = await play({ npcs: { 'Enemy Pillars 1': { at: [32, 0, -24], yaw: 180 } }, player: { at: [32, 0.02, -26.2], yaw: 0 } });
        const en = p.npc('Enemy Pillars 1');
        p.watch(en);
        let shotgunAt = -1;
        await p.run(4, (t) => { if (en.weapon === 3 && shotgunAt < 0) { shotgunAt = t; return true; } });
        expect(shotgunAt, 'the shotgun up close').toBeGreaterThanOrEqual(0);
        expect(en.controller.behaviorLayerState('Weapon')).toBe('Shotgun');
        // The player 10 m off: the rifle.
        p.player.teleport([32, 0.02, -34]);
        let rifleAt = -1;
        await p.run(4, (t) => { if (en.weapon === 2 && rifleAt < 0) { rifleAt = t; return true; } });
        expect(rifleAt, 'the rifle farther').toBeGreaterThanOrEqual(0);
        expect(en.controller.behaviorLayerState('Weapon')).toBe('Rifle');
    });

    it('the player driving past, an enemy steps off the car\'s path, the side away from where it is going, firing at it', async () => {
        // North of the car's line (z 1.5), facing it; the car parked west of it, nose to the east (+X).
        const p = await play({ npcs: { 'Enemy Pillars 1': { at: [30, 0, 13], yaw: 180 } }, player: { at: AWAY } });
        const en = p.npc('Enemy Pillars 1');
        const car = p.named('Car');
        const zone = car.children.find((c: any) => c.name === 'Door Zone');
        const gun = en.children.find((c: any) => c.name === 'Weapons').children.find((c: any) => c.name === 'Rifle Grip');
        p.watch(en);
        await p.run(0.3);
        p.player.teleport([zone.worldPosition[0], 0.02, zone.worldPosition[2]]);
        await p.run(0.3);
        car._board();
        await p.run(6, () => car._state === 'driving');
        expect(car._state, 'the player at the wheel').toBe('driving');
        expect(p.player.inVehicle).toBe(true);
        let enteredX: number | null = null, westmost = Infinity, shotsAt = 0;
        await p.run(5, () => {
            // East at 5 m/s, the way its nose points.
            car.velocity = [5, car.velocity[1], 0];
            if (en.state === 'car engage') {
                if (enteredX === null) { enteredX = en.worldPosition[0]; shotsAt = gun.shots; }
                westmost = Math.min(westmost, en.worldPosition[0]);
            }
        });
        expect(p.states.get(en)!).toContain('car engage');
        // The car going east, it went west.
        expect(enteredX, 'car engage').not.toBeNull();
        expect(enteredX! - westmost, 'off its path, west').toBeGreaterThan(1);
        expect(gun.shots - shotsAt, 'firing at the car').toBeGreaterThan(0);
        expect(finite(en.worldPosition)).toBe(true);
    });

    it('flinches on its Hit Reaction layer by where a hit came from: in front, then its right', async () => {
        const p = await play({ npcs: { 'Enemy Pillars 1': { at: [32, 0, -24], yaw: 180 } }, player: { at: AWAY } });
        const en = p.npc('Enemy Pillars 1');
        const a = en.children.find((c: any) => c.nodeType === 'model' && c.animator).animator;
        await p.run(1);
        const seen: { layer: string | null; angle: number; height: number }[] = [];
        const hitFrom = async (where: 'front' | 'right', part: string) => {
            const f = en.worldForward;
            // In front, the round travels back along its facing; from its right, toward its left.
            const dir = where === 'front' ? [-f[0], 0, -f[2]] : [f[2], 0, -f[0]];
            en.reactions.hit({ part, direction: dir, impulse: 6 });
            let entered = false;
            await p.run(0.5, () => {
                if (a.layerStateName('Hit Reaction') === 'Hit' && !entered) {
                    entered = true;
                    seen.push({ layer: 'Hit', angle: Number(a.getParam('HitAngle')), height: Number(a.getParam('HitHeight')) });
                }
            });
            if (!entered) seen.push({ layer: a.layerStateName('Hit Reaction'), angle: NaN, height: NaN });
            await p.run(0.6);
        };
        await hitFrom('front', 'Chest');
        await hitFrom('right', 'Head');
        expect(seen.map(s => s.layer)).toEqual(['Hit', 'Hit']);
        expect(Math.abs(seen[0].angle)).toBeLessThan(5);
        expect(seen[1].angle).toBeCloseTo(-90, -1);
        // The chest is the trunk, the head high.
        expect(seen[0].height).toBeLessThan(0.85);
        expect(seen[1].height).toBeGreaterThan(0.85);
        // The flinch is over by itself: back to Off.
        expect(a.layerStateName('Hit Reaction')).toBe('Off');
    });

    it("the player's Trip key takes its feet from under it through the graph's Trip trigger, and it gets up", async () => {
        const p = await play({ npcs: {}, player: { at: [32, 0.02, -34], yaw: 0 } });
        const me = p.player;
        const a = me.children.find((c: any) => c.nodeType === 'model' && c.animator)?.animator
            ?? [...p.r.scene.nodes].find((n: any) => n.name === 'Mannequin' && n.animator)?.animator;
        await p.run(1);
        const base: string[] = [];
        me._trip();
        await p.run(30, () => {
            const s = a.currentStateName;
            if (base[base.length - 1] !== s) base.push(s);
            if (base.includes('Get Up') && me.reactions.state === 'animated' && s !== 'Get Up') return true;
        });
        expect(base.join('>')).toMatch(/^[^>]+>Ragdoll>Get Up>/);
        expect(me.reactions.state).toBe('animated');
    });

    it('nearly hit twice, an enemy runs for cover and crouches where the shooter cannot see it', async () => {
        // South of the wall, its back to the player 12 m behind it: two rounds past it, a metre off. Cover is the
        // wall's other side.
        const p = await play({ npcs: { 'Enemy Crates 1': { at: [-12, 0, -9], yaw: 0 } }, player: { at: [-10, 0.02, -21], yaw: 0 } });
        const enemy = p.npc('Enemy Crates 1');
        p.watch(enemy);
        const r = reactionTrail(enemy);
        await p.run(1);
        let fired = 0, settled = 0, hidden: boolean | null = null;
        const physics: any = p.r.scene.physics;
        await p.run(10, (t) => {
            r.note();
            if (fired < 2 && t >= fired * 0.4) {
                // A metre to the side of its chest, square to the shot.
                const at = enemy.worldPosition, me = p.player.worldPosition;
                const d = [at[0] - me[0], at[2] - me[2]], n = Math.hypot(d[0], d[1]);
                shoot(p, [at[0] - d[1] / n, at[1] + 1.3, at[2] + d[0] / n]);
                fired++;
            }
            // Settled behind it: crouched, a moment in.
            if (enemy.state === 'in cover' && enemy.crouched && ++settled > 12) {
                const eye = [p.player.worldPosition[0], p.player.worldPosition[1] + 1.55, p.player.worldPosition[2]];
                const head = [enemy.worldPosition[0], enemy.worldPosition[1] + 1.0, enemy.worldPosition[2]];
                const hit = physics.raycast(eye, head, { reject: (o: any, b: any) => !!o?.character || o?.nodeType === 'character' || !!physics.ragdollPartOf(b) });
                hidden = !!hit && Math.hypot(hit.point[0] - head[0], hit.point[1] - head[1], hit.point[2] - head[2]) > 0.35;
                return true;
            }
        });
        expect(r.trail.join('>'), 'never hit').not.toMatch(/stagger|falling/);
        expect(p.states.get(enemy)!).toEqual(expect.arrayContaining(['cover', 'in cover']));
        expect(hidden).toBe(true);
    });
});
