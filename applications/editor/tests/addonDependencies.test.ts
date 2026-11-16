import { describe, it, expect } from 'vitest';
import { activeAddons, addonOffPrompt, dependentsOf, missingRequirements, withAddon, withoutAddon } from '../src/features/addons/dependencies';
import type { AddonManifest } from '../src/features/addons/types';

// What an addon needs to run (AddonManifest.requires): the built-in Claude Code addon runs on the MCP server
// addon, so it is off while that one is, and turning the MCP server off turns Claude Code off with it.

const ids = (list: readonly AddonManifest[]) => list.map(a => a.id);

const addon = (id: string, extra: Partial<AddonManifest> = {}): AddonManifest => ({
  id, name: id.toUpperCase(), description: '', version: '1', author: '', docPage: '', defaultOn: true,
  load: async () => ({ activate: () => ({}) }), ...extra,
});

describe('the built-in addons and what they need', () => {
  it('runs Claude Code only with the MCP server, the server first', () => {
    expect(ids(activeAddons(['claude-code', 'mcp-server']))).toEqual(['mcp-server', 'claude-code']);
    expect(ids(activeAddons(['claude-code']))).toEqual([]);
    expect(ids(activeAddons(['mcp-server']))).toEqual(['mcp-server']);
    expect(ids(activeAddons(['mcp-server', 'no-such-addon']))).toEqual(['mcp-server']);
  });

  it('greys Claude Code while the MCP server is off', () => {
    expect(ids(missingRequirements('claude-code', ['claude-code']))).toEqual(['mcp-server']);
    expect(ids(missingRequirements('claude-code', ['mcp-server']))).toEqual([]);
    expect(ids(missingRequirements('mcp-server', []))).toEqual([]);
  });

  it('turns Claude Code off with the MCP server, and not the other way round', () => {
    expect(ids(dependentsOf('mcp-server'))).toEqual(['claude-code']);
    expect(withoutAddon(['mcp-server', 'claude-code'], 'mcp-server')).toEqual([]);
    expect(withoutAddon(['mcp-server', 'claude-code'], 'claude-code')).toEqual(['mcp-server']);
    expect(withAddon(['mcp-server'], 'claude-code')).toEqual(['mcp-server', 'claude-code']);
    expect(withAddon(['mcp-server'], 'mcp-server')).toEqual(['mcp-server']);
  });
});

describe('addon requirements in general', () => {
  const a = addon('a');
  const b = addon('b', { requires: ['a'], confirmDisable: 'Turning B off ends its session.' });
  const c = addon('c', { requires: ['b'] });
  const loop1 = addon('x', { requires: ['y'] });
  const loop2 = addon('y', { requires: ['x'] });
  const all = [a, b, c, loop1, loop2];

  it('follows requirements through other addons', () => {
    expect(ids(activeAddons(['c', 'b', 'a'], all))).toEqual(['a', 'b', 'c']);
    expect(ids(activeAddons(['c', 'a'], all))).toEqual(['a']);
    expect(ids(dependentsOf('a', all))).toEqual(['b', 'c']);
    expect(withoutAddon(['a', 'b', 'c'], 'a', all)).toEqual([]);
    expect(ids(missingRequirements('c', ['a', 'c'], all))).toEqual(['b']);
  });

  it('runs neither addon of a requirement loop', () => {
    expect(ids(activeAddons(['x', 'y'], all))).toEqual([]);
  });

  it('asks before turning off what goes off with it', () => {
    expect(addonOffPrompt(a, [])).toBeNull();
    expect(addonOffPrompt(a, [b, c])).toBe('B needs it and turns off too: turning B off ends its session. C needs it and turns off too.');
    expect(addonOffPrompt(b, [])).toBe('Turning B off ends its session.');
  });
});
