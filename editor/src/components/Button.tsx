// Backwards-compatibility shim. The Button implementation now lives in the ui/ library.
export { Button as default, Button, ButtonWithConfirm, buttonVariants } from './ui/Button';
export type { ButtonProps, ButtonWithConfirmProps } from './ui/Button';
