// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the tests compare GitHub ${{ }} expressions
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadConfig } from "../../src/config/load.ts";
import { renderWorkflows } from "../../src/templates/workflows.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

interface Job {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  strategy?: { matrix?: Record<string, unknown> };
  steps: Step[];
}

interface Workflow {
  on: {
    pull_request?: unknown;
    push?: { branches?: string[] };
    workflow_dispatch?: { inputs?: Record<string, unknown> };
  };
  permissions?: Record<string, string>;
  concurrency?: unknown;
  jobs: Record<string, Job>;
}

const NAMES = ["launchset-check.yml", "launchset-release.yml", "launchset-preview.yml"] as const;
type Name = (typeof NAMES)[number];

const ours = {} as Record<Name, { text: string; workflow: Workflow }>;
const template = {} as Record<Name, Workflow>;

beforeAll(async () => {
  const { config } = await loadConfig(root);
  const rendered = renderWorkflows({ config, actionRef: "./action" });
  for (const name of NAMES) {
    const text = read(`.github/workflows/${name}`);
    ours[name] = { text, workflow: parse(text, { strict: true }) as Workflow };
    const file = rendered.find((f) => f.path.endsWith(name));
    if (!file) throw new Error(`${name} was not rendered`);
    template[name] = parse(file.content) as Workflow;
  }
});

const jobOf = (name: Name, job: string): Job => {
  const found = ours[name].workflow.jobs[job];
  if (!found) throw new Error(`${name} has no job ${job}`);
  return found;
};

const stepIndex = (job: Job, predicate: (step: Step) => boolean): number =>
  job.steps.findIndex(predicate);

const localActionSteps = (job: Job) => job.steps.filter((s) => s.uses === "./action");

