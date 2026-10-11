import { describe, it, expect } from 'vitest'
import { buildScriptAsset, isAttachable, scriptKindOf, type ScriptAsset } from '../src/utils/scripts'
import {
  buildScriptGraphCtx, dependentsOf, deriveBaseType, importClosure, moduleIdOfVfsPath, resolveScriptVariables,
  scriptRoleLabel,
} from '../src/utils/scriptGraph'
import { attachScriptModules } from '../src/features/publish/buildGameData'
import { extractScripts, buildScriptsSource } from '../src/features/publish/extractScripts'
import { staticScaffold } from '../src/features/scriptWorkspace/scaffold'

// The editor half of script modules: what a script IS (a node class or a shared module), what it extends
// through other scripts, which fields it inherits, and which modules a build ships.

const MATH = `export const TAU = Math.PI * 2\nexport function clamp01(v: number) { return Math.max(0, Math.min(1, v)) }`
const BASE = `import { CharacterNode } from 'cleo'
import { clamp01 } from './Math'
export default class EnemyBase extends CharacterNode {
  public maxHp: number = 100
  public speed: number = 2
  ratio() { return clamp01(1) }
}`
const HOLLOW = `import EnemyBase from '@/Shared/EnemyBase'
export default class Hollow extends EnemyBase {
  public speed: number = 5
  public souls: number = 120
}`
const NAMED = `import { CharacterNode as CN } from 'cleo'
export class Guard extends CN { public alert: boolean = true }
export const RANGE = 4`
const KNIGHT = `import { Guard } from '../Shared/Named'
export default class Knight extends Guard { public poise: number = 70 }`

function library() {
  const assets: ScriptAsset[] = [
    buildScriptAsset('Math', 'node', MATH, 'math'),
    buildScriptAsset('EnemyBase', 'node', BASE, 'base'),
    buildScriptAsset('Hollow', 'node', HOLLOW, 'hollow'),
    buildScriptAsset('Named', 'node', NAMED, 'named'),
    buildScriptAsset('Knight', 'node', KNIGHT, 'knight'),
  ]
  const paths = new Map([
    ['math', '/Shared/Math.script'], ['base', '/Shared/EnemyBase.script'], ['hollow', '/Enemies/Hollow.script'],
    ['named', '/Shared/Named.script'], ['knight', '/Enemies/Knight.script'],
  ])
  return { assets, paths, ctx: buildScriptGraphCtx(paths, assets) }
}

describe('script kinds', () => {
  it('tells a node script from a shared module', () => {
    expect(scriptKindOf(BASE)).toBe('class')
    expect(scriptKindOf(MATH)).toBe('module')
    expect(scriptKindOf(NAMED)).toBe('module')                        // a class AND other exports
    expect(scriptKindOf(`export class Only extends Node {}`)).toBe('class')
    expect(scriptKindOf(`this.onUpdate = () => {}`)).toBe('class')    // legacy handler script
    expect(scriptKindOf('')).toBe('class')                            // an empty new file stays attachable
    expect(scriptKindOf(`// export const x = 1\nexport default class A extends Node {}`)).toBe('class')
  })

  it('never lets a module attach to a node', () => {
    const { assets } = library()
    expect(isAttachable(assets[0], 'node')).toBe(false)
    expect(isAttachable(assets[1], 'node')).toBe(true)
    expect(assets[0].variables).toEqual([])
  })

  it('reflects the default class, not a helper class declared above it', () => {
    const asset = buildScriptAsset('X', 'node', `class Helper { public wrong: number = 1 }\nexport default class X extends Node { public right: number = 2 }`)
    expect(asset.variables.map(v => v.name)).toEqual(['right'])
  })
})

