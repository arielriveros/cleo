// A small syntax highlighter for the docs' code blocks. The docs only fence `ts` (about 260 blocks)
// and `glsl` (5); a full grammar would be wasted, and Monaco's colorizer needs Monaco loaded and themed.
// One pass of a combined regex: comments, strings, numbers, then words classified by language.

export type CodeTokenKind = 'keyword' | 'string' | 'number' | 'comment' | 'type' | 'function' | 'decorator' | 'plain';

export interface CodeToken {
  kind: CodeTokenKind;
  text: string;
}

const TS_KEYWORDS = new Set([
  'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'is', 'keyof',
  'let', 'namespace', 'new', 'null', 'of', 'private', 'protected', 'public', 'readonly', 'return', 'set',
  'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'var',
  'void', 'while', 'yield',
]);
const TS_TYPES = new Set(['string', 'number', 'boolean', 'any', 'unknown', 'never', 'object', 'symbol', 'bigint']);

const GLSL_KEYWORDS = new Set([
  'attribute', 'break', 'const', 'continue', 'discard', 'do', 'else', 'false', 'flat', 'for', 'highp',
  'if', 'in', 'inout', 'layout', 'lowp', 'mediump', 'out', 'precision', 'return', 'smooth', 'struct',
  'switch', 'case', 'default', 'true', 'uniform', 'varying', 'while', 'fn', 'let', 'var',
]);
const GLSL_TYPES = new Set([
  'void', 'bool', 'int', 'uint', 'float', 'double', 'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4',
  'uvec2', 'uvec3', 'uvec4', 'bvec2', 'bvec3', 'bvec4', 'mat2', 'mat3', 'mat4', 'sampler2D', 'samplerCube',
  'sampler2DShadow', 'sampler3D', 'f32', 'i32', 'u32', 'vec2f', 'vec3f', 'vec4f', 'mat4x4f',
]);

interface Grammar { keywords: Set<string>; types: Set<string>; strings: boolean; decorators: boolean }

const GRAMMARS: Record<string, Grammar> = {
  ts: { keywords: TS_KEYWORDS, types: TS_TYPES, strings: true, decorators: true },
  glsl: { keywords: GLSL_KEYWORDS, types: GLSL_TYPES, strings: false, decorators: false },
};
const ALIASES: Record<string, string> = {
  ts: 'ts', typescript: 'ts', js: 'ts', javascript: 'ts', tsx: 'ts', jsx: 'ts', json: 'ts',
  glsl: 'glsl', wgsl: 'glsl', hlsl: 'glsl',
};

/** Whether a fence's language tag is one this highlights. */
export function highlightable(lang: string | undefined): boolean {
  return !!lang && (lang.toLowerCase() in ALIASES);
}

const TOKEN = new RegExp([
  String.raw`(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))`,                        // 1 comment
  String.raw`('(?:\\.|[^'\\\n])*'?|"(?:\\.|[^"\\\n])*"?|\x60(?:\\.|[^\x60\\])*\x60?)`, // 2 string
  String.raw`(\b(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[fun]?)\b)`,    // 3 number
  String.raw`(@[A-Za-z_$][\w$]*)`,                                            // 4 decorator
  String.raw`([A-Za-z_$][\w$]*)`,                                             // 5 word
].join('|'), 'g');

/** Split `code` into highlighted runs; an unknown language comes back as one plain run. */
export function highlight(code: string, lang: string | undefined): CodeToken[] {
  const grammar = lang ? GRAMMARS[ALIASES[lang.toLowerCase()] ?? ''] : undefined;
  if (!grammar) return [{ kind: 'plain', text: code }];

  const out: CodeToken[] = [];
  const push = (kind: CodeTokenKind, text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };

  let at = 0;
  for (const m of code.matchAll(TOKEN)) {
    const start = m.index!;
    if (start > at) push('plain', code.slice(at, start));
    const [whole, comment, str, num, decorator, word] = m;
    if (comment) push('comment', whole);
    else if (str) push(grammar.strings || !str.startsWith("'") ? 'string' : 'plain', whole);
    else if (num) push('number', whole);
    // `@attribute`, `@onAction`: the script editor's decorator colour. Strings and comments matched first.
    else if (decorator) push(grammar.decorators ? 'decorator' : 'plain', whole);
    else if (word) {
      const next = code.slice(start + whole.length).match(/^\s*(\(|<[A-Za-z])/);
      if (grammar.keywords.has(word)) push('keyword', whole);
      else if (grammar.types.has(word) || /^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/.test(word)) push('type', whole);
      else if (next) push('function', whole);
      else push('plain', whole);
    }
    at = start + whole.length;
  }
  if (at < code.length) push('plain', code.slice(at));
  return out;
}
