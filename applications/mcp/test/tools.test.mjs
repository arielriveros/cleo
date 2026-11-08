// The tool catalog's cost and shape. The core tools load with every Claude Code session (no tool-search turn
// before their first use), so their descriptions and schemas are paid for on every request: kept in budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { CORE_TOOLS, toToolResult, toolDefinitions } from '../src/tools.mjs';

const defs = toolDefinitions({ call: async () => ({}) });
const size = (/** @type {any} */ d) => d.config.description.length + JSON.stringify(z.toJSONSchema(z.object(d.config.inputSchema))).length;

test('the core tools load up front, the rest stay deferred', () => {
    for (const d of defs) {
        assert.equal(d.config._meta?.['anthropic/alwaysLoad'] === true, CORE_TOOLS.includes(d.name), d.name);
    }
    assert.ok(defs.find(d => d.name === 'execute_js')?.config._meta?.['anthropic/requiresUserInteraction']);
});

test('the up-front catalog stays within budget', () => {
    const core = defs.filter(d => CORE_TOOLS.includes(d.name));
    const total = core.reduce((n, d) => n + size(d), 0);
    assert.ok(total < 10_000, `core tools: ${total} characters`);
    const edit = defs.find(d => d.name === 'scene_edit');
    assert.ok(size(edit) < 5_000, `scene_edit: ${size(edit)} characters`);
    // Claude Code cuts up-front descriptions at 4,096 characters.
    for (const d of defs) assert.ok(d.config.description.length < 4096, d.name);
});

test('scene_edit takes every op the editor runs, with create taking the update fields', () => {
    const edit = defs.find(d => d.name === 'scene_edit');
    const op = z.object(edit.config.inputSchema).shape.ops.element;
    assert.deepEqual(op.shape.op.options, ['create', 'update', 'delete', 'move', 'attachScript', 'detachScript', 'select']);
    const parsed = z.object(edit.config.inputSchema).parse({
        ops: [{ op: 'create', type: 'cube', as: '$c', material: { baseColor: [1, 0, 0] }, body: { mass: 1 }, script: 'Spin', scriptFields: { speed: 2 } }],
        capture: { focus: '$c' },
    });
    assert.equal(parsed.ops[0].material.baseColor[0], 1);
    assert.ok(z.object(edit.config.inputSchema).safeParse({ ops: [{ op: 'update', node: '@selected', material: 'Red' }], capture: true }).success);
});

test('results are compact JSON', () => {
    assert.equal(toToolResult({ data: { a: 1, b: [1, 2] } }).content[0].text, '{"a":1,"b":[1,2]}');
});