describe('inheritance through scripts', () => {
  it('follows extends through other scripts to the engine base type', () => {
    const { ctx } = library()
    expect(moduleIdOfVfsPath('/Enemies/Hollow.script')).toBe('/Enemies/Hollow')
    expect(deriveBaseType(HOLLOW, '/Enemies/Hollow', ctx)).toBe('character')
    expect(deriveBaseType(KNIGHT, '/Enemies/Knight', ctx)).toBe('character')   // named import, aliased engine class
    expect(deriveBaseType(`import X from '@/Nowhere'\nexport default class Y extends X {}`, '/Y', ctx)).toBe('node')
  })

  it('survives an inheritance cycle', () => {
    const a = buildScriptAsset('A', 'node', `import B from './B'\nexport default class A extends B {}`, 'a')
    const b = buildScriptAsset('B', 'node', `import A from './A'\nexport default class B extends A {}`, 'b')
    const ctx = buildScriptGraphCtx(new Map([['a', '/A.script'], ['b', '/B.script']]), [a, b])
    expect(deriveBaseType(a.source, '/A', ctx)).toBe('node')
    expect(resolveScriptVariables(a.source, '/A', ctx)).toEqual([])
  })

  it('merges inherited fields base-first, so the derived default wins', () => {
    const { ctx } = library()
    const vars = resolveScriptVariables(HOLLOW, '/Enemies/Hollow', ctx)
    expect(vars.map(v => [v.name, v.default])).toEqual([['maxHp', 100], ['speed', 5], ['souls', 120]])
    const knight = resolveScriptVariables(KNIGHT, '/Enemies/Knight', ctx)
    expect(knight.map(v => v.name)).toEqual(['alert', 'poise'])
  })

  it('labels a script by its role', () => {
    const { assets, ctx } = library()
    expect(scriptRoleLabel(assets[0], ctx)).toBe('Module')
    expect(scriptRoleLabel(assets[2], ctx)).toBe('extends EnemyBase')
    expect(scriptRoleLabel(assets[1], ctx)).toBeNull()
  })
})

describe('the import graph', () => {
  it('computes the transitive closure a build must ship', () => {
    const { ctx } = library()
    const { modules, missing } = importClosure([{ source: HOLLOW, path: '/Enemies/Hollow' }], ctx)
    expect([...modules.keys()]).toEqual(['/Shared/EnemyBase', '/Shared/Math'])
    expect(missing).toEqual([])
    expect(importClosure([{ source: `import { x } from '@/Gone'
export const y = x` }], ctx).missing).toEqual(['/Gone'])
  })

  it('finds every script that depends on a changed one', () => {
    const { assets, ctx } = library()
    expect(dependentsOf('math', assets, ctx).map(a => a.id).sort()).toEqual(['base', 'hollow'])
    expect(dependentsOf('hollow', assets, ctx)).toEqual([])
  })
})

describe('game data', () => {
  function json() {
    return {
      scene: {
        id: 'root', children: [
          { id: 'n1', script: HOLLOW, variables: { __scriptId: { value: 'hollow' } }, children: [] },
          { id: 'n2', script: `this.onUpdate = () => {}`, children: [] },
        ],
      },
      templates: [{ id: 't', name: 'Knight', node: { id: 'k1', script: KNIGHT, variables: { __scriptId: { value: 'knight' } }, children: [] } }],
    } as any
  }

  it('stamps script paths and ships exactly the imported modules', () => {
    const { assets, paths } = library()
    const data = json()
    attachScriptModules(data, assets, paths)
    expect(data.scene.children[0].scriptPath).toBe('/Enemies/Hollow')
    expect(data.scene.children[1].scriptPath).toBeUndefined()
    expect(data.templates[0].node.scriptPath).toBe('/Enemies/Knight')
    expect(Object.keys(data.modules).sort()).toEqual(['/Shared/EnemyBase', '/Shared/Math', '/Shared/Named'])
  })

  it('publishes modules as precompiled factories and strips the authoring fields', () => {
    const { assets, paths } = library()
    const data = json()
    attachScriptModules(data, assets, paths)
    const { scripts, paths: scriptPaths, modules } = extractScripts(data)
    expect(data.modules).toBeUndefined()
    expect(data.scene.children[0].scriptPath).toBeUndefined()
    expect(scriptPaths.n1).toBe('/Enemies/Hollow')

    const source = buildScriptsSource(scripts, scriptPaths, modules)
    expect(source).toContain('window.CLEO_GAME_MODULES["/Shared/Math"]')
    expect(source).not.toContain('skipped')
    // The Knight's relative import is already canonical in the emitted code.
    expect(source).toContain('__cleoImport("/Shared/Named")')
    const w: any = {}
    // eslint-disable-next-line no-new-func
    new Function('window', source)(w)
    expect(typeof w.CLEO_GAME_MODULES['/Shared/EnemyBase']).toBe('function')
    expect(typeof w.CLEO_GAME_SCRIPTS.k1).toBe('function')
  })
})

describe('the VS Code workspace', () => {
  it('maps @/ to the workspace root, with no baseUrl to make bare paths resolve', () => {
    const tsconfig = staticScaffold().find(f => f.rel === 'tsconfig.json')!.content
    expect(tsconfig).toContain('"paths": { "@/*": ["./*"] }')
    expect(tsconfig).not.toMatch(/"baseUrl"\s*:/)
    expect(tsconfig).toContain('**/*.test.ts')
  })
})
