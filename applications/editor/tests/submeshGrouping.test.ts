import { describe, it, expect } from 'vitest';

// Grouping an imported file's sub-meshes into model assets — the data behind the import modal's Groups
// editor. Pure functions, so no `cleo` mock and no GL context is needed here.
//
// The two invariants everything else rests on: every part is in EXACTLY one group, and no group is ever
// empty mid-edit. A part in no group would be silently dropped from the import; an empty group would
// build an asset with no mesh.

const {
  defaultGroupsByMaterial, groupsPerPart, movePart, addGroup, removeGroup, renameGroup,
  compactGroups, isValidGrouping, groupOfPart,
} = await import('../src/utils/submeshGroups');

const parts = (...materialIndices: number[]) =>
  materialIndices.map((materialIndex, i) => ({ name: `part${i}`, materialIndex }));

/** Every part in exactly one group, and no index invented. */
const partitions = (groups: any[], count: number) => isValidGrouping(groups, count);

describe('defaultGroupsByMaterial — the seed', () => {
  it('puts parts sharing a material in one group, one group per material', () => {
    const groups = defaultGroupsByMaterial(parts(0, 1, 0, 2, 1), 'char');
    expect(groups.map(g => g.parts)).toEqual([[0, 2], [1, 4], [3]]);
    expect(partitions(groups, 5)).toBe(true);
  });

  it('names a single-part group after the part, and a merged one after the bundle', () => {
    const groups = defaultGroupsByMaterial(parts(0, 0, 1), 'char');
    expect(groups[0].name).toBe('char_1');   // two parts merged — no one member names the whole
    expect(groups[1].name).toBe('part2');
  });

  it('never emits the same name twice — group names become ASSET names', () => {
    const dupes = [
      { name: 'body', materialIndex: 0 },
      { name: 'body', materialIndex: 1 },
    ];
    const groups = defaultGroupsByMaterial(dupes, 'char');
    expect(new Set(groups.map(g => g.name)).size).toBe(2);
  });

  it('groups parts with no material (-1) together, as their own bucket', () => {
    const groups = defaultGroupsByMaterial(parts(-1, 0, -1), 'char');
    expect(groups.find(g => g.parts.includes(0))!.parts).toEqual([0, 2]);
  });

  it('one part in, one group out', () => {
    expect(defaultGroupsByMaterial(parts(0), 'char')).toHaveLength(1);
    expect(defaultGroupsByMaterial([], 'char')).toEqual([]);
  });
});

describe('the two older import options are the degenerate cases', () => {
  it('a group per part reproduces "Separate sub-models"', () => {
    const groups = groupsPerPart(parts(0, 0, 1), 'char');
    expect(groups).toHaveLength(3);
    expect(groups.every(g => g.parts.length === 1)).toBe(true);
    expect(partitions(groups, 3)).toBe(true);
  });

  it('one group holding everything reproduces "Merge sub-meshes"', () => {
    // Every part shares a material → the by-material seed collapses to a single group.
    const groups = defaultGroupsByMaterial(parts(0, 0, 0), 'char');
    expect(groups).toHaveLength(1);
    expect(groups[0].parts).toEqual([0, 1, 2]);
  });
});

