// One place to compose the CodeMirror extensions, so the script editor and the GLSL editor cannot drift
// apart. Both build their state through codeSetup(); anything editor-wide (theming, key handling) belongs
// here rather than in either component.
import { basicSetup } from 'codemirror';
import { indentWithTab } from '@codemirror/commands';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { getCodeTheme, type CodeThemeName } from './codeMirrorTheme';

/**
 * Read-only has to flip `EditorView.editable` as well as `EditorState.readOnly`: the content is a
 * contentEditable element, which a wrapping `<fieldset disabled>` does not stop.
 */
export function readOnlyExtension(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

/**
 * Tab indents instead of moving focus to the next control, and Escape releases the editor.
 *
 * basicSetup deliberately leaves `indentWithTab` out, because binding Tab makes the editor a keyboard
 * trap. Escape-to-blur is the standard remedy, and the ordering gives it to us for free: this keymap is
 * registered *after* basicSetup, whose completionKeymap already binds Escape to closeCompletion. That
 * returns false when no completion popup is open, so the blur below only runs when there is nothing to
 * dismiss. Net effect: Escape closes the autocomplete popup and keeps focus; Escape then Tab leaves the
 * editor entirely.
 */
export const editorKeymap: Extension = keymap.of([
  indentWithTab,
  { key: 'Escape', run: (view) => { view.contentDOM.blur(); return true; } },
]);

export interface CodeSetupOptions {
  /** The language support, plus any completion sources it carries. Omit for plain text. */
  language?: Extension;
  themeCompartment: Compartment;
  readOnlyCompartment: Compartment;
  /** Diagnostics. Lives in a compartment because the script linter depends on the selected node's
   *  variables, which change without the document changing (and lint only re-runs on doc changes). */
  lintCompartment?: Compartment;
  initialLint?: Extension;
  initialTheme: CodeThemeName;
  initialReadOnly: boolean;
  onDocChange: (doc: string) => void;
}

/**
 * The full extension list, in precedence order (earlier wins). The theme, read-only state and linter live
 * in compartments so they can be reconfigured on a live view — never recreate the EditorView to apply
 * them, which would drop the undo history.
 */
export function codeSetup(opts: CodeSetupOptions): Extension[] {
  return [
    basicSetup,
    ...(opts.language ? [opts.language] : []),
    opts.themeCompartment.of(getCodeTheme(opts.initialTheme)),
    opts.readOnlyCompartment.of(readOnlyExtension(opts.initialReadOnly)),
    ...(opts.lintCompartment ? [opts.lintCompartment.of(opts.initialLint ?? [])] : []),
    editorKeymap,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) opts.onDocChange(update.state.doc.toString());
    }),
  ];
}
