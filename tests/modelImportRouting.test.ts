import { describe, it, expect } from 'vitest';
import { groupImportFiles, isModelFile } from '../editor/src/utils/importGrouping';

// Model import has two silent-failure modes that these cover.
//
// 1. An aux file no bundle claims is registered as a LOOSE texture by runUpload, so it never reaches the
//    material: the model imports untextured while its images sit in the explorer, and nothing is said.
//    That is what a strict "at or below the model's own folder" rule did to the very common
//    `Character/model/char.fbx` + `Character/textures/char_D.png` layout.
// 2. An unresolved texture reported as *unloadable* renders as unfixable, with no file picker — so an
//    ordinary absent file has to land in `missingFiles` instead, or the user cannot supply it.

/** A File tagged the way readDroppedEntries tags a dropped folder's contents. */
function fileAt(relativePath: string): File {
  const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  const f = new File([new Uint8Array([0])], name);
  Object.defineProperty(f, 'relativePath', { value: relativePath });
  return f;
}

const namesOf = (files: File[]) => files.map(f => f.name).sort();

describe('groupImportFiles — which images reach the model', () => {
  it('claims a sibling textures/ folder', () => {
    const files = [
      fileAt('Character/model/char.fbx'),
      fileAt('Character/textures/char_D.png'),
      fileAt('Character/textures/char_N.png'),
    ];
    const bundles = groupImportFiles(files);

    expect(bundles).toHaveLength(1);
    expect(namesOf(bundles[0].files)).toEqual(['char.fbx', 'char_D.png', 'char_N.png']);
  });

  it('still claims its own folder and anything nested under it', () => {
    const files = [
      fileAt('Character/char.fbx'),
      fileAt('Character/char_D.png'),
      fileAt('Character/maps/char_N.png'),
    ];
    expect(namesOf(groupImportFiles(files)[0].files)).toEqual(['char.fbx', 'char_D.png', 'char_N.png']);
  });

  it('claims everything when the selection holds a single model, however it is laid out', () => {
    // Nothing else the images could belong to, and leaving them unclaimed is the silent failure.
    const files = [
      fileAt('deep/nested/model/char.fbx'),
      fileAt('some/unrelated/place/char_D.png'),
    ];
    expect(namesOf(groupImportFiles(files)[0].files)).toEqual(['char.fbx', 'char_D.png']);
  });

  it('keeps a .mtl with the model of the same name when a folder holds several', () => {
    const files = [
      fileAt('props/rock.obj'), fileAt('props/rock.mtl'),
      fileAt('props/tree.obj'), fileAt('props/tree.mtl'),
      fileAt('props/shared.png'),
    ];
    const bundles = groupImportFiles(files);
    const rock = bundles.find(b => b.name === 'rock')!;
    const tree = bundles.find(b => b.name === 'tree')!;

    expect(namesOf(rock.files)).toEqual(['rock.mtl', 'rock.obj', 'shared.png']);
    expect(namesOf(tree.files)).toEqual(['shared.png', 'tree.mtl', 'tree.obj']);
  });

  it('does not let a top-level model swallow another top-level model\'s textures', () => {
    // Both sit at depth 1, so their "parent" is the selection root. Reaching sideways from there would
    // claim the whole drop — and an image a bundle claims but never uses is not registered as a loose
    // texture either, so it would simply vanish.
    const files = [
      fileAt('rock/rock.fbx'), fileAt('rock/rock_D.png'),
      fileAt('tree/tree.fbx'), fileAt('tree/tree_D.png'),
    ];
    const bundles = groupImportFiles(files);

    expect(namesOf(bundles.find(b => b.name === 'rock')!.files)).toEqual(['rock.fbx', 'rock_D.png']);
    expect(namesOf(bundles.find(b => b.name === 'tree')!.files)).toEqual(['tree.fbx', 'tree_D.png']);
  });

  it('keeps two deep models apart while each still reaches its own sibling textures', () => {
    const files = [
      fileAt('kit/rock/mesh/rock.fbx'), fileAt('kit/rock/textures/rock_D.png'),
      fileAt('kit/tree/mesh/tree.fbx'), fileAt('kit/tree/textures/tree_D.png'),
    ];
    const bundles = groupImportFiles(files);

    expect(bundles).toHaveLength(2);
    expect(namesOf(bundles.find(b => b.name === 'rock')!.files)).toEqual(['rock.fbx', 'rock_D.png']);
    expect(namesOf(bundles.find(b => b.name === 'tree')!.files)).toEqual(['tree.fbx', 'tree_D.png']);
    for (const b of bundles) expect(b.files.filter(isModelFile)).toHaveLength(1);
  });

  it('gives every model its own bundle seeded by exactly one model file', () => {
    const files = [fileAt('a/one.fbx'), fileAt('a/two.glb'), fileAt('a/tex.png')];
    const bundles = groupImportFiles(files);
    expect(bundles.map(b => b.name).sort()).toEqual(['one', 'two']);
    for (const b of bundles) expect(b.files.filter(isModelFile)).toHaveLength(1);
  });

  it('returns nothing when the selection has no model file', () => {
    expect(groupImportFiles([fileAt('a/tex.png')])).toEqual([]);
  });
});

// The report's two buckets drive two different UIs: `missingFiles` gets a file picker, `unloadable` gets
// a "cannot be repaired" notice. Putting an ordinary absent file in the wrong one makes it unfixable.
// These mirror the classification in Loader.assembleGltfModels / assembleAssimpModels without needing a
// GL context (the assemblers themselves upload textures, so they cannot run here).
describe('unresolved-texture classification', () => {
  type Unresolved = { name: string; from: string };

  /** The rule assembleGltfModels applies to a GltfImageSource. */
  function classifyGltfImage(image: { kind: string; uri?: string; fileName?: string }, present: string[]) {
    const missingFiles: Unresolved[] = [];
    const unloadable: Unresolved[] = [];
    const from = 'material 0 · base colour';
    if (image.kind === 'file' && !present.includes(image.fileName!)) missingFiles.push({ name: image.fileName!, from });
    else if (image.kind === 'missing') {
      if (image.uri) missingFiles.push({ name: image.uri.split(/[\\/]/).pop()!, from });
      else unloadable.push({ name: 'image #0', from });
    }
    return { missingFiles, unloadable };
  }

  it('an external glTF image that is absent is pickable, not unloadable', () => {
    const r = classifyGltfImage({ kind: 'missing', uri: 'textures/char_D.png' }, []);
    expect(r.missingFiles).toEqual([{ name: 'char_D.png', from: 'material 0 · base colour' }]);
    expect(r.unloadable).toEqual([]);
  });

  it('an image with no URI at all has nothing to pick, so it is unloadable', () => {
    const r = classifyGltfImage({ kind: 'missing' }, []);
    expect(r.missingFiles).toEqual([]);
    expect(r.unloadable).toHaveLength(1);
  });

  it("a 'file' image whose file was not uploaded is pickable under its own name", () => {
    const r = classifyGltfImage({ kind: 'file', fileName: 'char_D.png' }, ['other.png']);
    expect(r.missingFiles.map(t => t.name)).toEqual(['char_D.png']);
  });

  it('resolves nothing when the file is present', () => {
    const r = classifyGltfImage({ kind: 'file', fileName: 'char_D.png' }, ['char_D.png']);
    expect(r.missingFiles).toEqual([]);
    expect(r.unloadable).toEqual([]);
  });
});
