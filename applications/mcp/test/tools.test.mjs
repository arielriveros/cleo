// The tool catalog's cost and shape. Every tool loads with every Claude Code session (no tool-search turn
// before its first use), so the descriptions and schemas are paid for on every request: kept in budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { runLengthSeconds, toToolResult, toolDefinitions } from '../src/tools.mjs';
import { ALL_ADD_TYPES, ASSET_KINDS, TYPES_2D, addTypesText } from '../src/catalog.mjs';

const defs = toolDefinitions({ call: async () => ({}) });
const schema = (/** @type {any} */ d) => z.strictObject(d.config.inputSchema);
const size = (/** @type {any} */ d) => d.config.description.length + JSON.stringify(z.toJSONSchema(schema(d))).length;
const tool = (/** @type {string} */ name) => /** @type {any} */ (defs.find(d => d.name === name));

test('every tool loads up front, and execute_js asks for no per-call approval', () => {
    for (const d of defs) assert.equal(d.config._meta?.['anthropic/alwaysLoad'], true, d.name);
    assert.equal(tool('execute_js').config._meta?.['anthropic/requiresUserInteraction'], undefined);
    assert.equal(tool('execute_js').config.annotations.destructiveHint, true);
});

test('the whole catalog stays within budget', () => {
    const total = defs.reduce((n, d) => n + size(d), 0);
    assert.ok(total < 26_000, `catalog: ${total} characters`);
    assert.ok(size(tool('scene_edit')) < 7_500, `scene_edit: ${size(tool('scene_edit'))} characters`);
    // Claude Code cuts up-front descriptions at 4,096 characters.
    for (const d of defs) assert.ok(d.config.description.length < 4096, d.name);
});

test('scene_edit takes every op the editor runs, with create taking the update fields', () => {
    const op = schema(tool('scene_edit')).shape.ops.element;
    assert.deepEqual(op.shape.op.options, ['create', 'update', 'delete', 'move', 'attachScript', 'detachScript', 'select', 'makeTemplate', 'unpack', 'revertOverrides', 'makeVariant']);
    const parsed = schema(tool('scene_edit')).parse({
        ops: [{ op: 'create', type: 'cube', as: '$c', material: { type: 'cel', baseColor: [1, 0, 0], textures: { base: 'Bricks' } }, script: 'Spin', scriptFields: { speed: 2 } }],
        capture: { focus: '$c', views: 'quad' },
    });
    assert.equal(parsed.ops[0].material.baseColor[0], 1);
    assert.ok(schema(tool('scene_edit')).safeParse({ ops: [{ op: 'update', node: '@selected', material: 'Red', assets: { tileset: 'Hero' } }], capture: true }).success);
});

test('an op passes unknown fields through, so the editor names them; every other input is strict', () => {
    const edit = schema(tool('scene_edit'));
    // The SDK hands the handler the PARSED arguments: a plain object would drop `body` without a word.
    const parsed = edit.parse({ ops: [{ op: 'create', type: 'cube', body: { mass: 1 } }] });
    assert.deepEqual(parsed.ops[0].body, { mass: 1 });
    assert.equal(edit.safeParse({ ops: [{ op: 'select', node: 'A' }], atomc: false }).success, false);
    assert.equal(schema(tool('scene_tree')).safeParse({ deepth: 2 }).success, false);
    assert.equal(edit.safeParse({ ops: [{ op: 'create', type: 'cube', material: { colour: [1, 0, 0] } }] }).success, false);
    assert.equal(schema(tool('view_capture')).safeParse({ focus: 'A', views: [{ yaw: 0 }, { yaw: 90 }, { yaw: 180 }, { yaw: 270 }, { yaw: 45 }] }).success, false);
});

test('play_control takes input and watch, and its timeout covers the input', () => {
    const play = schema(tool('play_control'));
    const args = { action: 'play', input: [{ at: 0.2, key: 'KeyW', hold: 3 }, { at: 1, action: 'Jump' }, { at: 1, mouse: 'left', move: [40, 0] }, { at: 2, cursor: [640, 360], to: [700, 400], mouse: 'left' }], watch: ['/Player', { node: 'Enemy', props: ['health'] }], stopAfter: true };
    assert.ok(play.safeParse(args).success);
    assert.equal(play.safeParse({ action: 'play', input: [{ at: 0, keys: 'W' }] }).success, false);
    assert.ok(runLengthSeconds(args) >= 3.5);
    assert.equal(runLengthSeconds({ action: 'run' }), 1.5);
});

test('the catalog module lists every add type once, grouped, with the 2D ones among them', () => {
    assert.equal(new Set(ALL_ADD_TYPES).size, ALL_ADD_TYPES.length);
    for (const t of TYPES_2D) assert.ok(ALL_ADD_TYPES.includes(t), t);
    for (const t of ['camera2D', 'room2D', 'parallaxLayer', 'characterBody2D', 'areaLight', 'giVolume', 'sequence']) assert.ok(addTypesText().includes(t), t);
    assert.deepEqual(schema(tool('asset_list')).shape.kind.unwrap().options, ASSET_KINDS);
});

test('engine_api answers in-process, with no editor behind it', async () => {
    const calls = [];
    const local = toolDefinitions({ call: async (m) => { calls.push(m); return {}; } }).find(d => d.name === 'engine_api');
    const res = await local.handler({ query: 'x', symbol: 'y' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /exactly one of/);
    assert.deepEqual(calls, [], 'nothing was relayed to the editor');
});

test('a relayed call carries the request\'s abort signal to the bridge', async () => {
    /** @type {any[]} */
    const seen = [];
    const relayed = toolDefinitions({ call: async (_m, _p, opts) => { seen.push(opts); return { text: 'ok' }; } }).find(d => d.name === 'scene_tree');
    const ac = new AbortController();
    await relayed.handler({}, { mcpReq: { signal: ac.signal } });
    assert.equal(seen[0].signal, ac.signal);
});

test('results are compact JSON', () => {
    assert.equal(toToolResult({ data: { a: 1, b: [1, 2] } }).content[0].text, '{"a":1,"b":[1,2]}');
});
