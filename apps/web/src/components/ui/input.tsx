// Text inputs. `text-base` (16px) is not a style choice: iOS Safari zooms the
// whole page when you focus an input smaller than 16px, which on a standalone PWA
// leaves the layout stranded mid-zoom. Never drop these below text-base.

import type { ComponentProps, InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

const BASE =
  'bg-card text-foreground placeholder:text-muted-foreground/70 w-full rounded-xl px-3.5 py-3 text-base ' +
  'focus-visible:ring-primary/50 focus-visible:ring-2 focus-visible:outline-none ' +
  'disabled:opacity-50';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(BASE, className)} {...props} />;
}

// ComponentProps, not TextareaHTMLAttributes: it carries `ref` (a plain prop in React 19),
// which the session screen needs to put the cursor here after a decline.
export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(BASE, 'resize-none', className)} {...props} />;
}
