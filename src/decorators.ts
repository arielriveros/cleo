// What a script imports as 'cleo/decorators': the decorators for its fields and methods.
//
//   import { attribute, child, onAction, save } from 'cleo/decorators'
//
// A module of their own rather than part of the 'cleo' barrel, so their short names (`find`, `save`, `pick`,
// `every`, …) are not among the engine's eight hundred, and the script editors can list exactly these after
// an `@`. The barrel keeps the machinery the compile and the editor use (applyScriptDecorators,
// membersOfNode, …). cleoCore.ts registers this namespace for scripts, beside 'cleo'.
//
// A top-level file on purpose: dist then has decorators.d.ts beside cleo.d.ts, so 'cleo/decorators' resolves
// by plain node resolution in Monaco and in the VS Code script workspace, and the engine's `cleo/*` alias
// (vite.config.ts) finds it for the tests.
export { child, find, onAction, onHold, onTap, onEnter, onExit, onEvent, every, attribute, save, options, pick } from "./core/scripting/decorators";
export type { ActionWhen, AttributeOptions, AttributeDecorator, FieldDecorator, MethodDecorator } from "./core/scripting/decorators";
