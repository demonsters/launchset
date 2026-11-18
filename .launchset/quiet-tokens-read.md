---
bump: patch
---

`verify` no longer tries to read private npm packages with an npm trusted-publishing token. npm only accepts those tokens for publishing, so the check failed with HTTP 400 "OIDC publish authorize: Invalid token". A private package needs a read token in `LAUNCHSET_NPM_TOKEN` or `NODE_AUTH_TOKEN`; the docs explain how to publish with trusted publishing and no npm secret.
