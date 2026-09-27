# OpenCode CI

- Subagent output: see child agents' steps and replies in the log.
- `/commands`: run a project command from the prompt.
- `@skills`: attach a project skill by mentioning it.
- Account auth (`~/opencode-ci.auth.json`): an advanced option for trusted private CI when an API key will not do.

## Subagent output

```sh
npx opencode-ci run 'say hi to 2 subagents in parallel'
```

`opencode run` shows a subagent call but not the child's transcript. This client prints the child's steps and replies, with a dim-colored name in terminals and GitHub Actions:

![Terminal output showing two subagents replying in parallel, with their names colored](docs/subagent-output.jpeg)

Child output streams as it arrives, even when subagents overlap. If the event stream misses a message, the client prints the saved message before that subagent's completion line.

## `/command`

Run a command defined in your OpenCode project:

```sh
npx opencode-ci run '/review the changed tests'
```

## `@skill`

Mention a project skill to attach it. `bunx` works too:

```sh
bunx opencode-ci run 'Use @review to inspect the changes'
```

You can also write `@skill:review`. The command and skill examples require a project definition named `review`.

## OAuth credentials (advanced)

Prefer a provider API key for automation; see the [GitHub Actions example](#api-key). Only use account credentials on trusted private infrastructure when you specifically need that account. The client reads `~/opencode-ci.auth.json` when it exists and saves refreshed tokens to the same file:

```sh
npx opencode-ci run --model openai/gpt-6-luna 'Review this repository'
```

See [how to export your login](#use-your-opencode-login-in-ci) and [use it in GitHub Actions](#github-actions-with-oauth-on-ephemeral-runners). Treat this file like a password: never commit it, log it, or upload it as a build artifact.

## GitHub Actions

### API key

```yaml
name: Review with OpenCode
on: workflow_dispatch

permissions:
  contents: read

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - name: Review
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
        run: npx --yes opencode-ci@0.1.9 run --auto --model openrouter/anthropic/claude-sonnet-4 'Review this repository for correctness and missing tests'
        timeout-minutes: 45
```

Set `OPENROUTER_API_KEY` as a repository secret, or use your provider's model and key. Pin the npm package version for production. GitHub does not pass repository secrets to pull requests from forks.

## Use your OpenCode login in trusted private CI

OpenAI [documents account auth in CI/CD](https://learn.chatgpt.com/docs/auth/ci-cd-auth) for trusted private Codex automation, while recommending API keys for most jobs. OpenCode uses a different credential file, but the same pattern applies: run the client normally and save its refreshed credentials instead of refreshing tokens yourself.

Do not use this example for public/open-source repositories, fork PRs, or jobs that run untrusted code. The workflow must run on trusted infrastructure with access to the account secret. Use a separate credential for CI so local and CI runs do not rotate the same refresh token.

1. Log in with the OpenCode CLI or desktop app. For ChatGPT Plus/Pro, choose OpenAI's ChatGPT OAuth method.
2. Export the saved login:

   ```sh
   npx --yes opencode-ci@0.1.9 auth export \
     --db "$(opencode debug paths db)" \
     --integration openai
   ```

   This writes `~/opencode-ci.auth.json` with owner-only permissions (0600). Use `--output PATH` for another location.

3. Upload it as a GitHub Actions secret named `OPENCODE_CI_AUTH_JSON`:

   ```sh
   gh secret set OPENCODE_CI_AUTH_JSON < "$HOME/opencode-ci.auth.json"
   ```

   Do not commit or print the file. Delete the local copy when you no longer need it.
4. Log out and log in again locally to get a new credential for local use. CI keeps the credential you exported in step 2. Re-export only if you need to reseed CI (for example, after the refresh token is revoked or expires).

### GitHub Actions with OAuth on ephemeral runners

Ephemeral runners lose their filesystem after each job. Restore the latest credential from a secret, run `opencode-ci`, then save the updated file back. `PAT_TOKEN` needs permission to update repository Actions secrets; `GITHUB_TOKEN` cannot. A GitHub App token works too.

This example runs on non-draft PRs from the same trusted private repository, not forks. Its `opencode-review` group controls review runs; avoid workflow-level cancellation that could interrupt credential write-back.

```yaml
name: Review with ChatGPT OAuth
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  review:
    if: github.event.pull_request.draft == false && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 45
    concurrency:
      group: opencode-review-${{ github.event.pull_request.number }}
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - name: Load OAuth credentials
        id: auth
        env:
          OPENCODE_CI_AUTH_JSON: ${{ secrets.OPENCODE_CI_AUTH_JSON }}
        run: printf '%s' "$OPENCODE_CI_AUTH_JSON" > "$HOME/opencode-ci.auth.json"
      - name: Review
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
        run: npx --yes opencode-ci@0.1.9 run --auto --model openai/gpt-6-luna "Review the PR diff ($BASE_SHA...HEAD) for bugs. Do not edit files."
      - name: Save refreshed OAuth tokens
        if: always() && steps.auth.outcome == 'success'
        env:
          GH_TOKEN: ${{ secrets.PAT_TOKEN }}
          OPENCODE_CI_AUTH_JSON: ${{ secrets.OPENCODE_CI_AUTH_JSON }}
        run: |
          original="$(printf '%s' "$OPENCODE_CI_AUTH_JSON" | jq -cS .)"
          updated="$(jq -cS . "$HOME/opencode-ci.auth.json")"
          if [ "$original" != "$updated" ]; then
            gh secret set OPENCODE_CI_AUTH_JSON --repo "$GITHUB_REPOSITORY" < "$HOME/opencode-ci.auth.json"
          fi
```

This prints the review to the Actions log; posting a formal GitHub review requires a separate publishing step. Only grant the account secret to PR authors and code you trust.

Each run uses a fresh OpenCode database and writes refreshed tokens to `~/opencode-ci.auth.json`, including after a failed session if cleanup completes. For another file, use both `--auth-file PATH` and `--auth-output PATH`.

Do not cache, log, or upload the credential file. A failed refresh or interrupted write-back may require a fresh login and reseed.

If real jobs may be idle, run this daily keepalive (09:00 UTC):

```yaml
name: Keep OpenCode auth fresh
on:
  schedule:
    - cron: '0 9 * * *'
  workflow_dispatch:

permissions:
  contents: read

jobs:
  refresh:
    runs-on: ubuntu-latest
    concurrency:
      group: opencode-auth
      cancel-in-progress: false
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - name: Load OAuth credentials
        id: auth
        env:
          OPENCODE_CI_AUTH_JSON: ${{ secrets.OPENCODE_CI_AUTH_JSON }}
        run: printf '%s' "$OPENCODE_CI_AUTH_JSON" > "$HOME/opencode-ci.auth.json"
      - name: Refresh via a normal run
        run: npx --yes opencode-ci@0.1.9 run --model openai/gpt-6-luna 'Reply only OK. Do not use tools.'
      - name: Save refreshed OAuth tokens
        if: always() && steps.auth.outcome == 'success'
        env:
          GH_TOKEN: ${{ secrets.PAT_TOKEN }}
          OPENCODE_CI_AUTH_JSON: ${{ secrets.OPENCODE_CI_AUTH_JSON }}
        run: |
          original="$(printf '%s' "$OPENCODE_CI_AUTH_JSON" | jq -cS .)"
          updated="$(jq -cS . "$HOME/opencode-ci.auth.json")"
          if [ "$original" != "$updated" ]; then
            gh secret set OPENCODE_CI_AUTH_JSON --repo "$GITHUB_REPOSITORY" < "$HOME/opencode-ci.auth.json"
          fi
```

The model request makes OpenCode check and refresh an expiring access token; copying the secret without a request does not. The save steps skip unchanged credentials, so an idle job won't overwrite a token another job refreshed. Review jobs for different PRs and the keepalive still use different concurrency groups: if both refresh concurrently, they can race. Use one shared group or separate credentials to prevent that race. Monitor failures and reseed when needed. Codex's weekly cadence is not an OpenCode guarantee.

### Persistent self-hosted runner

On a trusted **persistent** runner with a private home directory, you can seed `~/opencode-ci.auth.json` from the secret **only if the file is missing**, with mode `0600`, and let later jobs reuse the file. Do not overwrite it from the original secret on every run: that discards refreshed tokens. Keep the runner dedicated or serialize every job sharing that file, and back up or reseed it if refresh stops working. An ephemeral runner needs the secret round-trip above; a persistent directory or Actions cache is not a substitute for a protected credential store on untrusted infrastructure.

## Command options

The CLI has `run`, `auth export`, and `--version`:

```sh
npx opencode-ci run --model openai/gpt-6-luna --agent build 'Review the changed files'
```

| `run` flag | What it does |
| --- | --- |
| `--directory PATH` | Work in a project directory (default: current directory) |
| `--model provider/model#variant`, `-m` | Choose a model and optional variant |
| `--variant NAME` | Use a variant of the chosen or default model |
| `--agent NAME` | Choose an agent |
| `--file PATH`, `-f` | Include a file, up to 10 MiB; repeat for multiple files |
| `--thinking` | Print reasoning blocks when available |
| `--auto` | Approve each permission request once |
| `--title TITLE` | Set the session title |
| `--timeout SECONDS` | Stop after this many seconds (default: 2700) |
| `--auth-env NAME` | Read auth JSON from an environment variable |
| `--auth-file PATH` | Read auth JSON from a specific file instead of `~/opencode-ci.auth.json` |
| `--auth-output PATH` | Save refreshed auth JSON to a specific file (the default file is updated automatically) |

Each run starts a new session. Without `--auto`, permission requests are rejected. Failed sessions fail the job; SIGINT and SIGTERM interrupt active work. There is no session continuation, forking, or JSON output yet.

`auth export` takes `--db PATH` and one or more `--integration ID` flags. It writes to `~/opencode-ci.auth.json` unless you set `--output PATH`.

## Working on this project

The packaged CLI needs Node.js 24+ but not an installed OpenCode CLI. You need Bun to build and test this repository:

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run smoke:node
npm pack --dry-run
```

`npm publish` builds the package automatically through `prepack`. Publishing the unscoped `opencode-ci` name requires it to be available on npm.
