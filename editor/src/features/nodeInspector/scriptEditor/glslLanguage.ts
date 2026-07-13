// GLSL support for the custom-material editor.
//
// GLSL is C with a graphics vocabulary, so it parses under the official C/C++ Lezer grammar. That buys a
// real syntax tree — which is what bracketMatching, foldGutter and the smart C indentation behind
// indentOnInput and Tab all consume — where a stream-based mode would give none of them.
//
// The cost is vocabulary: `vec3`, `uniform`, `in`/`out`/`inout` and friends are not C, so they highlight as
// plain identifiers, and a line like `in vec3 v;` makes the grammar recover an error node. Two things keep
// that from mattering: the theme styles `t.invalid` with a color and no squiggle (see codeMirrorTheme.ts),
// so the recovery is invisible, and the completion source below puts the GLSL vocabulary back.
//
// Everything GLSL-specific sits behind glsl(), so swapping in a true GLSL grammar later is a one-line
// change here.
import { cpp, cppLanguage } from '@codemirror/lang-cpp';
import { type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';

const TYPES = [
  'void', 'bool', 'int', 'uint', 'float', 'double',
  'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4', 'bvec2', 'bvec3', 'bvec4', 'uvec2', 'uvec3', 'uvec4',
  'mat2', 'mat3', 'mat4', 'mat2x2', 'mat2x3', 'mat2x4', 'mat3x2', 'mat3x3', 'mat3x4', 'mat4x2', 'mat4x3', 'mat4x4',
  'sampler2D', 'sampler3D', 'samplerCube', 'sampler2DShadow', 'sampler2DArray', 'isampler2D', 'usampler2D',
  'struct',
];

const KEYWORDS = [
  'attribute', 'const', 'uniform', 'varying', 'buffer', 'shared', 'layout', 'centroid', 'flat', 'smooth',
  'noperspective', 'patch', 'sample', 'in', 'out', 'inout', 'invariant', 'precision', 'highp', 'mediump',
  'lowp', 'discard', 'return', 'break', 'continue', 'if', 'else', 'switch', 'case', 'default', 'for',
  'while', 'do', 'true', 'false',
];

const BUILTIN_FUNCTIONS = [
  'abs', 'sign', 'floor', 'ceil', 'round', 'trunc', 'fract', 'mod', 'min', 'max', 'clamp', 'mix', 'step',
  'smoothstep', 'sqrt', 'inversesqrt', 'pow', 'exp', 'exp2', 'log', 'log2', 'sin', 'cos', 'tan', 'asin',
  'acos', 'atan', 'sinh', 'cosh', 'tanh', 'radians', 'degrees',
  'length', 'distance', 'dot', 'cross', 'normalize', 'faceforward', 'reflect', 'refract',
  'transpose', 'inverse', 'determinant', 'matrixCompMult',
  'texture', 'texture2D', 'textureLod', 'textureCube', 'texelFetch', 'textureSize',
  'dFdx', 'dFdy', 'fwidth',
  'lessThan', 'greaterThan', 'equal', 'notEqual', 'any', 'all', 'not', 'isnan', 'isinf',
];

const BUILTIN_VARIABLES = [
  'gl_Position', 'gl_FragColor', 'gl_FragCoord', 'gl_FragDepth', 'gl_PointSize', 'gl_PointCoord',
  'gl_FrontFacing', 'gl_VertexID', 'gl_InstanceID', 'gl_FragData',
];

const OPTIONS: Completion[] = [
  ...TYPES.map((label) => ({ label, type: 'type', boost: 1 })),
  ...KEYWORDS.map((label) => ({ label, type: 'keyword' })),
  ...BUILTIN_FUNCTIONS.map((label) => ({ label, type: 'function', detail: 'built-in' })),
  ...BUILTIN_VARIABLES.map((label) => ({ label, type: 'variable', detail: 'built-in' })),
];

function glslCompletions(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/[\w_]+/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  return { from: word.from, options: OPTIONS, validFor: /^[\w_]*$/ };
}

/** C/C++ grammar plus the GLSL vocabulary the C grammar does not know about. */
export function glsl(): Extension {
  return [cpp(), cppLanguage.data.of({ autocomplete: glslCompletions })];
}
