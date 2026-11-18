// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// Hosting isn't decided yet, so there is no `site` option. Set it (and `base`, if the site
// lives under a path) when the site gets a home.
export default defineConfig({
  integrations: [
    starlight({
      title: "launchset",
      description:
        "Changesets-style releases for repos where one version drives many targets: Docker images, Android, iOS and web apps.",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/demonsters/launchset" },
      ],
      sidebar: [
        { label: "Start here", items: ["getting-started", "concepts", "changesets"] },
        { label: "Set up", items: ["github-app", "guides/migrating"] },
        {
          label: "Targets",
          items: [
            "targets",
            "targets/docker",
            "targets/web",
            "targets/android",
            "targets/ios",
            "targets/react-native",
            "targets/capacitor",
            "targets/expo",
            "targets/custom",
          ],
        },
        {
          label: "Guides",
          items: [
            "guides/release-flow",
            "guides/build-numbers",
            "guides/previews",
            "guides/hotfixes",
            "guides/partial-releases",
            "guides/manual-targets",
            "guides/direct-push",
            "guides/bot-prs",
            "guides/recipes",
          ],
        },
        {
          label: "Store pipelines",
          items: ["store-pipelines", "store-pipelines/apple", "store-pipelines/google-play"],
        },
        {
          label: "Reference",
          items: [
            "reference/configuration",
            "reference/cli",
            "reference/action",
            "reference/troubleshooting",
          ],
        },
      ],
    }),
  ],
});
