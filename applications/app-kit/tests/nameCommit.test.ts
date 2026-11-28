import { describe, it, expect } from 'vitest';

// A name field commits once, on Enter or leaving it: what it commits.
const { nameCommit } = await import('../src/ui/inputs');

describe('nameCommit', () => {
  it('commits a valid, changed, trimmed name; nothing for the same name, an empty one or one the check refuses', () => {
    expect(nameCommit('Hurt', '  Hurting ')).toBe('Hurting');
    expect(nameCommit('Hurt', 'Hurt ')).toBeNull();
    expect(nameCommit('Hurt', '   ')).toBeNull();
    const taken = (n: string) => (n === 'Fine' ? 'taken' : null);
    expect(nameCommit('Hurt', 'Fine', taken)).toBeNull();
    expect(nameCommit('Hurt', 'Down', taken)).toBe('Down');
  });
});
