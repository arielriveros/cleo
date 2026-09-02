import React, { useState } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded border font-medium transition-colors focus-visible:outline-none disabled:opacity-60 disabled:cursor-not-allowed',
  {
    variants: {
      variant: {
        default: 'bg-control border-border text-white hover:bg-control-hover',
        primary: 'bg-primary border-primary-active text-white hover:bg-primary-hover',
        danger: 'bg-danger border-danger text-white hover:bg-danger-hover',
        success: 'bg-success border-success text-white hover:bg-success-hover',
        ghost: 'bg-transparent border-transparent text-muted hover:text-white hover:bg-control',
        subtle: 'bg-surface-raised border-border text-white hover:bg-control',
      },
      size: {
        sm: 'px-2 py-0.5 text-xs',
        md: 'px-3 py-1 text-sm',
        lg: 'px-4 py-2 text-base',
        icon: 'p-1.5',
      },
      active: { true: '', false: '' },
    },
    compoundVariants: [
      { variant: 'default', active: true, class: 'bg-selected border-white hover:bg-selected' },
      { variant: 'subtle', active: true, class: 'bg-selected border-white text-white' },
      { variant: 'ghost', active: true, class: 'bg-control text-white' },
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
}

/** Destructive action that requires a second click. First click reveals Cancel / Confirm. */
export function ButtonWithConfirm({ onClick, children, className, disabled }: ButtonWithConfirmProps) {
  const [clicked, setClicked] = useState(false);
  if (!clicked || disabled) {
    return (
      <Button variant='danger' className={className} disabled={disabled} onClick={() => setClicked(true)}>
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
