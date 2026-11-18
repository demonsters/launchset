/** Public API of `@demonsters/launchset`. */

export { configJsonSchema } from "./core/config/json-schema.ts";
export type {
  LaunchsetConfig,
  ResolvedConfig,
  ResolvedTarget,
} from "./core/config/schema.ts";
export { defineConfig } from "./core/config/schema.ts";
export { isLaunchsetError, LaunchsetError } from "./core/errors.ts";
export type { Bump, Changeset, Channel, Mode, Plan, TargetPlan } from "./core/types.ts";
