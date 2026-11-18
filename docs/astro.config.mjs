// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// Hosted on GitHub Pages (project site): https://demonsters.github.io/launchset/
const site = "https://demonsters.github.io";
const base = "/launchset";

/**
 * The pages link to each other with root-relative links (`/guides/previews/`). On a project
 * site they live under `base`, so prefix those links at build time.
 */
function prefixBase() {
  const walk = (node) => {
    if ((node.type === "link" || node.type === "definition") && typeof node.url === "string") {
      if (
        node.url.startsWith("/") &&
        !node.url.startsWith("//") &&
        !node.url.startsWith(`${base}/`)
      ) {
        node.url = `${base}${node.url}`;
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  return (tree) => walk(tree);
}

export default defineConfig({
  site,
  base,
  markdown: { remarkPlugins: [prefixBase] },
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
