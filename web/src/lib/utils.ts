import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Format duration in milliseconds to a human-readable string.
 * Examples: 720ms, 1.2s, 13.6s
 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms === null) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
