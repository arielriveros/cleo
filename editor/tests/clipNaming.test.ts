import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isGenericClipName, fileStem, clipNameFromFile } from '../src/utils/clipNaming';
import { groupImportFiles } from '../src/utils/importGrouping';

// Two silent failures that together made "import the model and all its animations" play the wrong
// clips, both measured on a real Mixamo zombie (build/zombie/*.fbx):
//
// 1. All FIVE files — the character and its four animations — name their single clip `mixamo.com`.
//    Imported as-is the de-duper turns them into `mixamo.com`, `(2)`, `(3)`, `(4)`, `(5)`, which nothing
//    downstream can tell apart, because a state machine, an Animation Field sample and
//    `animator.play(...)` all address clips BY NAME. Worse, the CHARACTER's own `mixamo.com` is a
//    two-keyframe bind-pose stub with zero varying channels, so whatever resolves to it plays frozen.
//
// 2. assimp's `ConvertFileList` treats the first file as the scene and everything after it as sidecars,
//    so converting four independent .fbx in one call returns ONE animation. Selecting idle+walk+dying+
//    running imported a single clip with nothing said about the other three. The fix routes the
//    selection through `groupImportFiles`, the splitter the model importer already uses.

describe('isGenericClipName — exporter placeholders', () => {
  it('recognises the names every exporter reaches for', () => {
    for (const name of [
      'mixamo.com', 'Mixamo.com',           // every Mixamo download, character and animation alike
      'Animation',                          // GLTFLoader's fallback for a nameless clip
      'Take 001', 'take001',                // assimp's FBX take naming
      'Default Take', 'defaulttake',        // the FBX SDK's default stack
      'unnamed', 'Anim', 'anim_0', 'animation 1',
      '', '   ',
    ]) {
      expect(isGenericClipName(name), name).toBe(true);
    }
    expect(isGenericClipName(undefined)).toBe(true);
  });

  it('leaves a name an author actually chose alone', () => {
    for (const name of [
      'Walk', 'Zombie Dying', 'Idle_02', 'Take Off', 'Animation of a Dog', 'mixamo.com walk',
    ]) {
      expect(isGenericClipName(name), name).toBe(false);
    }
  });
});

describe('clipNameFromFile', () => {
  it('renames a placeholder after its file', () => {
    expect(clipNameFromFile('mixamo.com', 'Zombie Walk.fbx')).toBe('Zombie Walk');
    expect(clipNameFromFile('Animation', 'Zombie Dying.fbx')).toBe('Zombie Dying');
    // The character file too: its stub clip becomes identifiable rather than colliding with the
    // animations later imported onto the same rig.
    expect(clipNameFromFile('mixamo.com', 'Ch10_nonPBR (1).fbx')).toBe('Ch10_nonPBR (1)');
  });

  it('keeps a real name even when the file says otherwise', () => {
    expect(clipNameFromFile('Walk', 'Zombie Dying.fbx')).toBe('Walk');
  });

  it('never returns nothing', () => {
    // An extensionless or dotfile name must not blank the clip out.
    expect(clipNameFromFile('mixamo.com', '.fbx')).toBe('mixamo.com');
    expect(clipNameFromFile('mixamo.com', '')).toBe('mixamo.com');
  });

  it('gives the four zombie animations four distinct names', () => {
    const files = ['Zombie Idle (1).fbx', 'Zombie Walk.fbx', 'Zombie Dying.fbx', 'Zombie Running.fbx'];
    // Every one of these really does carry the clip name `mixamo.com` — measured, not assumed.
    const named = files.map(f => clipNameFromFile('mixamo.com', f));
    expect(new Set(named).size).toBe(4);
    expect(named).toContain('Zombie Walk');
  });

  it('strips a folder when the name arrives as a path', () => {
    expect(fileStem('anims/Zombie Walk.fbx')).toBe('Zombie Walk');
    expect(fileStem('anims\\Zombie Walk.fbx')).toBe('Zombie Walk');
  });
});

/** A File the way the animation picker hands them over: bare names, no folder. */
function pick(name: string): File {
  return new File([new Uint8Array([0])], name);
}

