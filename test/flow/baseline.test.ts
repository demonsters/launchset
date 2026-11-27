/**
 * `baseline` (spec 11.1 step 5): the first release run on the base branch creates the release
 * tag of the version that was released before launchset, at the commit it runs on. init used to
 * create it at HEAD before the migration, where pushing it started the old tag workflows.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { release } from "../../src/flow/release.ts";
import {
  CONFIG,
  changesetText,
  ciClone,
  contextFor,
  FakeGitHub,
  pkg,
  setupProject,
  versionFiles,
} from "./helpers.ts";

const WITH_BASELINE = { ...CONFIG, baseline: "1.4.0" };

describe("release: baseline", () => {
  it("creates the baseline tag at HEAD and builds nothing, also when HEAD changed the version", async () => {
    // 1.3.0 in the files, raised to 1.4.0 by the migration commit (a release commit).
    const project = setupProject({ version: "1.3.0", released: false, config: WITH_BASELINE });
    const merge = project.push("Adopt launchset", versionFiles("1.4.0"));
    new FakeGitHub(project.remote);
    const result = await release(await contextFor(project.repo));
    expect(result.data.mode).toBe("none");
    expect(result.data.plan.matrix).toEqual([]);
    expect(project.remoteTags().get("v1.4.0")).toBe(merge);
    expect(result.data.notices[0]).toBe(
      `Created the baseline tag \`v1.4.0\` at \`${merge.slice(0, 7)}\` (\`baseline\` in the launchset config): 1.4.0 counts as released, nothing was built. You can remove \`baseline\` from the config now.`,
    );
    expect(result.summary).toContain("Created the baseline tag");
    // Nothing before the baseline is unreleased work.
    expect(result.data.warnings).toEqual([]);

    // The next run finds the tag: nothing more to do.
    const again = await release(await contextFor(project.repo));
    expect(again.data.notices.join("\n")).not.toContain("baseline");
    expect(again.data.mode).toBe("none");
  });

  it("opens the release PR in the same run when changesets are pending", async () => {
    const project = setupProject({ released: false, config: WITH_BASELINE });
    const head = project.push("Add offline mode", {
      ".launchset/brave-lions-sing.md": changesetText("minor", "Add offline mode."),
    });
    const github = new FakeGitHub(project.remote);
    const result = await release(await contextFor(project.repo));
    expect(project.remoteTags().get("v1.4.0")).toBe(head);
    expect(result.data.mode).toBe("release-pr");
    expect(result.data.plan.version).toBe("1.5.0");
    expect(github.openPrs()).toHaveLength(1);
  });

  it("only plans it in a dry run", async () => {
    const project = setupProject({ released: false, config: WITH_BASELINE });
    new FakeGitHub(project.remote);
    const result = await release(await contextFor(project.repo), { dryRun: true });
    expect(result.data.mode).toBe("none");
    expect(result.data.notices[0]).toContain(
      "`baseline` is 1.4.0: the release workflow creates `v1.4.0`",
    );
    expect(project.remoteTags().has("v1.4.0")).toBe(false);
    expect(project.repo.git("tag", "--list", "v1.4.0")).toBe("");
  });

  it("does nothing for another version, or when the tag exists", async () => {
    // The root version moved on without the baseline: it's an ordinary release then.
    const moved = setupProject({ version: "1.3.0", released: false, config: WITH_BASELINE });
    moved.push("Bump", { "package.json": pkg("1.5.0") });
    new FakeGitHub(moved.remote);
    const publish = await release(await contextFor(moved.repo));
    expect(publish.data.mode).toBe("publish");
    expect(moved.remoteTags().has("v1.4.0")).toBe(false);

    const released = setupProject({ config: WITH_BASELINE });
    const tagged = released.remoteTags().get("v1.4.0");
    new FakeGitHub(released.remote);
    const none = await release(await contextFor(released.repo));
    expect(none.data.notices.join("\n")).not.toContain("baseline");
    expect(released.remoteTags().get("v1.4.0")).toBe(tagged);
  });

  it("is left alone with a warning when launchset already shipped part of that version", async () => {
    const project = setupProject({ released: false, config: WITH_BASELINE });
    const { repo } = project;
    repo.git("tag", "launchset/web@1.4.0");
    repo.git("push", "--quiet", "origin", "launchset/web@1.4.0");
    new FakeGitHub(project.remote);
    const result = await release(await contextFor(repo));
    expect(project.remoteTags().has("v1.4.0")).toBe(false);
    expect(result.data.warnings[0]).toContain(
      "`baseline` is 1.4.0, but launchset already shipped part of 1.4.0 (marker tags for `web`)",
    );
  });

  it("plans with the tag another run created first (the push lost the race)", async () => {
    const project = setupProject({ released: false, config: WITH_BASELINE });
    const older = project.push("Older work", { "a.txt": "a\n" });
    const ci = ciClone(project);
    const newer = project.push("Newer work", { "b.txt": "b\n" });
    new FakeGitHub(project.remote);
    // The run for the newer commit tags it first.
    await release(await contextFor(project.repo));
    expect(project.remoteTags().get("v1.4.0")).toBe(newer);
    // The run for the older commit didn't see the tag yet (no fetch): its push is refused.
    expect(ci.head()).toBe(older);
    const result = await release(await contextFor(ci), { fetch: false });
    expect(result.ok).toBe(true);
    expect(result.data.notices).toContain(
      "Another release run created the baseline tag `v1.4.0` first.",
    );
    expect(project.remoteTags().get("v1.4.0")).toBe(newer);
    expect(ci.git("rev-parse", "v1.4.0^{commit}")).toBe(newer);
  });

  it("a dispatch creates it too: nothing to retry, and a manual target ships from it", async () => {
    const project = setupProject({ released: false, config: WITH_BASELINE });
    const head = project.repo.head();
    new FakeGitHub(project.remote);
    const retry = await release(
      await contextFor(project.repo, {
        event: { name: "workflow_dispatch", payload: { inputs: {} } },
      }),
    );
    expect(project.remoteTags().get("v1.4.0")).toBe(head);
    expect(retry.data.mode).toBe("none");
    expect(retry.data.notices.join("\n")).toContain("there is nothing to retry");

    const other = setupProject({ released: false, config: WITH_BASELINE });
    new FakeGitHub(other.remote);
    const ship = await release(
      await contextFor(other.repo, {
        event: { name: "workflow_dispatch", payload: { inputs: { target: "ios" } } },
      }),
    );
    expect(other.remoteTags().get("v1.4.0")).toBe(other.repo.head());
    expect(ship.data.mode).toBe("ship");
    expect(ship.data.plan).toMatchObject({ version: "1.4.0", releaseSha: other.repo.head() });
  });

  it("isn't created while the config with the baseline isn't committed", async () => {
    // Right after init, before the migration is committed: HEAD still has the old workflows.
    const project = setupProject({ released: false });
    writeFileSync(
      join(project.repo.dir, "launchset.config.json"),
      `${JSON.stringify(WITH_BASELINE, null, 2)}\n`,
    );
    new FakeGitHub(project.remote);
    const result = await release(await contextFor(project.repo));
    expect(result.data.warnings[0]).toContain(
      "`baseline` is 1.4.0, but the launchset config isn't committed at",
    );
    expect(result.data.notices[0]).toContain("the release workflow creates `v1.4.0`");
    expect(project.remoteTags().has("v1.4.0")).toBe(false);
    expect(project.repo.git("tag", "--list", "v1.4.0")).toBe("");
  });
});
