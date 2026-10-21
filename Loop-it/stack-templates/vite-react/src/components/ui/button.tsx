import { clsx } from 'clsx';
import type { ButtonHTMLAttributes } from 'react';

/** Minimal shadcn-style button primitive. Extend rather than invent new ones. */
export function Button({
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      className={clsx(
        'inline-flex items-center justify-center rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white',
        'hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500',
        'disabled:pointer-events-none disabled:opacity-50',
        'dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white',
        className,
      )}
      {...props}
    />
  );
}
