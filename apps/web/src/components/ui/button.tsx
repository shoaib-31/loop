// shadcn-style Button, hand-rolled to keep the dependency count honest: variants
// are a lookup object rather than class-variance-authority, since there are only
// four of them and cva would be a package for a Record.
//
// `buttonClass()` is exported separately (shadcn's `buttonVariants` pattern) so a
// router <Link> can look like a button without nesting a <button> inside an <a>,
// which is invalid HTML and breaks keyboard activation.
//
// Touch targets are min-h-11 (44px) — Apple's minimum. This is answered one-handed
// on a phone at speed, so anything smaller costs mis-taps.

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'icon';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-primary text-primary-foreground hover:opacity-90 active:opacity-80',
  secondary: 'bg-muted text-foreground hover:bg-muted/80 active:bg-muted/70',
  ghost: 'bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground',
  danger: 'bg-danger/15 text-danger hover:bg-danger/25',
};

const SIZES: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm rounded-lg',
  md: 'min-h-11 px-4 text-[0.9375rem] rounded-xl',
  icon: 'h-10 w-10 rounded-full',
};

export function buttonClass({
  variant = 'primary',
  size = 'md',
  className,
}: { variant?: Variant; size?: Size; className?: string } = {}) {
  return cn(
    'inline-flex items-center justify-center gap-2 font-semibold transition select-none',
    'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
    'disabled:pointer-events-none disabled:opacity-45',
    VARIANTS[variant],
    SIZES[size],
    className
  );
}

export function Button({
  variant,
  size,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  children?: ReactNode;
}) {
  return (
    <button className={buttonClass({ variant, size, className })} {...props}>
      {children}
    </button>
  );
}
