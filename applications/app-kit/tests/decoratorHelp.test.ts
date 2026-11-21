import { describe, it, expect } from 'vitest';
import * as Decorators from 'cleo/decorators';
import { DECORATORS, decoratorImportEdit, decoratorsFor } from '../src/code/decoratorHelp';
import { highlight } from '../src/docs/viewer/highlight';

// What the script editor's `@` completion offers and inserts (code/decoratorHelp.ts, used by tsCompletions.ts).

const apply = (source: string, name: string) => {
  const edit = decoratorImportEdit(source, name);
  return edit ? source.slice(0, edit.offset) + edit.text + source.slice(edit.offset) : source;
};

describe('the decorator list', () => {
  it("names exactly what 'cleo/decorators' exports", () => {
    expect(DECORATORS.map(d => d.name).sort()).toEqual(Object.keys(Decorators).sort());
  });

  it('puts what fits the member first, keeping table order within each part', () => {
    const forMethod = decoratorsFor('method');
    expect(forMethod[0].entry.name).toBe('onAction');
    expect(forMethod.filter(d => d.fits).every(d => d.entry.target === 'method')).toBe(true);
    expect(forMethod.findIndex(d => !d.fits)).toBe(DECORATORS.filter(d => d.target === 'method').length);
    expect(decoratorsFor(null).every(d => d.fits)).toBe(true);
    expect(decoratorsFor(null).map(d => d.entry.name)).toEqual(DECORATORS.map(d => d.name));
  });
});

describe('the import a decorator needs', () => {
  it("goes into the braces of the script's 'cleo/decorators' import", () => {
    expect(apply(`import { Node } from 'cleo'\nimport { save } from 'cleo/decorators'\n`, 'child'))
      .toBe(`import { Node } from 'cleo'\nimport { save, child } from 'cleo/decorators'\n`);
    expect(apply(`import {\n  save,\n  options,\n} from "cleo/decorators"\n`, 'every'))
      .toBe(`import {\n  save,\n  options, every,\n} from "cleo/decorators"\n`);
    expect(apply(`import {} from 'cleo/decorators'`, 'save')).toBe(`import { save } from 'cleo/decorators'`);
  });

  it("is a new line under the 'cleo' import, in its quotes and line endings", () => {
    expect(apply(`import { Node } from 'cleo'\nimport { m } from '@/Shared/Math'\n\nexport default class A extends Node {}`, 'save'))
      .toBe(`import { Node } from 'cleo'\nimport { save } from 'cleo/decorators'\nimport { m } from '@/Shared/Math'\n\nexport default class A extends Node {}`);
    expect(apply(`import { Node } from "cleo";\r\nclass A {}`, 'save'))
      .toBe(`import { Node } from "cleo";\r\nimport { save } from "cleo/decorators"\r\nclass A {}`);
  });

  it('goes under the last import without a cleo one, and at the top with no import at all', () => {
    expect(apply(`import { m } from './Util'\nimport type {\n  T,\n} from '@/Types'\nclass A {}`, 'save'))
      .toBe(`import { m } from './Util'\nimport type {\n  T,\n} from '@/Types'\nimport { save } from 'cleo/decorators'\nclass A {}`);
    expect(apply(`class A {}`, 'save')).toBe(`import { save } from 'cleo/decorators'\nclass A {}`);
  });

  it('is nothing when the name is imported already', () => {
    expect(decoratorImportEdit(`import { save, child } from 'cleo/decorators'`, 'child')).toBeNull();
    expect(decoratorImportEdit(`import { Node } from 'cleo'\nimport {\n  child,\n} from 'cleo/decorators'`, 'child')).toBeNull();
  });
});

describe("the docs viewer's highlighter", () => {
  it('colours decorators in TypeScript, but not inside strings or comments', () => {
    const runs = highlight(`@attribute('Combat') damage = 10 // @save\nconst s = 'a@b'`, 'ts');
    expect(runs.filter(r => r.kind === 'decorator').map(r => r.text)).toEqual(['@attribute']);
  });
});