describe('movePart', () => {
  const seed = () => defaultGroupsByMaterial(parts(0, 1, 0), 'char'); // [[0,2],[1]]

  it('removes the part from its old group and keeps members in file order', () => {
    const next = movePart(seed(), 1, 0);
    // Order matters: merged geometry is concatenated in the order the parts are passed.
    expect(next[0].parts).toEqual([0, 1, 2]);
  });

  it('drops a group the move left empty', () => {
    const next = movePart(seed(), 1, 0);
    expect(next).toHaveLength(1);
    expect(partitions(next, 3)).toBe(true);
  });

  it('keeps a group that still has members', () => {
    const next = movePart(seed(), 0, 1);
    expect(next.map(g => g.parts)).toEqual([[2], [0, 1]]);
  });

  it('is a no-op for a part already in the target, and for an out-of-range target', () => {
    const groups = seed();
    expect(movePart(groups, 0, 0)).toBe(groups);
    expect(movePart(groups, 0, 9)).toBe(groups);
    expect(movePart(groups, 0, -1)).toBe(groups);
  });

  it('never loses or duplicates a part across a sequence of moves', () => {
    let groups = defaultGroupsByMaterial(parts(0, 1, 2, 0, 1), 'char');
    groups = movePart(groups, 4, 0);
    groups = addGroup(groups, 'char');
    groups = movePart(groups, 0, groups.length - 1);
    groups = movePart(groups, 2, 0);
    expect(partitions(groups, 5)).toBe(true);
    expect(groups.every(g => g.parts.length > 0)).toBe(true);
  });
});

describe('addGroup / removeGroup / renameGroup', () => {
  it('adds an empty, uniquely named group', () => {
    const groups = addGroup(defaultGroupsByMaterial(parts(0, 1), 'char'), 'char');
    expect(groups).toHaveLength(3);
    expect(groups[2].parts).toEqual([]);
    expect(new Set(groups.map(g => g.name)).size).toBe(3);
  });

  it('removeGroup rehomes its parts rather than orphaning them', () => {
    const groups = removeGroup(defaultGroupsByMaterial(parts(0, 1, 2), 'char'), 1);
    expect(groups).toHaveLength(2);
    expect(partitions(groups, 3)).toBe(true);
    expect(groups[0].parts).toEqual([0, 1]); // fell back to the group before it
  });

  it('removing the FIRST group rehomes into the one after it', () => {
    const groups = removeGroup(defaultGroupsByMaterial(parts(0, 1, 2), 'char'), 0);
    expect(groups[0].parts).toEqual([0, 1]);
    expect(partitions(groups, 3)).toBe(true);
  });

  it('refuses to remove the only group — its parts would have nowhere to go', () => {
    const groups = defaultGroupsByMaterial(parts(0, 0), 'char');
    expect(removeGroup(groups, 0)).toBe(groups);
  });

  it('renameGroup touches only the named group', () => {
    const groups = renameGroup(defaultGroupsByMaterial(parts(0, 1), 'char'), 1, 'sword');
    expect(groups[1].name).toBe('sword');
    expect(groups[0].parts).toEqual([0]);
  });
});

describe('isValidGrouping — the guard the import re-runs after a re-parse', () => {
  const groups = [{ name: 'a', parts: [0, 1] }, { name: 'b', parts: [2] }];

  it('accepts a full partition', () => {
    expect(isValidGrouping(groups, 3)).toBe(true);
  });

  it('rejects an index past the end — the re-parse produced FEWER sub-meshes', () => {
    expect(isValidGrouping(groups, 2)).toBe(false);
  });

  it('rejects a part left uncovered — the re-parse produced MORE sub-meshes', () => {
    expect(isValidGrouping(groups, 4)).toBe(false);
  });

  it('rejects a part claimed twice', () => {
    expect(isValidGrouping([{ name: 'a', parts: [0, 1] }, { name: 'b', parts: [1, 2] }], 3)).toBe(false);
  });
});

describe('compactGroups / groupOfPart', () => {
  it('compactGroups drops the empty column an edit can leave behind', () => {
    const groups = addGroup(defaultGroupsByMaterial(parts(0, 1), 'char'), 'char');
    expect(compactGroups(groups)).toHaveLength(2);
    expect(isValidGrouping(compactGroups(groups), 2)).toBe(true);
  });

  it('groupOfPart maps every part back to its column', () => {
    expect(groupOfPart(defaultGroupsByMaterial(parts(0, 1, 0), 'char'), 3)).toEqual([0, 1, 0]);
  });

  it('reports -1 for a part no group claims', () => {
    expect(groupOfPart([{ name: 'a', parts: [0] }], 2)).toEqual([0, -1]);
  });
});
