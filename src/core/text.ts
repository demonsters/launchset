/** Small text helpers: line endings, line numbers, line starts and indentation. Pure. */

/** The line ending a text uses (`\r\n` when it has any), for anything inserted into it. */
export function detectEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** 1-based line number of a character offset. */
export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** Start offset of the line containing `offset`. */
export function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

/** Offset just after the newline ending the line that contains `offset` (or the text end). */
export function lineEnd(text: string, offset: number): number {
  const index = text.indexOf("\n", offset);
  return index === -1 ? text.length : index + 1;
}

/** Leading whitespace (spaces and tabs) of the line containing `offset`. */
export function indentAt(text: string, offset: number): string {
  return /^[ \t]*/.exec(text.slice(lineStart(text, offset)))?.[0] ?? "";
}
