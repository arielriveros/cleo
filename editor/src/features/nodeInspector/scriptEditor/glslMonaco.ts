import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api'

// Registers a lightweight GLSL language for Monaco (syntax highlighting + bracket/comment behaviour). GLSL
// is not one of Monaco's built-in languages, but it is C-like enough that a small Monarch tokenizer covers
// fragment-shader source well. No language worker is involved (Monarch tokenizes on the main thread), so
// this needs no monaco-editor-webpack-plugin entry. Registered once from ensureMonaco().

let registered = false

const KEYWORDS = [
  'attribute', 'const', 'uniform', 'varying', 'buffer', 'shared', 'coherent', 'volatile', 'restrict',
  'readonly', 'writeonly', 'layout', 'centroid', 'flat', 'smooth', 'noperspective', 'patch', 'sample',
  'break', 'continue', 'do', 'for', 'while', 'switch', 'case', 'default', 'if', 'else', 'return', 'discard',
  'in', 'out', 'inout', 'precision', 'highp', 'mediump', 'lowp', 'struct', 'void', 'true', 'false',
  'invariant', 'precise', 'subroutine',
]

const TYPES = [
  'float', 'double', 'int', 'uint', 'bool',
  'vec2', 'vec3', 'vec4', 'dvec2', 'dvec3', 'dvec4', 'bvec2', 'bvec3', 'bvec4', 'ivec2', 'ivec3', 'ivec4',
  'uvec2', 'uvec3', 'uvec4',
  'mat2', 'mat3', 'mat4', 'mat2x2', 'mat2x3', 'mat2x4', 'mat3x2', 'mat3x3', 'mat3x4', 'mat4x2', 'mat4x3', 'mat4x4',
  'sampler2D', 'sampler3D', 'samplerCube', 'sampler2DArray', 'sampler2DShadow', 'samplerCubeShadow',
  'isampler2D', 'usampler2D',
]

export function registerGlsl(monaco: typeof Monaco): void {
  if (registered) return
  registered = true

  monaco.languages.register({ id: 'glsl' })

  monaco.languages.setLanguageConfiguration('glsl', {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
      { open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' },
      { open: '/*', close: '*/' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' },
    ],
  })

  monaco.languages.setMonarchTokensProvider('glsl', {
    keywords: KEYWORDS,
    typeKeywords: TYPES,
    operators: [
      '=', '>', '<', '!', '~', '?', ':', '==', '<=', '>=', '!=', '&&', '||', '++', '--',
      '+', '-', '*', '/', '&', '|', '^', '%', '<<', '>>', '+=', '-=', '*=', '/=', '&=', '|=', '^=', '%=',
    ],
    symbols: /[=><!~?:&|+\-*/^%]+/,
    tokenizer: {
      root: [
        // preprocessor
        [/^\s*#\w+/, 'keyword.directive'],
        // gl_ / built-in globals
        [/gl_\w+/, 'variable.predefined'],
        [/[a-zA-Z_]\w*/, {
          cases: {
            '@typeKeywords': 'type',
            '@keywords': 'keyword',
            '@default': 'identifier',
          },
        }],
        { include: '@whitespace' },
        [/[{}()[\]]/, '@brackets'],
        [/@symbols/, { cases: { '@operators': 'operator', '@default': '' } }],
        [/\d*\.\d+([eE][-+]?\d+)?[fF]?/, 'number.float'],
        [/\d+[uU]?/, 'number'],
        [/[;,.]/, 'delimiter'],
        [/"([^"\\]|\\.)*$/, 'string.invalid'],
        [/"/, 'string', '@string'],
      ],
      whitespace: [
        [/[ \t\r\n]+/, ''],
        [/\/\*/, 'comment', '@comment'],
        [/\/\/.*$/, 'comment'],
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],
      string: [
        [/[^"\\]+/, 'string'],
        [/\\./, 'string.escape'],
        [/"/, 'string', '@pop'],
      ],
    },
  } as Monaco.languages.IMonarchLanguage)
}
