import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('bg-card rounded-card p-4', className)} {...props} />;
}

/** Small uppercase section label, e.g. "NOTIFICATIONS". */
export function SectionLabel({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn(
        'text-muted-foreground px-1 text-xs font-bold tracking-wider uppercase',
        className
      )}
      {...props}
    />
  );
}
