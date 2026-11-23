// Shared app chrome. In standalone iOS there is NO browser chrome — no back
// button, no title, no URL bar — so the app has to supply all of it, and has to
// respect the notch and home indicator itself.

import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { Link } from 'wouter';
import { ChevronLeft } from 'lucide-react';
import { buttonClass } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/** Full-height column: fixed header, scrolling body. `data-screen` is what the Settings
 *  layout readout measures. */
export function Screen({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-screen className={cn('flex h-[100dvh] flex-col overflow-hidden', className)}>
      {children}
    </div>
  );
}

export function Header({
  title,
  back,
  right,
}: {
  title: ReactNode;
  /** Path to go back to. Omit on the root screen. */
  back?: string;
  right?: ReactNode;
}) {
  return (
    <header className="pt-safe bg-background/80 border-border sticky top-0 z-10 shrink-0 border-b backdrop-blur-xl">
      <div className="mx-auto flex h-14 w-full max-w-3xl items-center gap-1 px-2">
        {back ? (
          <Link
            href={back}
            aria-label="Back"
            className={buttonClass({ variant: 'ghost', size: 'icon', className: '-ml-1 text-primary' })}>
            <ChevronLeft className="size-6" />
          </Link>
        ) : (
          <div className="w-2" />
        )}
        <div className="min-w-0 flex-1 truncate text-[1.0625rem] font-bold">{title}</div>
        {right ? <div className="flex shrink-0 items-center gap-1">{right}</div> : null}
      </div>
    </header>
  );
}

/**
 * Scrolling body with the max-width column and bottom padding.
 * Ref-forwarding because the session view needs the scroll element itself to
 * decide whether to follow the stream.
 */
export const Body = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(function Body(
  { children, className, ...props },
  ref
) {
  return (
    <main
      ref={ref}
      className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', className)}
      {...props}>
      <div className="mx-auto w-full max-w-3xl px-3 pb-6">{children}</div>
    </main>
  );
});

/** Centered empty/error state. */
export function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
      {children}
    </div>
  );
}
