// The shadcn className helper: clsx for conditionals, tailwind-merge so a later
// class wins over an earlier conflicting one (e.g. a caller's `px-4` overrides a
// component's default `px-3` instead of both landing in the class list).

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
