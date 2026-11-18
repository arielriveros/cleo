// Monaco ships its monarch grammars as plain JS. monacoSetup.ts imports the TypeScript one to extend it (the
// decorator rule), so this says what that module exports.
declare module 'monaco-editor/esm/vs/basic-languages/typescript/typescript.js' {
  import type { languages } from 'monaco-editor/esm/vs/editor/editor.api';
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage & { tokenizer: Record<string, languages.IMonarchLanguageRule[]> };
}
