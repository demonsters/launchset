import { defineConfig } from "@demonsters/launchset";
import { imageName } from "./shared.ts";

export default defineConfig({
  targets: {
    "docker-api": {
      type: "docker",
      image: imageName,
      tags: ["v{version}", "latest"],
      files: [{ path: "deploy/k8s/*.yaml", kind: "image" }],
    },
    android: { type: "android", source: { kind: "capacitor", dir: "apps/mobile" } },
    ios: { type: "ios", source: { kind: "capacitor", dir: "apps/mobile" }, release: "manual" },
    sdk: {
      type: "custom",
      files: [{ path: "packages/sdk/package.json", kind: "json", key: "version" }],
      npm: { package: "packages/sdk/package.json" },
      verify: ["npm"],
    },
  },
});
