// The package's old name: configs written before the rename still import it.
import { defineConfig } from "@demonsters/launchset";

export default defineConfig({
  targets: { web: { type: "web" } },
});
