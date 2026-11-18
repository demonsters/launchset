# Kickoff: build launchset

You are the lead engineer for **launchset**, a Changesets-style release tool for lock-step monorepos (Docker, Android, iOS and web from one version). You run as **Opus at high effort**. Your job is to deliver a complete, tested v1 by planning the work, delegating parts to subagents, reviewing everything that comes back, and doing a final review and refactor pass yourself.

## 1. Before you start

1. Read `design/SPEC.md` completely. It's the source of truth. Every design decision in it has been agreed with the team: **don't reopen them**.
   - If the spec is unclear on a detail, choose the most sensible option that fits its principles (section 1.1), and record the choice in `design/DECISIONS.md` (one line each: what, why, section).
   - If something in the spec is contradictory or impossible (for example an API doesn't work the way it says), do the closest thing that keeps the intent, record it in `design/DECISIONS.md` marked **NEEDS REVIEW**, and mention it in your final report.
2. Working directory: a clone of the repo. It contains only `design/`.
3. GitHub: the repo `https://github.com/demonsters/launchset` is private. `main` holds only the `design/` folder; issues #1 and #2 track postponed features. `gh` is logged in as `rene-demonsters`.
   - Create a branch `initial-build` from `main` and do all work there. Commit in small, logical steps with clear messages (no commit-message convention required). Push regularly.
   - At the end, open a **draft PR** from `initial-build` to `main`. Don't merge it.
4. Don't create other repos, GitHub Apps, secrets, npm publishes, tags on the real repo, or deploy anything. Where the spec needs things only the team can set up (section 17), use mocks and placeholders and list them in your final report.

## 2. How to use subagents

Use subagents where it helps: for bounded, well-specified pieces, or to run work in parallel. Do small things yourself.

- Start them with the Agent tool, always passing `effort: "high"` and a `model`:
  - **`model: "sonnet"`** for well-specified, bounded work where the spec says exactly what to build: file stampers with fixtures, CLI command wiring, workflow templates, the action wrapper, preview mode on top of the finished core, test suites, the docs site and the skill.
  - **`model: "opus"`** for work that needs design judgment or where mistakes are costly or subtle: the core engine (versions, plan/state machine, markers, superseding, maintenance lines, next-free versions), GitHub integration (release PR, bot-PR detection, finalize, backport), store and registry verification (Play / App Store Connect auth and APIs), and all reviews.
- Give each subagent a self-contained brief:
  - which spec sections it implements (quote the key parts; it can also read `design/SPEC.md`),
  - which files/folders it owns and which it must not touch,
  - the interfaces it must use or provide (types, function signatures),
  - acceptance criteria: the tests that must exist and pass, and `pnpm lint`, `pnpm typecheck`, `pnpm test` clean,
  - what to report back: a summary of changes, test results, deviations from the spec, open questions.
- Run subagents in parallel only when their files don't overlap. When they could overlap, run them in sequence, or use `isolation: "worktree"` and merge the results yourself.
- Settle the shared types and module interfaces (`src/core` types, stamper interface, plan JSON shape) **yourself before** starting parallel work, so subagents build against fixed contracts.

## 3. Review every result (as Opus)

Nothing a subagent produces is accepted until it's been reviewed by Opus:

1. Read the diff (`git diff`), not just the subagent's summary. Its summary describes what it intended, not necessarily what it did.
2. Run `pnpm lint`, `pnpm typecheck` and `pnpm test` yourself.
3. Check the work against its spec sections and acceptance criteria. Look specifically for: missing edge cases the spec lists, text-preserving edits that actually reformat files, tests that only test mocks, swallowed errors, unclear error messages, and anything that writes build numbers into committed files.
4. For large diffs, start a separate reviewer subagent (`model: "opus"`, `effort: "high"`) with the diff, the relevant spec sections and the checklist above, and have it report findings only. You decide which findings are real.
5. Send real problems back to the same subagent (SendMessage) or fix small ones yourself. Re-review after fixes. Commit only reviewed, green work.

## 4. Suggested phases

Adjust the order if you find a better one, but keep the dependencies.

| # | Phase | Spec | Model |
|---|---|---|---|
| 0 | Repo setup: pnpm, TS strict, Biome, vitest, bundler, CI workflow for launchset itself, folder layout | 13, 14 | you or sonnet |
| 1 | Core: config schema + loader, changeset parse/write, bump + next-free version, maintenance rules, preview and prerelease versions, build-number strategies, changelog rendering, Docker tag template rendering, plan/state logic incl. manual targets (`ship` mode) | 4, 5, 6.1 templates, 7.1–7.2, 8, 12, 9.3 logic, 9.6, 9.8 | opus |
| 2 | Stampers: Android (gradle, kts, properties), iOS (pbxproj, plist, xcconfig), Expo, Capacitor aliases, json/yaml/regex, consistency check. Can be split into two parallel agents (Android + generic / iOS + Expo) | 6 | sonnet |
| 3 | Git wrapper + GitHub integration: release PR, sticky comments, tags, releases, bot-PR detection, finalize, supersede, backport, manual-target Release updates, prerelease tag reservation | 9.1–9.6, 9.8, 9.9 | opus |
| 4 | Store and registry verification clients | 7.3, 7.4 | opus |
| 5 | CLI commands incl. `hotfix` and `ship` | 11 | sonnet |
| 5b | `init`: detection (incl. existing release machinery), canonical version, retiring conflicting workflows/scripts, `--detect --json` / `--decide` | 11.1 | opus |
| 6 | GitHub Action (bundled single file) + workflow templates | 9.3, 9.7, 10 | sonnet |
| 7 | Previews and prerelease branches end to end (preview-plan, docker preview/prerelease tags, prerelease tag + GitHub pre-release, preview comment) | 9.7, 9.9 | sonnet |
| 8 | End-to-end lifecycle tests with temporary git repos | 14 | sonnet |
| 9 | Dogfooding: launchset's own launchset config and release workflows | 15 | sonnet |
| 10 | Docs site (Astro Starlight), agent skill and adoption skill | 16 | sonnet, reviewed by opus |
| 11 | Final full-codebase review and refactor | all | you (opus) |

### Phase 10: docs and skill

Start this once the CLI, config and workflows are stable (after phases 5–7), with one dedicated docs subagent (`model: "sonnet"`, `effort: "high"`):
- Create the Starlight site in `docs/` (use the official Starlight template, current version) with the pages from spec 16.1. Write for developers who've never seen launchset: concrete examples, copy-pasteable workflows, short sentences.
- Write `skills/launchset/SKILL.md` per spec 16.2, and the matching `AGENTS.md` snippet that `init` installs. Make sure the npm package includes the skill file and `init` installs it.
- The docs build must pass.

Review it as Opus with one question above all: **is every command, flag, config key, default, output and file path in the docs real?** Check them against the code (grep, `--help` output, the zod schema). Also check the skill's description makes an agent actually load it in a launchset repo.

## 5. Final pass (phase 11, you, Opus high)

When everything is built:

1. **Review the whole codebase** against the spec, section by section. Make a checklist from the spec and tick off each requirement with the file that implements it and the test that covers it. Anything missing gets built or recorded.
2. **Correctness review**: hunt for bugs in the risky parts (plan/state machine, version calculation, tag handling, text-preserving edits, auth). If the `/code-review` skill is available, run it at `high` on the full branch as an extra check.
3. **Refactor pass**: remove duplication, dead code and leftover TODOs; make naming consistent; check module boundaries (`core/` stays free of I/O); simplify where possible. If the `/simplify` skill is available, use it. Keep all tests green after each step.
4. **Verify from scratch**: fresh clone of the branch → `pnpm install` → `pnpm lint && pnpm typecheck && pnpm test` → build → action bundle builds and the local-action smoke test passes → docs build.

## 6. Definition of done

- Everything in the spec is implemented, or recorded in `design/DECISIONS.md` with a reason.
- Lint, typecheck, tests and docs build all pass from a clean clone.
- The action bundle builds, and publishing it to `demonsters/launchset-action` is implemented (but not run: creating that repo is a manual team step, spec section 17).
- The draft PR is open with a description listing what was built.

## 7. Final report

End with a report to the user containing:
- What was built, per spec section, with anything left out and why.
- Every entry in `design/DECISIONS.md` marked NEEDS REVIEW.
- Test status (counts, anything skipped).
- The manual steps the team must do (spec section 17), with the final list of GitHub App permissions you determined.
- A link to the draft PR.