describe("launchset's own workflows", () => {
  it("are the three launchset workflows, parsed as YAML", () => {
    for (const name of NAMES) expect(ours[name].workflow.jobs).toBeTypeOf("object");
  });

  it("have the same triggers as the generated templates (check and release)", () => {
    for (const name of ["launchset-check.yml", "launchset-release.yml"] as const) {
      expect(ours[name].workflow.on).toEqual(template[name].on);
      expect(ours[name].workflow.concurrency).toEqual(template[name].concurrency);
    }
  });

  it("have the same jobs, needs and conditions as the templates, except the documented changes", () => {
    for (const name of NAMES) {
      const jobs = Object.keys(ours[name].workflow.jobs);
      const expected = Object.keys(template[name].jobs).filter((j) => j !== "fork-notice");
      expect(jobs).toEqual(expected);
      for (const job of jobs) {
        expect(jobOf(name, job).needs).toEqual(template[name].jobs[job]?.needs);
      }
    }
    // `if` is the template's.
    const release = template["launchset-release.yml"].jobs;
    expect(jobOf("launchset-release.yml", "build").if).toBe(release.build?.if);
    expect(jobOf("launchset-release.yml", "finalize").if).toBe(release.finalize?.if);
    // The preview plan always runs: without pull_request triggers there is nothing to filter.
    expect(jobOf("launchset-preview.yml", "plan").if).toBeUndefined();
    for (const job of ["build", "comment"]) {
      expect(jobOf("launchset-preview.yml", job).if).toBe(
        template["launchset-preview.yml"].jobs[job]?.if,
      );
    }
  });

  it("builds the local action before any job uses it", () => {
    for (const name of NAMES) {
      for (const [id, job] of Object.entries(ours[name].workflow.jobs)) {
        const first = stepIndex(job, (s) => s.uses === "./action");
        if (first === -1) continue;
        const before = job.steps.slice(0, first);
        const where = `${name} job ${id}`;
        const checkout = before.findIndex((s) => s.uses?.startsWith("actions/checkout@"));
        const pnpm = before.findIndex((s) => s.uses?.startsWith("pnpm/action-setup@"));
        const node = before.findIndex(
          (s) => s.uses?.startsWith("actions/setup-node@") && s.with?.["node-version"] === 24,
        );
        const install = before.findIndex((s) => s.run === "pnpm install --frozen-lockfile");
        const build = before.findIndex((s) => s.run === "pnpm build:action");
        expect(checkout, `${where}: checkout`).toBeGreaterThanOrEqual(0);
        expect(pnpm, `${where}: pnpm`).toBeGreaterThan(checkout);
        expect(node, `${where}: node 24`).toBeGreaterThan(pnpm);
        expect(install, `${where}: install`).toBeGreaterThan(node);
        expect(build, `${where}: build:action`).toBeGreaterThan(install);
      }
    }
  });

  it("run the same action commands per job as the templates and never the published action", () => {
    for (const name of NAMES) {
      for (const [id, job] of Object.entries(ours[name].workflow.jobs)) {
        const actual = localActionSteps(job).map((s) => s.with?.command);
        const wanted = (template[name].jobs[id]?.steps ?? [])
          .filter((s) => s.uses === "./action")
          .map((s) => s.with?.command);
        // Documented change: no `verify` in the build jobs. npm trusted-publishing tokens can't
        // read the private package, so the publish steps are idempotent instead.
        const expected = id === "build" ? wanted.filter((c) => c !== "verify") : wanted;
        expect(actual, `${name} job ${id}`).toEqual(expected);
      }
      expect(ours[name].text).not.toContain("demonsters/launchset-action@");
    }
  });

  it("only reference these secrets, by name", () => {
    const allowed = new Set([
      "GITHUB_TOKEN",
      "LAUNCHSET_APP_ID",
      "LAUNCHSET_APP_PRIVATE_KEY",
      "NPM_TOKEN",
    ]);
    for (const name of NAMES) {
      const used = [...ours[name].text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
      for (const secret of used) expect(allowed, `${name}: ${secret}`).toContain(secret);
    }
    // Nothing that looks like a pasted credential.
    for (const name of NAMES)
      expect(ours[name].text).not.toMatch(/npm_[A-Za-z0-9]{20,}|ghp_|-----BEGIN/);
  });

  it("use the App token for everything that must trigger workflows", () => {
    const release = ours["launchset-release.yml"].workflow.jobs;
    const decide = release.launchset?.steps.find((s) => s.with?.command === "release");
    expect(decide?.with?.token).toBe("${{ steps.app-token.outputs.token }}");
    const finalize = release.finalize?.steps.find((s) => s.with?.command === "finalize");
    expect(finalize?.with?.token).toBe("${{ steps.app-token.outputs.token }}");
    const mark = release.build?.steps.find((s) => s.with?.command === "mark");
    expect(mark?.with?.token).toBe("${{ steps.mark-token.outputs.token }}");
    // The PR check only reads and comments.
    const check = jobOf("launchset-check.yml", "check").steps.find(
      (s) => s.with?.command === "check",
    );
    expect(check?.with?.token).toBe("${{ secrets.GITHUB_TOKEN }}");
  });
});

/**
 * Runs a workflow's publish script with a fake `npm` that prints `output` and exits with
 * `status`. Returns the script's exit status and output.
 */
function runPublish(script: string, npm: { output: string; status: number }) {
  const dir = mkdtempSync(join(tmpdir(), "launchset-publish-"));
  try {
    const fake = join(dir, "npm");
    writeFileSync(
      fake,
      `#!/usr/bin/env bash\necho "$*" >&2\nprintf '%s\\n' "$FAKE_OUTPUT"\nexit $FAKE_STATUS\n`,
    );
    chmodSync(fake, 0o755);
    const result = spawnSync("bash", ["-e", "-c", script], {
      encoding: "utf8",
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        DIST_TAG: "latest",
        FAKE_OUTPUT: npm.output,
        FAKE_STATUS: String(npm.status),
      },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CONFLICT = [
  "npm error code E403",
  "npm error 403 403 Forbidden - PUT https://registry.npmjs.org/@demonsters%2flaunchset - You cannot publish over the previously published versions: 1.0.0.",
].join("\n");

function publishesIdempotently(step: () => Step | undefined) {
  it("publishes with the dist-tag", () => {
    const result = runPublish(step()?.run ?? "", {
      output: "+ launchset@1.0.0",
      status: 0,
    });
    expect(result.status).toBe(0);
    expect(result.output).toContain("publish --tag latest");
    expect(step()?.env?.DIST_TAG).toBe("${{ steps.stamp.outputs.dist-tag }}");
  });

  it("counts a version that is already on npm as done", () => {
    const result = runPublish(step()?.run ?? "", { output: CONFLICT, status: 1 });
    expect(result.status).toBe(0);
    expect(result.output).toContain("::notice::");
  });

  it("fails on any other npm error, and shows it", () => {
    const output =
      "npm error code E404\nnpm error 404 Not Found - PUT https://registry.npmjs.org/x";
    const result = runPublish(step()?.run ?? "", { output, status: 1 });
    expect(result.status).toBe(1);
    expect(result.output).toContain("E404");
  });
}

describe("release workflow: npm target", () => {
  const steps = () => jobOf("launchset-release.yml", "build").steps;
  const publishGuard = "matrix.target == 'npm'";
  const publishStep = () => steps().find((s) => s.name === "Publish npm");

  it("publishes with npm trusted publishing (OIDC), no long-lived token and no verify", () => {
    expect(steps().find((s) => s.with?.command === "verify")).toBeUndefined();
    const text = readFileSync(join(root, ".github/workflows/launchset-release.yml"), "utf8");
    expect(text).not.toContain("NPM_TOKEN");
    expect(text).toMatch(/\n {6}id-token: write\n/);
    expect(publishStep()?.env?.NODE_AUTH_TOKEN).toBeUndefined();
  });

  it("builds after stamp, then publishes", () => {
    const list = steps();
    const build = list.findIndex((s) => s.run === "pnpm build");
    const publish = list.indexOf(publishStep() as Step);
    expect(build).toBeGreaterThan(list.findIndex((s) => s.id === "stamp"));
    expect(publish).toBeGreaterThan(build);
    expect(list[build]?.if).toBe(publishGuard);
    expect(list[publish]?.if).toBe(publishGuard);
    // The package stays private.
    expect(list[publish]?.run).not.toContain("--access");
    // `mark` comes after the publish.
    expect(list.findIndex((s) => s.with?.command === "mark")).toBeGreaterThan(publish);
  });

  publishesIdempotently(publishStep);

  it("sets up the npm registry after the install, so pnpm never sends the placeholder token", () => {
    const list = steps();
    const registry = list.findIndex(
      (s) => s.uses?.startsWith("actions/setup-node@") && s.with?.["registry-url"] !== undefined,
    );
    expect(registry).toBeGreaterThan(
      list.findIndex((s) => s.run === "pnpm install --frozen-lockfile"),
    );
    expect(list[registry]?.with?.["registry-url"]).toBe("https://registry.npmjs.org");
    expect(list[registry]?.if).toBe(publishGuard);
  });
});

describe("release workflow: action target", () => {
  const steps = () => jobOf("launchset-release.yml", "build").steps;

  it("mints a token for the action repo only, with contents: write", () => {
    const token = steps().find((s) => s.id === "action-repo-token");
    expect(token?.uses).toMatch(/^actions\/create-github-app-token@/);
    expect(token?.if).toBe("matrix.target == 'action'");
    expect(token?.with).toMatchObject({
      owner: "demonsters",
      repositories: "launchset-action",
      "permission-contents": "write",
    });
  });

  it("checks out demonsters/launchset-action with that token and its tags", () => {
    const checkout = steps().find((s) => s.with?.repository === "demonsters/launchset-action");
    expect(checkout?.uses).toMatch(/^actions\/checkout@/);
    expect(checkout?.if).toBe("matrix.target == 'action'");
    expect(checkout?.with?.token).toBe("${{ steps.action-repo-token.outputs.token }}");
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
  });

  it("builds the publish directory into that checkout and runs the publish script", () => {
    const list = steps();
    const publish = list.find((s) => s.name === "Publish the action");
    expect(publish?.if).toBe("matrix.target == 'action'");
    const path = list.find((s) => s.with?.repository === "demonsters/launchset-action")?.with?.path;
    expect(path).toBeTypeOf("string");
    expect(publish?.run).toContain(`node scripts/build-action.ts --out ${path}`);
    expect(publish?.run).toContain(
      `node scripts/publish-action.ts --repo-dir ${path} --version "$VERSION"`,
    );
    expect(publish?.env?.VERSION).toBe("${{ steps.stamp.outputs.version }}");
    // After stamp (the version), and after the checkout it writes into.
    expect(list.indexOf(publish as Step)).toBeGreaterThan(
      list.findIndex((s) => s.with?.repository === "demonsters/launchset-action"),
    );
    // Both scripts exist.
    expect(readFileSync(join(root, "scripts/publish-action.ts"), "utf8")).toContain("--repo-dir");
    expect(readFileSync(join(root, "scripts/build-action.ts"), "utf8")).toContain("--out");
  });

  it("marks the target only after the publish steps", () => {
    const list = steps();
    const mark = list.findIndex((s) => s.with?.command === "mark");
    expect(mark).toBeGreaterThan(list.findIndex((s) => s.name === "Publish the action"));
    expect(mark).toBeGreaterThan(list.findIndex((s) => s.run?.startsWith("npm publish")));
  });
});

describe("preview workflow", () => {
  it("only runs for pushes to next/* and manual runs, never for pull requests", () => {
    const { on } = ours["launchset-preview.yml"].workflow;
    expect(on.pull_request).toBeUndefined();
    expect(on.push?.branches).toEqual(["next/*"]);
    expect(on.workflow_dispatch?.inputs).toHaveProperty("targets");
  });

  it("publishes to npm only on the prerelease channel, without verify", () => {
    const steps = jobOf("launchset-preview.yml", "build").steps;
    const guard = "matrix.target == 'npm' && steps.stamp.outputs.channel == 'prerelease'";
    const publish = steps.find((s) => s.name === "Publish npm");
    expect(publish?.if).toBe(guard);
    expect(steps.find((s) => s.run === "pnpm build")?.if).toBe(guard);
    expect(steps.find((s) => s.with?.command === "verify")).toBeUndefined();
  });

  describe("its publish step", () => {
    publishesIdempotently(() =>
      jobOf("launchset-preview.yml", "build").steps.find((s) => s.name === "Publish npm"),
    );
  });

  it("never cancels a prerelease build", () => {
    const { concurrency } = ours["launchset-preview.yml"].workflow as {
      concurrency: { "cancel-in-progress": string };
    };
    expect(concurrency["cancel-in-progress"]).toBe("${{ !startsWith(github.ref_name, 'next/') }}");
  });
});

describe("ci.yml", () => {
  it("smoke-tests the local action at the repo root, where launchset.config.ts lives", () => {
    const ci = parse(read(".github/workflows/ci.yml")) as Workflow;
    const smoke = ci.jobs["action-smoke"];
    const step = smoke?.steps.find((s) => s.uses === "./action");
    expect(step?.with?.command).toBe("add");
    expect(step?.with?.["working-directory"]).toBeUndefined();
  });
});
