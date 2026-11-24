---
bump: patch
---

`regex` file stamps now work on files with Windows (CRLF) line endings, such as a Windows runner's checkout with `core.autocrlf=true`. A `\n` in `pattern` matches LF and CRLF line endings alike, the stamped file keeps its line endings, and `$1`-style references copy the file's text byte for byte. Patterns that already use `\r?\n` or `\r\n` work as before. When a pattern matches nothing in a file with `\r` characters, the error now says what line endings the file has.
