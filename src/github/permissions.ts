/**
 * The GitHub App repository permissions launchset needs (spec 9.1), and why. This list is
 * the source for the docs' "Create the GitHub App" page and for error hints.
 */

export interface AppPermission {
  /** Name as shown on the GitHub App settings page. */
  name: string;
  access: "read" | "read & write";
  why: string;
}

export const REQUIRED_APP_PERMISSIONS: readonly AppPermission[] = [
  {
    name: "Contents",
    access: "read & write",
    why: "Push the release branch, marker, release, partial and prerelease tags; create and update GitHub Releases; read commits and their associated pull requests.",
  },
  {
    name: "Pull requests",
    access: "read & write",
    why: "Open, update and close the release PR and the changelog backport PR; post the sticky check and preview comments (PR comments use the issues API, which accepts Pull requests: write); list PR files for bot-PR detection.",
  },
  {
    name: "Workflows",
    access: "read & write",
    why: 'The release branch is rebuilt from the base branch and force-pushed. GitHub rejects an App\'s push that brings in commits changing .github/workflows/* ("refusing to allow a GitHub App to create or update workflow … without `workflows` permission"), which happens whenever the base branch changed a workflow since the last release-PR push.',
  },
  {
    name: "Actions",
    access: "read",
    why: "List the jobs of the current workflow run, for per-target links in the preview comment and the job summary.",
  },
  {
    name: "Metadata",
    access: "read",
    why: "Mandatory for every GitHub App (granted automatically).",
  },
] as const;

/** `"Pull requests: read & write"` style label for hints. */
export function permissionLabel(name: string, write: boolean): string {
  return `${name}: ${write ? "read & write" : "read"}`;
}
