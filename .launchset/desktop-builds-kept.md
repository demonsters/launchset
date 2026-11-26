---
bump: patch
---

`launchset init` turns a job in a GitHub workflow that release tags start, and that uploads an artifact, publishes or deploys (an Electron desktop build, for example), into a custom target, with its steps copied, commented out, into `launchset-release.yml`. Before, init removed that workflow's tag trigger and nothing built the job for releases anymore.
