/** Where the launchset docs live (GitHub Pages). */
export const DOCS_URL = "https://demonsters.github.io/launchset/";

/** Link to one docs page, e.g. `docsPage("changesets")`. */
export function docsPage(path: string): string {
  return `${DOCS_URL}${path.replace(/^\/+/, "")}${path.endsWith("/") || path === "" ? "" : "/"}`;
}
