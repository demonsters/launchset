/**
 * JSON Schema for `launchset.config.json` (and the docs' configuration reference),
 * generated from the zod schema. Pure.
 */

import { z } from "zod";
import { configSchema } from "./schema.ts";

/**
 * The JSON Schema of the config as users write it (`io: "input"`: defaults are optional).
 * A top-level `$schema` property is allowed for editor support.
 */
export function configJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(configSchema, { io: "input" }) as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  return {
    ...schema,
    title: "launchset configuration",
    description: "Configuration for launchset (launchset.config.json).",
    properties: {
      $schema: { type: "string", description: "Path or URL of this JSON Schema." },
      ...properties,
    },
  };
}