describe('animation import splits a multi-file selection', () => {
  it('makes one bundle per animation file', () => {
    // The regression: these four went to assimp in ONE ConvertFileList call, which converts the first
    // and discards the rest.
    const bundles = groupImportFiles([
      pick('Zombie Idle (1).fbx'), pick('Zombie Walk.fbx'),
      pick('Zombie Dying.fbx'), pick('Zombie Running.fbx'),
    ]);

    expect(bundles).toHaveLength(4);
    expect(bundles.map(b => b.name).sort())
      .toEqual(['Zombie Dying', 'Zombie Idle (1)', 'Zombie Running', 'Zombie Walk']);
    // Each bundle carries exactly its own file, so nothing is fed to assimp as a sidecar of another.
    for (const b of bundles) expect(b.files).toHaveLength(1);
  });

  it('keeps a .gltf and its .bin together', () => {
    // The reason the split cannot simply be "one file, one import": these two ARE one animation.
    const bundles = groupImportFiles([pick('walk.gltf'), pick('walk.bin')]);

    expect(bundles).toHaveLength(1);
    expect(bundles[0].files.map(f => f.name).sort()).toEqual(['walk.bin', 'walk.gltf']);
  });

  it('pairs each .bin with its own .gltf when several are picked at once', () => {
    const bundles = groupImportFiles([
      pick('walk.gltf'), pick('walk.bin'), pick('idle.gltf'), pick('idle.bin'),
    ]);

    expect(bundles).toHaveLength(2);
    const walk = bundles.find(b => b.name === 'walk')!;
    const idle = bundles.find(b => b.name === 'idle')!;
    expect(walk.files.map(f => f.name).sort()).toEqual(['walk.bin', 'walk.gltf']);
    expect(idle.files.map(f => f.name).sort()).toEqual(['idle.bin', 'idle.gltf']);
  });

  it('reports nothing to import rather than silently doing one file', () => {
    expect(groupImportFiles([pick('notes.txt')])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// Source pins. Both fixes live inside functions too entangled with React state and a GL context to call
// from a unit test — but each is one specific call, and losing it reinstates a failure that is SILENT:
// the wrong clip plays, or three of four files vanish, with nothing logged either way.
// ---------------------------------------------------------------------------------------------------

// CRLF is normalised because the repo mixes line endings; a pin that matches only one of them is a
// platform-dependent test.
const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

/** The body of a top-level `const <name> = ...` arrow function, to the next same-indent declaration. */
function functionBody(source: string, decl: string): string {
  const at = source.indexOf(decl);
  expect(at, `${decl} not found`).toBeGreaterThan(-1);
  const rest = source.slice(at + decl.length);
  const end = rest.search(/\n  (?:const|function|\/\/ [A-Z])/);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('the import routes keep their fixes', () => {
  it('importAnimationFiles splits the selection before parsing it', () => {
    const body = functionBody(read('src/features/EngineContext.tsx'), 'const importAnimationFiles = async (files: File[]) => {');

    // Without this the whole selection goes to assimp in one call and only the first file survives.
    expect(body).toContain('groupImportFiles(files)');
    // And the parse must be given a BUNDLE, never the original selection.
    expect(body).toContain('parseAnimationFiles(bundle.files');
    expect(body).not.toMatch(/parseAnimationFiles\(files/);
  });

  it('the model route renames a placeholder clip after its file', () => {
    const source = read('src/utils/modelImport.ts');

    // The character's own `mixamo.com` stub, left alone, collides by name with every animation later
    // imported onto the same rig.
    expect(source).toContain("import { clipNameFromFile } from './clipNaming'");
    expect(source).toMatch(/clipNameFromFile\(clip\.name, name\)/);
    expect(source).toMatch(/renameAnimation\(clip\.name, wanted\)/);
  });

  it('the review modal seeds its rename boxes from the same rule', () => {
    const source = read('src/features/animation/AnimationImportModal.tsx');

    expect(source).toContain("from '../../utils/clipNaming'");
    expect(source).toContain('clipNameFromFile(c.name, pendingAnimationImport.fileName)');
    // The old local copy knew only `mixamo.com` and `Animation`, and could not be shared with the model
    // route — which is how the two doors came to name the same download differently.
    expect(source).not.toContain('function defaultClipName');
  });
});
