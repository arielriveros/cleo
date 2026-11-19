import { describe, it, expect, vi } from 'vitest';

// Deleting a project erases every trace of it: its kv keys, the texture, audio and GI bake payloads, its Play
// saves, its localStorage and its registry entry. Audio, GI bakes and Play saves used to be left behind.

const kv = new Map<string, any>([
  ['cleo_projects', [{ id: 'A', name: 'Alpha' }, { id: 'B', name: 'Beta' }]],
  ['p:A:cleo_materials', []], ['p:A:cleo_meta', {}], ['p:B:cleo_materials', []],
]);
const wiped: string[] = [];

vi.mock('@cleo/app-kit/utils/idb', () => ({
  idbGet: async (key: string) => (kv.has(key) ? kv.get(key) : null),
  idbSet: async (key: string, value: any) => { kv.set(key, value); },
  idbDelete: async (key: string) => { kv.delete(key); },
  idbKeysByPrefix: async (prefix: string) => [...kv.keys()].filter(k => k.startsWith(prefix)),
}));
vi.mock('../src/utils/textureStore', () => ({ deleteProjectTextures: async (id: string) => { wiped.push(`textures ${id}`); }, migrateUnscopedTextures: async () => {} }));
vi.mock('../src/utils/audioStore', () => ({ deleteProjectAudio: async (id: string) => { wiped.push(`audio ${id}`); } }));
vi.mock('../src/utils/giBakeStore', () => ({ deleteProjectGiBakes: async (id: string) => { wiped.push(`gi bakes ${id}`); } }));
vi.mock('../src/features/saves/playSaves', () => ({ deleteProjectPlaySaves: async (id: string) => { wiped.push(`play saves ${id}`); } }));
vi.mock('../src/utils/lsScope', () => ({ MIGRATABLE_LS_KEYS: [], lsKey: (k: string) => k, projectLsKeys: (id: string) => [`p:${id}:cleo_tabs`] }));

const removed: string[] = [];
(globalThis as any).localStorage = { removeItem: (k: string) => removed.push(k), getItem: () => null, setItem: () => {} };

const { wipeProject } = await import('../src/utils/projects');

describe('wiping a project', () => {
  it('erases every store it has data in, and only its own', async () => {
    await wipeProject('A');
    expect([...kv.keys()].filter(k => k.startsWith('p:A:'))).toEqual([]);
    expect(kv.has('p:B:cleo_materials')).toBe(true);
    expect(wiped).toEqual(['textures A', 'audio A', 'gi bakes A', 'play saves A']);
    expect(removed).toEqual(['p:A:cleo_tabs']);
    expect(kv.get('cleo_projects')).toEqual([{ id: 'B', name: 'Beta' }]);
  });
});
