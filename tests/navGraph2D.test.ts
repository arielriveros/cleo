import { describe, it, expect } from 'vitest';
import { vec3 } from 'gl-matrix';
import {
    EDGE_DROP, EDGE_DROP_THROUGH, EDGE_JUMP, EDGE_WALK, NavGraph2D, bakeNavGraph2D, navGraph2DSourceHash,
    parseNavGraph2D, serializeNavGraph2D,
} from '../src/ai/navGraph2D';
import type { NavBounds2D } from '../src/ai/navGraph2D';
import { NAV_AGENT_2D_DEFAULTS, simulatePath2D } from '../src/ai/navFollow2D';
import type { NavAgent2D } from '../src/ai/navFollow2D';
import { createNavPath } from '../src/ai/navPath';
import { TILE_NONE, TILE_ONE_WAY, TILE_SOLID } from '../src/physics2d/types';
import type { CollisionWorld2D, Grid2D } from '../src/physics2d/types';

// 2D navigation: surfaces an agent fits on, walks between them, jumps it can make (each one flown before
// it is kept), drops off ledges and through one-way platforms, and a flier's grid -- searched with A*.

/** A grid from ASCII rows, top row first; row r spans y in [rows - r - 1, rows - r]. # solid, = one-way. */
function worldOf(rows: string[]): { world: CollisionWorld2D, bounds: NavBounds2D } {
    const grid: Grid2D = {
        originX: 0, originY: rows.length, cellWidth: 1, cellHeight: 1,
        sample(col, row) {
            const ch = rows[row]?.[col] ?? ' ';
            return ch === '#' ? TILE_SOLID : ch === '=' ? TILE_ONE_WAY : TILE_NONE;
        },
    };
    return { world: { grids: [grid], boxes: [] }, bounds: [0, 0, Math.max(...rows.map(r => r.length)), rows.length] };
}
const agent = (o: Partial<NavAgent2D> = {}): NavAgent2D => ({ ...NAV_AGENT_2D_DEFAULTS, width: 0.8, height: 1.8, walkSpeed: 5, jumpHeight: 3.4, jumpTimeToApex: 0.4, ...o });
const kinds = (g: NavGraph2D) => {
    const out = { walk: 0, jump: 0, drop: 0, dropThrough: 0 };
    for (let e = 0; e < g.edgeCount; e++) {
        const k = g.edge(e).kind;
        if (k === EDGE_WALK) out.walk++; else if (k === EDGE_JUMP) out.jump++; else if (k === EDGE_DROP) out.drop++; else if (k === EDGE_DROP_THROUGH) out.dropThrough++;
    }
    return out;
};
const pathOf = (g: NavGraph2D, from: [number, number], to: [number, number]) => {
    const path = createNavPath();
    const ok = g.findPath(from, to, path);
    return { ok, path, actions: path.actions.join(',') };
};

// Floor at y = 1 (row 9's top), a platform at y = 4 (cols 8..13), a higher one at y = 7 (cols 15..20).
const STAIRS = [
    '                          ',
    '                          ',
    '                          ',
    '               ######     ',
    '                          ',
    '                          ',
    '        ######            ',
    '                          ',
    '                          ',
    '##########################',
];

