import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts", cli: "src/cli/bin.ts" },
  format: "esm",
  platform: "node",
  target: "node24",
  dts: { entry: "src/index.ts" },
  clean: true,
  outDir: "dist",
});
