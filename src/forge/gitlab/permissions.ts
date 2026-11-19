/**
 * What the GitLab token launchset needs (project or group access token), and why. The source
 * for the docs' token page and for error hints.
 */

export interface RequiredTokenScopes {
  /** Scopes to tick when creating the access token, with what each is for. */
  scopes: readonly { name: string; why: string }[];
  /** The lowest role that works for everything launchset does. */
  role: string;
  /** Why that role. */
  roleWhy: string;
}

export const REQUIRED_TOKEN_SCOPES: RequiredTokenScopes = {
  scopes: [
    {
      name: "api",
      why: "Open, update and close the release MR; post the sticky check and preview notes; create and update releases; read merge requests, commits and pipeline jobs; start MR pipelines (the optional preview sweep).",
    },
    {
      name: "write_repository",
      why: "Push the release branch, marker, release, partial and prerelease tags with git.",
    },
  ],
  role: "Maintainer",
  roleWhy:
    "Developer is enough for the API, but pushing to protected branches and creating protected tags (the defaults) needs Maintainer, or a matching 'Allowed to push' rule for the token's bot.",
} as const;