describe('baking a 2D walk graph', () => {
    it('finds the surfaces an agent fits on, and walks between neighbours', () => {
        const { world, bounds } = worldOf(STAIRS);
        const { data, stats } = bakeNavGraph2D(world, bounds, agent());
        const g = new NavGraph2D(data);
        expect(stats.nodes).toBeGreaterThan(40);
        // Every surface sample stands on a floor top.
        for (let i = 0; i < g.nodeCount; i++) expect([1, 4, 7]).toContain(Math.round(g.node(i)[1] * 1000) / 1000);
        expect(kinds(g).walk).toBeGreaterThan(40);
    });

    it('links a jump only within the arc, flying each one, and climbs the stairs with them', () => {
        const { world, bounds } = worldOf(STAIRS);
        const g = new NavGraph2D(bakeNavGraph2D(world, bounds, agent()).data);
        expect(kinds(g).jump).toBeGreaterThan(0);
        const up = pathOf(g, [2, 1], [18, 7]);
        expect(up.ok).toBe(true);
        expect(up.actions.split(',').filter(a => a === 'jump').length).toBe(2);
        // A jump lower than the climb cannot reach: a weak jumper has no way up.
        const weak = new NavGraph2D(bakeNavGraph2D(world, bounds, agent({ jumpHeight: 2 })).data);
        expect(pathOf(weak, [2, 1], [18, 7]).ok).toBe(false);
        // The path flies: following it from the start reaches the top platform.
        const run = simulatePath2D(world, agent(), up.path, 2, 1, 0, { maxSeconds: 12 });
        expect(run.ok).toBe(true);
        expect(run.y).toBeCloseTo(7, 3);
    });

    it('refuses a jump a ceiling blocks', () => {
        const capped = worldOf([
            '                          ',
            '                          ',
            '                          ',
            '##########################',
            '                          ',
            '                          ',
            '        ######            ',
            '                          ',
            '                          ',
            '##########################',
        ]);
        // A ceiling at y = 6 over the platform at y = 4: a 1.8-tall agent fits on the platform (its head at
        // 5.8) and reaches it with a jump the ceiling cuts short; a 2.5-tall one fits nowhere under it.
        const short = new NavGraph2D(bakeNavGraph2D(capped.world, capped.bounds, agent()).data);
        expect(pathOf(short, [2, 1], [10, 4]).actions).toContain('jump');
        const tall = new NavGraph2D(bakeNavGraph2D(capped.world, capped.bounds, agent({ height: 2.5 })).data);
        for (let i = 0; i < tall.nodeCount; i++) expect(Math.abs(tall.node(i)[1] - 4)).toBeGreaterThan(0.5);
        expect(kinds(tall).jump).toBe(0);
    });

    it('drops off a ledge and through a one-way platform, and never into a pit', () => {
        const { world, bounds } = worldOf([
            '                          ',
            '                          ',
            '                          ',
            '######    =======         ',
            '######                    ',
            '######                    ',
            '######         #######    ',
            '######         #######    ',
            '######         #######    ',
            '######                    ',
        ]);
        // Bounds end at y = 0: below is a pit (no floor in the gap between x 6 and 16).
        const g = new NavGraph2D(bakeNavGraph2D(world, bounds, agent()).data);
        const k = kinds(g);
        expect(k.drop).toBeGreaterThan(0);
        expect(k.dropThrough).toBeGreaterThan(0);
        // No edge lands below the bounds.
        for (let e = 0; e < g.edgeCount; e++) expect(g.node(g.edge(e).to)[1]).toBeGreaterThanOrEqual(0);
        const down = pathOf(g, [12, 7], [19, 4]);
        expect(down.ok).toBe(true);
        expect(down.actions).toMatch(/drop/);
    });

    it('prefers a walk to a jump when the walk is shorter', () => {
        const { world, bounds } = worldOf([
            '                    ',
            '                    ',
            '                    ',
            '          #         ',
            '####################',
        ]);
        const g = new NavGraph2D(bakeNavGraph2D(world, bounds, agent()).data);
        // A one-high step: walked over? No -- it is a wall (above step height); the only way is a jump.
        const over = pathOf(g, [2, 1], [16, 1]);
        expect(over.ok).toBe(true);
        expect(over.actions).toContain('jump');
        const flat = pathOf(g, [2, 1], [8, 1]);
        expect(flat.actions).toBe('walk');
    });

    it('is deterministic, and round-trips through its stored form', () => {
        const { world, bounds } = worldOf(STAIRS);
        const a = bakeNavGraph2D(world, bounds, agent()).data;
        const b = bakeNavGraph2D(world, bounds, agent()).data;
        expect(serializeNavGraph2D(a)).toEqual(serializeNavGraph2D(b));
        const back = parseNavGraph2D(JSON.parse(JSON.stringify(serializeNavGraph2D(a))));
        expect([...back.nodes]).toEqual([...a.nodes]);
        expect([...back.edges]).toEqual([...a.edges]);
        expect([...back.kinds]).toEqual([...a.kinds]);
        expect(navGraph2DSourceHash(world, bounds, agent())).toBe(navGraph2DSourceHash(world, bounds, agent()));
        expect(navGraph2DSourceHash(world, bounds, agent())).not.toBe(navGraph2DSourceHash(world, bounds, agent({ jumpHeight: 2 })));
    });
});

describe('baking a 2D fly grid', () => {
    it('keeps the agent clear of rock and string-pulls a flight round it', () => {
        const { world, bounds } = worldOf([
            '                    ',
            '                    ',
            '        #           ',
            '        #           ',
            '        #           ',
            '        #           ',
            '        #           ',
            '####################',
        ]);
        const { data, stats } = bakeNavGraph2D(world, bounds, agent({ movement: 'fly', width: 1, height: 1, oneWayPlatforms: false }));
        expect(stats.freeCells).toBeGreaterThan(100);
        const g = new NavGraph2D(data);
        const { ok, path } = pathOf(g, [3, 3], [14, 3]);
        expect(ok).toBe(true);
        // Up and over the pillar (top at y = 6), in a handful of straight legs.
        expect(path.points.length).toBeLessThan(6);
        expect(Math.max(...path.points.map(p => p[1]))).toBeGreaterThan(6);
        expect(path.actions.every(a => a === 'fly')).toBe(true);
        const last = path.points[path.points.length - 1];
        expect(vec3.distance(last, vec3.fromValues(14, 3, 0))).toBeLessThan(0.01);
    });
});

describe('following a 2D path', () => {
    it('lands a jump leg on its platform at 30, 60 and 144 frames a second', () => {
        const { world, bounds } = worldOf(STAIRS);
        const g = new NavGraph2D(bakeNavGraph2D(world, bounds, agent()).data);
        for (const fps of [30, 60, 144]) {
            const { path } = pathOf(g, [2, 1], [11, 4]);
            const run = simulatePath2D(world, agent(), path, 2, 1, 0, { fps, maxSeconds: 8 });
            expect(run.ok, `${fps} fps`).toBe(true);
            expect(run.y, `${fps} fps`).toBeCloseTo(4, 3);
        }
    });

    it('asks for a new plan when a landing goes wrong', () => {
        const { world } = worldOf(STAIRS);
        // A "jump" onto a ledge no jump reaches: the agent lands back on the floor, and the follower says so.
        const path = createNavPath();
        path.points.push(vec3.fromValues(2, 1, 0), vec3.fromValues(17, 7, 0));
        path.actions.push('walk', 'jump');
        path.throttles.push(1, 1);
        path.index = 1;
        const run = simulatePath2D(world, agent(), path, 2, 1, 0, { maxSeconds: 4 });
        expect(run.ok).toBe(false);
        expect(run.y).toBeCloseTo(1, 3);
    });
});

describe('a 3D path', () => {
    it('walks every leg', async () => {
        const { setNavPath } = await import('../src/ai/navPath');
        const path = setNavPath(createNavPath(), [vec3.fromValues(0, 0, 0), vec3.fromValues(1, 0, 0)]);
        expect(path.actions).toEqual(['walk', 'walk']);
        expect(path.throttles).toEqual([1, 1]);
    });
});
