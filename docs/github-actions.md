# GitHub Actions setup

Start with the workflows in this repository:

- [PR review](https://github.com/dbpolito/opencode-ci/blob/main/.github/workflows/opencode-review-pr.yml): runs this checkout, attaches `review-pr`, and publishes findings.
- [Auth keepalive](https://github.com/dbpolito/opencode-ci/blob/main/.github/workflows/opencode-auth.yml): makes a small model request daily or on manual dispatch, saving rotated OAuth tokens.
- [CI checks](https://github.com/dbpolito/opencode-ci/blob/main/.github/workflows/ci.yml): tests, typecheck, Node smoke test, and package validation.

For another repository, replace `node dist/cli.js` with `npx --yes opencode-ci@latest` and remove the Bun install/build steps. Keep the skill installation and member checks.

## OAuth

1. Set repository variable `OPENCODE_MODEL` to your model, for example `openai/gpt-6-luna`.
2. [Export a dedicated CI login](../README.md#use-your-opencode-login-in-ci), then seed the repository secret:

   ```sh
   gh secret set OPENCODE_CI_AUTH_JSON < "$HOME/opencode-ci.auth.json"
   ```

3. Add `PAT_TOKEN` as a repository secret. Use a fine-grained PAT scoped to this repository with **Secrets: Read and write**. `GITHUB_TOKEN` cannot update secrets. The PAT is exposed only to the credential-save step.
4. Commit the workflows and run **OpenCode auth keepalive** manually to check the setup.

The auth file is refreshed even after a failed session when cleanup completes. GitHub-hosted runners are discarded after each job.

Repository secrets are loaded when a workflow is queued. Concurrent jobs can rotate the same OAuth credential and overwrite each other's saved tokens. Reviews use per-PR concurrency and cancel older reviews when a PR changes; keepalive has its own concurrency group. These groups do not serialize all users of the credential. A failed refresh or interrupted write-back may require a fresh login and reseed.

The keepalive request makes OpenCode check and refresh an expiring access token; copying the secret alone does not. Unchanged credentials are not rewritten. The daily schedule is a keepalive attempt, not a provider guarantee. Monitor failures.

## API key

Provider API keys are simpler for automation. Copy the review workflow, remove its auth load/save steps, and set the review step's environment:

```yaml
- name: Review
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
  run: |
    npx --yes opencode-ci@latest run --auto --thinking \
      --agent "$REVIEW_AGENT" --model "$REVIEW_MODEL" --timeout 2700 \
      --title "review-pr $GITHUB_RUN_ID/$GITHUB_RUN_ATTEMPT" \
      --skill=review-pr \
      'Review and publish findings for the PR supplied in the environment.'
```

Set `OPENAI_API_KEY` as a repository secret and `OPENCODE_MODEL` as a repository variable, or use your provider's equivalents.

## Trust and artifacts

Automatic reviews only run for non-draft, same-repository PRs whose author association is `OWNER` or `MEMBER`. Forks and outside collaborators are excluded. Repository write access is required to manually dispatch auth refreshes or rerun workflows. Daily auth runs use trusted default-branch code; ordinary CI checks run for all PRs without auth secrets.

Only expose credentials to code and PR authors you trust. Never cache, log, or upload credential files. Sanitize captured logs before uploading them; console masking does not protect artifacts. See [credential safety and incident mitigation](security.md).

## Persistent self-hosted runner

On a trusted runner with a private home directory, seed `~/opencode-ci.auth.json` only if it is missing, with mode `0600`. Let later jobs reuse it rather than overwriting it from the original secret. Serialize jobs sharing the file, and back up or reseed it if refresh stops working. Ephemeral runners need the secret round-trip in the example workflows.
