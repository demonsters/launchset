---
bump: patch
---

The workflows `launchset init` writes use the current major of every action: `actions/checkout@v7`, `actions/setup-node@v7`, `actions/setup-java@v6`, `actions/create-github-app-token@v3`, `docker/login-action@v4`, `docker/setup-buildx-action@v4` and `docker/build-push-action@v7`, commented-out examples included. The older majors ran on Node 20, which GitHub now forces onto Node 24 with a warning. The inputs the workflows pass didn't change meaning, apart from `app-id` (see the GitHub App entry). Workflows written by an earlier `init` keep their pins: launchset never rewrites them. To update them, change the majors by hand, or let Dependabot do it (see "Keep the actions current" in Getting started).
