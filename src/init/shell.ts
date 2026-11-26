/**
 * A small shell reader for init's machinery detection: the simple commands a script runs.
 *
 * Init decides what a workflow step, a `package.json` script or a script file does by matching
 * commands. Matching raw text can't tell running a command from mentioning it, so this reader
 * drops what is only data before anything is matched:
 * - comments (`pnpm build  # was: npx semantic-release`);
 * - quoted arguments: a quoted string stays one word, so `grep 'git tag -a' f` or
 *   `gh pr comment --body "run npm version patch"` never look like `git tag` or `npm version`;
 * - heredoc bodies;
 * - and so everything `echo`, `printf`, `logger` or `tee` print.
 * A `$(…)` or backticks run a command, also inside double quotes: those are read as commands of
 * their own. Leading keywords (`if`, `then`, `do`, `!`), variable assignments, wrappers (`sudo`,
 * `env`, `time`) and package runners (`npx`, `pnpm dlx`, `bun x`, `corepack`) are dropped, so
 * every pattern can match at the start of a command. So are `xcrun` and `bundle exec`.
 */

/** Stands in for whitespace inside a quoted argument, so the argument stays one word. */
export const QUOTED_SPACE = "␣";

export interface SimpleCommand {
  /** Its words, quotes removed (whitespace inside a quoted word is {@link QUOTED_SPACE}). */
  words: string[];
  /** The words joined by spaces, the command's path reduced to its name (`/usr/bin/x` → `x`). */
  text: string;
}

/** The index of the `)` that closes the `(` at `open`, or the end of `s`. */
function closing(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      i++;
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      i = end < 0 ? s.length : end;
    } else if (c === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === "\\") i++;
    } else if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return s.length;
}

const quoted = (body: string) => body.replace(/\s/g, QUOTED_SPACE);

/** Split `script` into raw simple commands (text), commands in substitutions included. */
function scan(s: string, out: string[]): void {
  let cur = "";
  /** Inside a word: a `#` here isn't a comment. */
  let word = false;
  const heredocs: string[] = [];
  const flush = () => {
    if (cur.trim() !== "") out.push(cur.trim());
    cur = "";
    word = false;
  };
  const substitution = (start: number, end: number) => {
    scan(s.slice(start, end), out);
    cur += "X";
    word = true;
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    const next = s[i + 1];
    if (c === "\\") {
      if (next === "\n" || (next === "\r" && s[i + 2] === "\n")) {
        cur += " ";
        word = false;
        i += next === "\r" ? 3 : 2;
      } else {
        cur += next ?? "";
        word = true;
        i += 2;
      }
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      cur += quoted(end < 0 ? s.slice(i + 1) : s.slice(i + 1, end));
      word = true;
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let body = "";
      while (j < s.length && s[j] !== '"') {
        if (s[j] === "\\") {
          body += s[j + 1] ?? "";
          j += 2;
        } else if (s[j] === "$" && s[j + 1] === "(" && s[j + 2] !== "(") {
          const end = closing(s, j + 1);
          scan(s.slice(j + 2, end), out);
          body += "X";
          j = end + 1;
        } else if (s[j] === "`") {
          const end = s.indexOf("`", j + 1);
          scan(s.slice(j + 1, end < 0 ? s.length : end), out);
          body += "X";
          j = end < 0 ? s.length : end + 1;
        } else {
          body += s[j];
          j++;
        }
      }
      cur += quoted(body);
      word = true;
      i = j + 1;
      continue;
    }
    if (c === "$" && next === "(") {
      const end = closing(s, i + 1);
      if (s[i + 2] === "(") {
        // Arithmetic: no command.
        cur += "X";
        word = true;
      } else {
        substitution(i + 2, end);
      }
      i = end + 1;
      continue;
    }
    if (c === "`") {
      const end = s.indexOf("`", i + 1);
      substitution(i + 1, end < 0 ? s.length : end);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (c === "#" && !word) {
      const nl = s.indexOf("\n", i);
      i = nl < 0 ? s.length : nl;
      continue;
    }
    if (c === "\n") {
      flush();
      i++;
      // Heredoc bodies are data.
      while (heredocs.length > 0 && i < s.length) {
        const nl = s.indexOf("\n", i);
        const line = s.slice(i, nl < 0 ? s.length : nl).trim();
        i = nl < 0 ? s.length : nl + 1;
        if (line === heredocs[0]) heredocs.shift();
      }
      continue;
    }
    if (c === "<" && next === "<" && s[i + 2] !== "<") {
      const m = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(s.slice(i));
      if (m) {
        heredocs.push(m[2] as string);
        cur += ` <<${m[2]} `;
        word = false;
        i += m[0].length;
        continue;
      }
    }
    if (c === "&") {
      // `>&2`, `&>file`, `2>&1`: redirections, not separators.
      if (s[i - 1] === ">" || s[i - 1] === "<" || next === ">") {
        cur += c;
        word = true;
        i++;
        continue;
      }
      flush();
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "(" || c === ")") {
      flush();
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      cur += " ";
      word = false;
      i++;
      continue;
    }
    cur += c;
    word = true;
    i++;
  }
  flush();
}

/** Words that start a compound command or modify the command after them. */
const LEADING = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "!",
  "{",
  "}",
  "time",
  "exec",
  "command",
  "builtin",
  "nohup",
  "xcrun",
]);
/** Tools whose release commands `pnpm <tool>` / `yarn <tool>` run from node_modules/.bin. */
const RELEASE_BINS =
  /^(?:changeset|semantic-release|release-it|standard-version|release-please|commit-and-tag-version)$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

