import { describe, expect, it } from "vitest";
import { errorSummary, errorText, formatError } from "../../action/src/errors.ts";
import { LaunchsetError } from "../../src/core/errors.ts";
import { GitError } from "../../src/git/index.ts";
import { GitHubError } from "../../src/github/errors.ts";

describe("formatError", () => {
  it("returns the hint of a LaunchsetError, which keeps it apart from the message", () => {
    const error = new LaunchsetError("x", "something broke", { hint: "Do this." });
    expect(formatError(error)).toEqual({ message: "something broke", hint: "Do this." });
    expect(errorText(formatError(error))).toBe("something broke\nDo this.");
  });

  it("doesn't repeat a hint that a GitError embeds in its message: it becomes the tip", () => {
    const error = new GitError(
      "git push failed: denied\nHint: use the App token",
      "git push",
      "denied",
      1,
      "use the App token",
    );
    const formatted = formatError(error);
    expect(formatted).toEqual({ message: "git push failed: denied", hint: "use the App token" });
    expect(errorText(formatted).match(/use the App token/g)).toHaveLength(1);
    expect(errorSummary("launchset release", formatted).match(/use the App token/g)).toHaveLength(
      1,
    );
    expect(errorSummary("launchset release", formatted)).toContain("> [!TIP]\n> use the App token");
  });

  it("doesn't repeat the hint of a GitHubError either", () => {
    const error = new GitHubError(
      "POST /pulls: 403\nHint: grant Pull requests: write",
      403,
      "POST /pulls",
      "grant Pull requests: write",
    );
    expect(errorText(formatError(error)).match(/grant Pull requests/g)).toHaveLength(1);
  });

  it("handles plain errors and non-errors", () => {
    expect(formatError(new Error("boom"))).toEqual({ message: "boom" });
    expect(formatError("text")).toEqual({ message: "text" });
    expect(formatError(null)).toEqual({ message: "null" });
  });

  it("formats the summary with the hint as a tip", () => {
    const summary = errorSummary("launchset add", { message: "a\nb", hint: "c\nd" });
    expect(summary).toBe("## launchset add failed\n\na  \nb\n\n> [!TIP]\n> c\n> d\n");
  });
});
