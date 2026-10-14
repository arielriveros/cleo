import React from 'react';
import { cn } from './cn';
import { buttonVariants, type ButtonProps } from './Button';

export interface FileButtonProps {
  /** Called with the chosen files; the input is reset afterwards so picking the same file again fires. */
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  /** Pick a folder (Chromium/Electron `webkitdirectory`). */
  directory?: boolean;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  disabled?: boolean;
  title?: string;
  className?: string;
  id?: string;
  children: React.ReactNode;
}

/**
 * A button that opens the file picker. A `<label>` wrapping a hidden `<input type=file>`, because that is
 * the only way to open one without a script-driven click — styled exactly like {@link Button} so a
 * "choose file" action no longer looks like a different control from the buttons beside it.
 */
export function FileButton({ onFiles, accept, multiple, directory, variant = 'default', size = 'sm', disabled, title, className, id, children }: FileButtonProps) {
  const dirProps = directory ? ({ webkitdirectory: '', directory: '' } as Record<string, string>) : {};
  return (
    <label
      title={title}
      className={cn(buttonVariants({ variant, size }), 'cursor-pointer', disabled && 'pointer-events-none opacity-60', className)}
    >
      {children}
      <input
        id={id}
        type='file'
        className='hidden'
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        {...dirProps}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </label>
  );
}

export default FileButton;