/** Drop keywords, assignments, wrappers and package runners in front of the command. */
function strip(words: string[]): string[] {
  let w = words;
  for (;;) {
    const head = w[0];
    if (head === undefined) return w;
    if (LEADING.has(head) || ASSIGNMENT.test(head)) {
      w = w.slice(1);
    } else if (head === "sudo" || head === "doas") {
      w = w.slice(1);
      while (w[0]?.startsWith("-")) w = w.slice(/^-[ugCh]$/.test(w[0]) ? 2 : 1);
    } else if (head === "env") {
      w = w.slice(1);
      while (w[0] && (w[0].startsWith("-") || ASSIGNMENT.test(w[0]))) w = w.slice(1);
    } else if (head === "corepack") {
      w = w.slice(1);
    } else if (head === "bundle" && w[1] === "exec") {
      w = w.slice(2);
    } else if (head === "npx" || head === "bunx" || head === "pnpx") {
      w = w.slice(1);
      while (w[0]?.startsWith("-")) {
        w = w.slice(/^(?:-p|--package)$/.test(w[0]) ? 2 : 1);
      }
    } else if (/^(?:npm|pnpm|yarn|bun)$/.test(head) && /^(?:exec|dlx|x)$/.test(w[1] ?? "")) {
      w = w.slice(2);
      while (w[0]?.startsWith("-")) {
        w = w.slice(/^(?:-p|--package)$/.test(w[0]) ? 2 : 1);
      }
    } else if (/^(?:pnpm|yarn|bun)$/.test(head) && RELEASE_BINS.test(w[1] ?? "")) {
      w = w.slice(1);
    } else {
      return w;
    }
  }
}

/** The simple commands `script` runs, in order (see the module comment for what's dropped). */
export function simpleCommands(script: string): SimpleCommand[] {
  const raw: string[] = [];
  scan(script, raw);
  const out: SimpleCommand[] = [];
  for (const text of raw) {
    const words = strip(text.split(/\s+/).filter((w) => w !== ""));
    if (words.length === 0) continue;
    const head = (words[0] as string).replace(/^.*\//, "");
    out.push({ words, text: [head, ...words.slice(1)].join(" ") });
  }
  return out;
}

/** True when a simple command of `script` matches `pattern` (anchor it with `^`). */
export function runs(script: string, pattern: RegExp): boolean {
  return simpleCommands(script).some((c) => pattern.test(c.text));
}

/** Programs that run a script file given as an argument (`bash x.sh`, `uv run x.py`). */
const RUNNERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "source",
  ".",
  "node",
  "deno",
  "bun",
  "tsx",
  "ts-node",
  "vite-node",
  "python",
  "python3",
  "py",
  "uv",
  "poetry",
  "pipenv",
  "ruby",
  "bundle",
  "pwsh",
  "powershell",
  "npm",
  "pnpm",
  "yarn",
  "xargs",
]);

/** `path` without a leading `./`. */
const plain = (path: string) => path.replace(/^(?:\.\/)+/, "");

/**
 * True when `script` executes the file `path` (repo-relative; `dir` is the directory the script
 * runs in): as the command itself (`./scripts/x.sh`) or through an interpreter (`bash x.sh`,
 * `node scripts/x.mjs`, `uv run --group g x.py`). Mentioning it (`shellcheck x.sh`,
 * `cat x.sh`, `echo x.sh`) doesn't count.
 */
export function runsFile(script: string, path: string, dir = "."): boolean {
  const names = new Set([plain(path)]);
  if (dir !== "." && path.startsWith(`${plain(dir)}/`)) {
    names.add(path.slice(plain(dir).length + 1));
  }
  return simpleCommands(script).some(({ words }) => {
    const [head, ...rest] = words;
    if (head === undefined) return false;
    if (names.has(plain(head))) return true;
    const program = head.replace(/^.*\//, "");
    if (!RUNNERS.has(program) && !/^python\d/.test(program)) return false;
    return rest.some((w) => names.has(plain(w)));
  });
}
