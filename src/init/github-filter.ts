/**
 * GitHub Actions filter patterns (`on.push.tags`, `branches`): `*` matches anything but `/`,
 * `**` matches anything, `?` makes the previous character optional, `+` repeats it, `[...]`
 * is a character class, and a leading `!` excludes. Later patterns win.
 */

function escapeChar(char: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(char) ? `\\${char}` : char;
}

/** Regex for one pattern (without its `!`). */
export function filterPatternRegex(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?" || char === "+") {
      // Applies to the previous atom.
      out += char;
    } else if (char === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        out += "\\[";
      } else {
        out += `[${pattern.slice(i + 1, close).replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else if (char === "\\" && i + 1 < pattern.length) {
      out += escapeChar(pattern[i + 1] as string);
      i++;
    } else {
      out += escapeChar(char);
    }
  }
  try {
    return new RegExp(`^${out}$`);
  } catch {
    // An invalid pattern can't match anything GitHub would match either.
    return /$^/;
  }
}

/** True when the list of filter patterns selects `name`. */
export function matchesFilter(patterns: string[], name: string): boolean {
  let matched = false;
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      if (filterPatternRegex(pattern.slice(1)).test(name)) matched = false;
    } else if (filterPatternRegex(pattern).test(name)) {
      matched = true;
    }
  }
  return matched;
}

/** Tag names launchset pushes, to test tag filters against (spec 2, 9.9). */
export const LAUNCHSET_SAMPLE_TAGS = [
  { tag: "v1.2.3", what: "release tag v{version}" },
  { tag: "1.2.3", what: "release tag {version}" },
  { tag: "v1.2.3-alpha.0", what: "prerelease tag" },
  { tag: "launchset/web@1.2.3", what: "marker tag" },
];

/** The launchset tags a single pattern matches. */
export function launchsetTagsMatched(pattern: string): string[] {
  if (pattern.startsWith("!")) return [];
  const regex = filterPatternRegex(pattern);
  return LAUNCHSET_SAMPLE_TAGS.filter((s) => regex.test(s.tag)).map((s) => s.tag);
}
