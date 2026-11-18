/** Escape a string for use inside a regular expression (also `/`, for patterns in messages). */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
