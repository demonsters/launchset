/** Public API of `@demonsters/launchset`. */

export type {
  LaunchsetConfig,
  ResolvedConfig,
  ResolvedTarget,
} from "./core/config/schema.ts";
export { defineConfig } from "./core/config/schema.ts";
export type { Changeset, Channel, Mode, Plan, TargetPlan } from "./core/types.ts";
