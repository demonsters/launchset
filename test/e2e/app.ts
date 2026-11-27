/**
 * The fixture app of the lifecycle scenarios: a Dockerfile, a web build, an Android gradle app
 * and an iOS xcodeproj, set up by `launchset init` the way a team would.
 */

import { expect } from "vitest";
import { read, type World } from "./helpers.ts";

/** Init answers for the app: docker, web and android ship with every release, ios on demand. */
export const APP_DECISIONS: Record<string, string> = {
  "target.android": "auto",
  "target.web": "auto",
  "docker.docker.image": "ghcr.io/acme/app",
};

export interface AppOptions {
  /** `--decide` answers, on top of `APP_DECISIONS`. */
  decide?: Record<string, string>;
  /** Create and push `v1.4.0` after init (the repo has been released before). Default true. */
  released?: boolean;
  /** The version the app is on (and tagged with): default 1.4.0. */
  version?: string;
  /** CHANGELOG.md to commit before init (init keeps an existing changelog). */
  changelog?: string;
}

/**
 * Put the app fixture into the world's repository, run `init --yes`, commit and push it as
 * `main`, and tag the baseline release.
 */
export async function setupApp(world: World, options: AppOptions = {}): Promise<void> {
  const { dev } = world;
  world.wipeDev();
  world.copyFixture("app");
  const version = options.version ?? "1.4.0";
  if (version !== "1.4.0") {
    for (const file of [
      "package.json",
      "package-lock.json",
      "android/app/build.gradle",
      "ios/App/App.xcodeproj/project.pbxproj",
    ]) {
      dev.write(file, read(dev.dir, file).replaceAll("1.4.0", version));
    }
  }
  if (options.changelog !== undefined) world.dev.write("CHANGELOG.md", options.changelog);
  dev.git("add", "--all");
  dev.git("commit", "--quiet", "--no-verify", "-m", "The app, before launchset");
  const decide = Object.entries({ ...APP_DECISIONS, ...options.decide }).flatMap(([id, value]) => [
    "--decide",
    `${id}=${value}`,
  ]);
  const init = await world.devCli(["init", "--yes", ...decide]);
  expect(init.code, `${init.stdout}\n${init.stderr}`).toBe(0);
  // init leaves the targets with only the "build steps missing" placeholder out of previews; the
  // scenarios build every target (the team has added their build steps), so previews build all.
  const config = read(dev.dir, "launchset.config.ts");
  const preview = /\n {2}\/\/ Previews build only[\s\S]*?\n {2}preview: \{ targets: \[[^\]]*\] \},/;
  expect(config).toMatch(preview);
  dev.write("launchset.config.ts", config.replace(preview, ""));
  dev.git("add", "--all");
  dev.git("commit", "--quiet", "--no-verify", "-m", "Set up launchset");
  dev.git("push", "--quiet", "origin", "main");
  if (options.released ?? true) {
    dev.git("tag", `v${version}`);
    dev.git("push", "--quiet", "origin", `v${version}`);
  }
}

/** Add top-level config options to `launchset.config.ts` (init writes `defineConfig({`), commit and push. */
export function addConfig(world: World, source: string): void {
  const path = "launchset.config.ts";
  const text = read(world.dev.dir, path);
  const marker = "export default defineConfig({\n";
  expect(text).toContain(marker);
  world.dev.write(path, text.replace(marker, `${marker}${source}\n`));
  world.dev.git("add", "--all");
  world.dev.git("commit", "--quiet", "--no-verify", "-m", "Configure launchset");
  world.dev.git("push", "--quiet", "origin", "HEAD");
}
