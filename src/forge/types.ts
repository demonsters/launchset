/**
 * The host-neutral interface to the code host's API ("forge": GitHub today, GitLab later).
 * Tags and branches are pushed with git (src/git); a forge client handles PRs, comments,
 * releases and lookups. Every failure is a {@link ForgeError} (see `./errors.ts`).
 */

export interface Logger {
  debug(message: string): void;
  warn(message: string): void;
}

/** A pull request (GitHub) or merge request (GitLab). */
export interface PullRequest {
  /** The number shown to people (GitHub: `number`, GitLab: `iid`). */
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  /** ISO time it was merged, or null. */
  mergedAt: string | null;
  /**
   * The commit the merge produced on the base branch: the merge commit, the squash commit, or
   * the last rebased commit. Null when not merged.
   */
  mergeCommitSha: string | null;
  /** ISO time of the last update. */
  updatedAt: string;
  /** Login of the author, e.g. `dependabot[bot]`; empty for deleted users. */
  author: string;
  /** Head branch name. */
  head: string;
  headSha: string;
  /** Base branch name. */
  base: string;
  url: string;
}

export interface Release {
  id: number;
  tag: string;
  name: string;
  body: string;
  prerelease: boolean;
  draft: boolean;
  url: string;
}

export type PrFileStatus =
  | "added"
  | "removed"
  | "modified"
  | "renamed"
  | "copied"
  | "changed"
  | "unchanged";

export interface PrFile {
  path: string;
  status: PrFileStatus;
  previousPath?: string;
}

/** A CI job of a run (GitHub: workflow run job, GitLab: pipeline job). */
export interface Job {
  id: number;
  name: string;
  status: string;
  /** `success`, `failure`, `cancelled`, `skipped`, … or null while running. */
  conclusion: string | null;
  url: string;
}

export interface StickyCommentResult {
  id: number;
  url: string;
  action: "created" | "updated" | "unchanged";
}

export interface CreateReleaseInput {
  tag: string;
  name: string;
  body: string;
  /** Hosts without pre-releases ignore it. */
  prerelease: boolean;
  /** Mark as the repository's latest release (GitHub `make_latest`); others ignore it. */
  makeLatest: boolean;
}

export interface UpdateReleaseInput {
  name?: string;
  body?: string;
  prerelease?: boolean;
  makeLatest?: boolean;
}

/** The existing release to update: GitHub keys releases by id, GitLab by tag. */
export type ReleaseRef = Pick<Release, "id" | "tag">;

export interface Forge {
  /** Full repository path: `owner/repo` on GitHub, possibly `group/sub/project` elsewhere. */
  readonly repository: string;

  findOpenPrByHead(branch: string): Promise<PullRequest | null>;
  createPr(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequest>;
  updatePr(number: number, input: { title?: string; body?: string }): Promise<PullRequest>;
  /** Close a PR, first posting `comment` when given. */
  closePr(number: number, comment?: string): Promise<void>;
  getPr(number: number): Promise<PullRequest>;

  /**
   * Create or update the one comment on PR `issueNumber` that carries the hidden marker
   * `<!-- launchset:<id> -->` (spec 9.2, 9.7). The marker is added to `body` here.
   */
  upsertStickyComment(issueNumber: number, id: string, body: string): Promise<StickyCommentResult>;

  /** The published release for `tag`, or null when there is none. */
  getReleaseByTag(tag: string): Promise<Release | null>;
  /** Create a release for an existing tag. */
  createRelease(input: CreateReleaseInput): Promise<Release>;
  updateRelease(release: ReleaseRef, input: UpdateReleaseInput): Promise<Release>;

  /**
   * Merged PRs associated with a commit. Note: for commits that aren't on the default branch
   * GitHub only returns open PRs, so this is empty there; use {@link closedPrsInto}.
   */
  pullRequestsForCommit(sha: string): Promise<PullRequest[]>;
  /**
   * Merged PRs into `base`, most recently updated first. With `updatedSince` (ISO time), the
   * listing stops at the first PR last updated before it (a merged PR is always updated at or
   * after its merge).
   */
  closedPrsInto(base: string, options?: { updatedSince?: string }): Promise<PullRequest[]>;
  /** Every file of a PR (paginated). */
  prFiles(number: number): Promise<PrFile[]>;
  /** Jobs of a CI run's latest attempt. */
  listJobs(runId: number): Promise<Job[]>;
}

/** The hidden marker of a sticky comment. */
export function stickyMarker(id: string): string {
  return `<!-- launchset:${id} -->`;
}
