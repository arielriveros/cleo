import React, { useState } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded border font-medium transition-colors focus-visible:outline-none disabled:opacity-60 disabled:cursor-not-allowed',
  {
    variants: {
      variant: {
        default: 'bg-control border-border text-fg hover:bg-control-hover',
        primary: 'bg-primary border-primary-active text-fg hover:bg-primary-hover',
        danger: 'bg-danger border-danger text-fg hover:bg-danger-hover',
        success: 'bg-success border-success text-fg hover:bg-success-hover',
        ghost: 'bg-transparent border-transparent text-muted hover:text-fg hover:bg-control',
        /** Caution actions on a warning banner ("Reload"). */
        warning: 'bg-warning border-warning text-bg hover:brightness-110',
        /**
         * The row-level ✕ that removes an item from a list (a parameter, a sample, a binding, an unlink).
         * Quiet until hovered, then the danger colour: a column of solid red blocks down a list shouted
         * louder than anything else on the panel. Solid `danger` is for LABELLED destructive actions.
         */
        remove: 'bg-transparent border-transparent text-dim hover:text-danger-fg hover:bg-danger/15',
        /** An inline text action that should read as a link, not a button ("Revert all"). */
        link: 'bg-transparent border-transparent px-0 text-highlight underline-offset-2 hover:underline',
        subtle: 'bg-surface-raised border-border text-fg hover:bg-control',
      },
      size: {
        sm: 'px-2 py-0.5 text-ui',
        md: 'px-3 py-1 text-ui',
        lg: 'px-4 py-2 text-ui-lg',
        icon: 'p-1.5',
      },
      active: { true: '', false: '' },
    },
    compoundVariants: [
      { variant: 'default', active: true, class: 'bg-selected border-fg hover:bg-selected' },
      { variant: 'subtle', active: true, class: 'bg-selected border-fg text-fg' },
      { variant: 'ghost', active: true, class: 'bg-control text-fg' },
    ],
    defaultVariants: { variant: 'default', size: 'md' },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

/** Ref-forwarding so a host can focus it — DialogHost focuses the confirm button when a dialog opens. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, active, type = 'button', ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size, active }), className)}
      {...props}
    />
  );
});

export default Button;

export interface ButtonWithConfirmProps {
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  /** The first-click button's look: `danger` for a labelled action, `remove` for a list row's ✕. */
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  title?: string;
}

/** Destructive action that requires a second click. First click reveals Cancel / Confirm. */
export function ButtonWithConfirm({ onClick, children, className, disabled, variant = 'danger', size, title }: ButtonWithConfirmProps) {
  const [clicked, setClicked] = useState(false);
  if (!clicked || disabled) {
    return (
      <Button variant={variant} size={size} title={title} className={className} disabled={disabled} onClick={() => setClicked(true)}>
        {children}
      </Button>
    );
  }
  return (
    <div className='inline-flex items-center gap-2'>
      <Button onClick={() => setClicked(false)}>Cancel</Button>
      <Button variant='danger' onClick={() => { setClicked(false); onClick(); }}>Confirm</Button>
    </div>
  );
}
