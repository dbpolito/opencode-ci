# OpenCode CI

- Subagent output: see child agents' steps and replies in the log.
- `/commands`: run a project command from the prompt.
- `@skills`: attach a project skill by mentioning it.
- Account auth (`~/opencode-ci.auth.json`): an advanced option for trusted private CI when an API key will not do.

## Subagent output

```sh
npx @kompassdev/opencode-ci run 'say hi to 2 subagents in parallel'
```

`opencode run` shows a subagent call but not the child's transcript. This client prints the child's steps and replies, with a dim-colored name in terminals and GitHub Actions:

![Terminal output showing two subagents replying in parallel, with their names colored](docs/subagent-output.jpeg)

Child output streams as it arrives, even when subagents overlap. If the event stream misses a message, the client prints the saved message before that subagent's completion line.

## `/command`

Run a command defined in your OpenCode project:

```sh
npx @kompassdev/opencode-ci run '/review the changed tests'
```

## `@skill`

Mention a project skill to attach it. `bunx` works too:

```sh
bunx @kompassdev/opencode-ci run 'Use @review to inspect the changes'
```

You can also write `@skill:review`. The command and skill examples require a project definition named `review`.

## OAuth credentials (advanced)

Prefer a provider API key for automation; see the [GitHub Actions example](#api-key). Only use account credentials on trusted private infrastructure when you specifically need that account. The client reads `~/opencode-ci.auth.json` when it exists and saves refreshed tokens to the same file:

```sh
npx @kompassdev/opencode-ci run --model openai/gpt-6-luna 'Review this repository'
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
        run: npx --yes @kompassdev/opencode-ci@0.1.8 run --auto --model openrouter/anthropic/claude-sonnet-4 'Review this repository for correctness and missing tests'
        timeout-minutes: 45
```

Set `OPENROUTER_API_KEY` as a repository secret, or use your provider's model and key. Pin the npm package version for production. GitHub does not pass repository secrets to pull requests from forks.

## Use your OpenCode login in trusted private CI

OpenAI [recommends API keys for automation](https://learn.chatgpt.com/docs/auth/ci-cd-auth). Its account-auth guide describes Codex's `auth.json`, not OpenCode's credential format, but the same ChatGPT OAuth account needs a working refresh token. Let OpenCode handle refresh during a normal run and preserve the updated credential file, rather than calling the OAuth endpoint yourself. This package does that with OpenCode credentials stored in `opencode-ci.auth.json`. Do not copy Codex's refresh timer or schedule as if they were OpenCode guarantees.

Do not use this example for public/open-source repositories, fork PRs, or jobs that run untrusted code. The workflow must run on trusted infrastructure with access to the account secret. Use a separate credential for CI so local and CI runs do not rotate the same refresh token.

1. Log in with the OpenCode CLI or desktop app. For ChatGPT Plus/Pro, choose OpenAI's ChatGPT OAuth method.
2. Export the saved login:

   ```sh
   npx --yes @kompassdev/opencode-ci@0.1.8 auth export \
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

Ephemeral runners lose their filesystem after each job. Restore the **latest** credential from a secret, run `opencode-ci`, then save the updated file back to the secret, even if the review fails. This example uses a PAT with permission to update repository Actions secrets (`GITHUB_TOKEN` cannot update them). Use an appropriately scoped GitHub App token instead if available.

Every workflow using this *same account credential* must use the same job-level concurrency group, including any scheduled maintenance workflow. Do not cancel a job between token refresh and write-back; workflow-level cancellation can still interrupt it even if job-level `cancel-in-progress` is `false`. The example is manually dispatched to avoid exposing credentials to untrusted PR code:

```yaml
name: Review with ChatGPT OAuth
on: workflow_dispatch

permissions:
  contents: read

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    concurrency:
      group: opencode-oauth-${{ github.repository }}
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - name: Load OAuth credentials
        id: auth
        env:
          OPENCODE_CI_AUTH_JSON: ${{ secrets.OPENCODE_CI_AUTH_JSON }}
        run: |
          test -n "$OPENCODE_CI_AUTH_JSON" || { echo 'Missing OPENCODE_CI_AUTH_JSON'; exit 1; }
          umask 077
          printf '%s' "$OPENCODE_CI_AUTH_JSON" > "$HOME/opencode-ci.auth.json"
      - name: Review
        run: npx --yes @kompassdev/opencode-ci@0.1.8 run --auto --model openai/gpt-6-luna 'Review this repository'
      - name: Save refreshed OAuth tokens
        if: always() && steps.auth.outcome == 'success'
        env:
          GH_TOKEN: ${{ secrets.PAT_TOKEN }}
        run: gh secret set OPENCODE_CI_AUTH_JSON --repo "$GITHUB_REPOSITORY" < "$HOME/opencode-ci.auth.json"
```

Each run uses a fresh OpenCode database. The CLI never prints credentials and writes refreshed tokens to `~/opencode-ci.auth.json` even if the run fails, provided it started with that file and can finish cleanup. Use `--auth-file PATH` **and** `--auth-output PATH` to write back to another file. The save step cannot recover a process killed before cleanup; if refresh or write-back fails, reseed from a trusted login when necessary.

Do not put credentials in Actions cache: cache entries can be read by other workflows in scope, cannot be updated in place, and may disappear. GitHub only masks configured secret values in logs; don't print token fields or upload the credential file.

If real jobs may be idle for a while, add a lightweight scheduled `opencode-ci run --model openai/YOUR_MODEL 'Reply only OK. Do not use tools.'` using the **same** restore/run/write-back steps and concurrency group. A normal model request makes OpenCode check the credential and refresh it when the access token is near expiry; merely restoring and re-saving a secret does not keep it fresh. An hourly schedule is a conservative choice if keeping the account session alive matters and the small usage and CI overhead are acceptable. An expired *access* token can normally be refreshed later while the *refresh* token remains valid, so hourly runs are not inherently required just because access tokens expire hourly. The refresh token's idle lifetime is not guaranteed here; monitor maintenance failures and reseed when needed instead of assuming Codex's weekly example is safe for OpenCode.

### Persistent self-hosted runner

On a trusted **persistent** runner with a private home directory, you can seed `~/opencode-ci.auth.json` from the secret **only if the file is missing**, with mode `0600`, and let later jobs reuse the file. Do not overwrite it from the original secret on every run: that discards refreshed tokens. Keep the runner dedicated or serialize every job sharing that file, and back up or reseed it if refresh stops working. An ephemeral runner needs the secret round-trip above; a persistent directory or Actions cache is not a substitute for a protected credential store on untrusted infrastructure.

## Command options

The CLI has `run`, `auth export`, and `--version`:

```sh
npx @kompassdev/opencode-ci run --model openai/gpt-6-luna --agent build 'Review the changed files'
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

`npm publish` builds the package automatically through `prepack`. It requires publish access to `@kompassdev`.
