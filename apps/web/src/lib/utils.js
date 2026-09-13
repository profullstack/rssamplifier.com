import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names the shadcn/ui way: clsx for the conditionals, then
 * tailwind-merge so a later utility replaces an earlier one of the same kind
 * (`px-6` then `px-5` is `px-5`, not both).
 *
 * @param {...import('clsx').ClassValue} inputs
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
