import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// The editor's custom type scale (tailwind.config.js `fontSize`) declared to tailwind-merge. Without it
// `text-ui-sm` is an unknown `text-*` class, which it treats as a text COLOUR: `cn('text-ui-sm',
// 'text-muted')` would keep only the colour and lose the size.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: ['ui-2xs', 'ui-xs', 'ui-sm', 'ui', 'ui-lg'] }] } },
});

/**
 * Merge conditional class names and de-duplicate conflicting Tailwind utilities.
 * `cn('px-2', condition && 'px-4')` → the later `px-4` wins.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
