// The strip above every code surface: the theme picker plus a note about keys that behave unusually inside
// a code editor. The picker writes to the shared store, so it switches every code editor on screen.
import React from 'react';
import { SegmentedControl } from '../../../components/ui';
import { codeThemeStore, useCodeTheme, type CodeThemeName } from './codeThemeStore';

const THEME_OPTIONS: { value: CodeThemeName; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

export default function CodeEditorHeader(props: { title?: string; right?: React.ReactNode }) {
  const theme = useCodeTheme();

  return (
    <div className='flex items-center gap-2 px-2 py-1 bg-surface-sunken border-b border-border-subtle'>
      {props.title && <span className='text-[11px] font-semibold text-muted'>{props.title}</span>}
      <span className='text-[10px] text-dim'>Ctrl+Space for suggestions</span>
      <span className='flex-1' />
      {props.right}
      <SegmentedControl<CodeThemeName>
        options={THEME_OPTIONS}
        value={theme}
        onChange={codeThemeStore.set}
        size='sm'
      />
    </div>
  );
}
