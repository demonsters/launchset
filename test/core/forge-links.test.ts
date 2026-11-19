import { describe, expect, it } from "vitest";
import { forgeLinks, forgeWords } from "../../src/core/forge-links.ts";

describe("forgeWords", () => {
  it("GitHub by default", () => {
    const words = forgeWords();
    expect(words.host).toBe("github");
    expect(words.prText(12)).toBe("#12");
    expect(words.prRef(12)).toBe("refs/pull/12/head");
    expect(words.prName).toBe("PR");
    expect(words.releaseName).toBe("GitHub Release");
  });

  it("GitLab", () => {
    const words = forgeWords("gitlab");
    expect(words.prText(12)).toBe("!12");
    expect(words.prRef(12)).toBe("refs/merge-requests/12/head");
    expect(words.prName).toBe("MR");
    expect(words.releaseName).toBe("GitLab release");
  });
});

describe("forgeLinks", () => {
  it("GitHub links, default server", () => {
    const links = forgeLinks({ repository: "acme/app" });
    expect(links.serverUrl).toBe("https://github.com");
    expect(links.prUrl(12)).toBe("https://github.com/acme/app/pull/12");
    expect(links.runUrl(99)).toBe("https://github.com/acme/app/actions/runs/99");
    expect(links.prText(12)).toBe("#12");
  });

  it("GitHub Enterprise server, trailing slashes dropped", () => {
    const links = forgeLinks({ serverUrl: "https://github.example.com//", repository: "acme/app" });
    expect(links.prUrl(3)).toBe("https://github.example.com/acme/app/pull/3");
  });

  it("GitLab links with nested groups and a self-managed server", () => {
    const links = forgeLinks({ host: "gitlab", repository: "acme/mobile/app" });
    expect(links.serverUrl).toBe("https://gitlab.com");
    expect(links.prUrl(12)).toBe("https://gitlab.com/acme/mobile/app/-/merge_requests/12");
    expect(links.runUrl(99)).toBe("https://gitlab.com/acme/mobile/app/-/pipelines/99");
    const own = forgeLinks({
      host: "gitlab",
      serverUrl: "https://git.acme.dev/",
      repository: "acme/app",
    });
    expect(own.prUrl(1)).toBe("https://git.acme.dev/acme/app/-/merge_requests/1");
    expect(own.prText(1)).toBe("!1");
  });
});
