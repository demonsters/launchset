---
bump: patch
---

The generated workflows pass the GitHub App to `actions/create-github-app-token@v3` as `client-id: ${{ vars.LAUNCHSET_APP_CLIENT_ID || secrets.LAUNCHSET_APP_ID }}`, because v3 deprecates `app-id`. New setups store the App's Client ID as the organization variable `LAUNCHSET_APP_CLIENT_ID`. It isn't secret, so a variable is enough. Existing setups keep working without changes: when the variable is missing, the workflows use the secret `LAUNCHSET_APP_ID`, and GitHub accepts the App ID there too. To migrate, add the variable `LAUNCHSET_APP_CLIENT_ID` (App settings → General → Client ID). In workflows written by an earlier `init`, change `actions/create-github-app-token@v2` to `@v3` and `app-id: ${{ secrets.LAUNCHSET_APP_ID }}` to the `client-id` line above. Once every repo uses it, you can delete the secret `LAUNCHSET_APP_ID`. See GitHub App setup in the docs.
