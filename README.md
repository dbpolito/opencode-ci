# OpenCode CI

Run OpenCode V2 noninteractively with child-agent output, `/commands`, required skills, and OAuth token write-back. The packaged CLI needs Node.js 24+; an installed OpenCode CLI is not required.

![OpenCode CI terminal output showing two subagents replying, with their names colored](docs/subagent-output-terminal.png)

- Subagent output: see child agents' steps and replies in the log.
- `/commands`: run a project command from the prompt.
- `@skills`: the intended skill-mention syntax (currently unreliable in CI; use `--skill` for required skills).
- Account auth (`~/opencode-ci.auth.json`): an alternative when you can't use an API key.

## Subagent output

```sh
npx opencode-ci run --skill=humanizer 'say hi to 2 subagents in parallel'
```

`opencode run` shows a subagent call but not the child's transcript. This client prints the child's steps and replies, with a dim-colored name in terminals and GitHub Actions.

Child output arrives as text blocks complete, even when subagents overlap. If an event is missed, saved messages are printed before the child's completion line, including when a child session is reused.

Tool labels and output follow `opencode run`. Tool/status output goes to stderr; non-TTY assistant text and requested reasoning go to stdout. To capture the whole transcript in one file:

```sh
npx opencode-ci run --thinking 'Review this repository' > review.log 2>&1
```

### Secret masking

CLI output replaces known secrets with `[REDACTED]` on both stdout and stderr, including assistant replies, reasoning, tool output, child transcripts, and errors. Masks come from:

- Environment variables named for API keys, tokens, secrets, passwords, private/access keys, or auth (for example `OPENAI_API_KEY` and `GH_TOKEN`).
- API keys, OAuth access/refresh tokens, and string values in metadata/configuration from the loaded auth JSON.
- Refreshed credentials read from the run's database before emitting output and during write-back. Old tokens stay masked too.

Raw, JSON-escaped, and URL-encoded values are covered. On GitHub Actions, these values are also registered with `add-mask`. Credential files retain their real values so authentication and token write-back continue to work.

This masks known values; it does not detect every secret in repository files, cover arbitrary encodings, or sanitize content an agent publishes through tools such as `gh`. Plugins writing directly to process streams bypass the CLI's local mask. No encrypted transcript or share link is created.

## Noninteractive behavior

- The question tool is removed from the embedded SDK's tool registry, including for custom agents and child sessions. Other interactive forms, including MCP requests, are cancelled and fail the run.
- Without `--auto`, permission requests are rejected and the requesting session is interrupted. `--auto` approves each request once; configured denials remain enforced.
- The embedded SDK and local shell tools inherit the process environment, including `CI`, `GITHUB_ACTIONS`, `GH_TOKEN`, and provider API keys. The runner does not force `CI=true`; set it when running locally if needed. Shell tools receive no interactive stdin.
- Timeouts include reading piped input and startup. SIGINT and SIGTERM interrupt active work. Failed sessions fail the job.
- Each run starts a fresh session and database. Session continuation, forking, and JSON output are not implemented.

## `/commands` and skills

Run a command defined in your OpenCode project:

```sh
npx opencode-ci run '/review the changed tests'
```

Require installed skills with repeatable `--skill` flags:

```sh
npx skills add dbpolito/skills --skill review-pr -g -a opencode -y
npx opencode-ci run --auto --skill=review-pr 'Review and publish findings for PR #123 in owner/repo'
npx opencode-ci run --skill=review-pr --skill=security 'Review this PR'
```

Required skills are attached directly, without a preliminary catalog lookup. If any is unavailable, OpenCode rejects the prompt instead of running without it. `--skill` cannot be combined with a `/command` prompt.

Mentions such as `@review-pr` and `@skill:review-pr` are best-effort: OpenCode's skill catalog can be empty before plugin activation, leaving the mention as plain text. Use `--skill` for CI. See [issue #51680](https://github.com/anomalyco/opencode/issues/51680) and [PR #50430](https://github.com/anomalyco/opencode/pull/50430).

The [review-pr skill](https://github.com/dbpolito/skills/tree/main/skills/review-pr) requires `git`, authenticated `gh`, `jq`, the PR head checked out, and enough history to compare the PR's base and head commits. Publishing requires PR review permissions. To let the bot approve PRs, enable that option in the repository's Actions settings.

## GitHub Actions

This repository includes working workflow examples:

- [PR review](https://github.com/dbpolito/opencode-ci/blob/main/.github/workflows/opencode-review-pr.yml): builds and runs this checkout, attaches `review-pr`, and publishes findings.
- [Auth keepalive](https://github.com/dbpolito/opencode-ci/blob/main/.github/workflows/opencode-auth.yml): makes a small model request daily or on manual dispatch, saving rotated OAuth tokens.
- [CI checks](https://github.com/dbpolito/opencode-ci/blob/main/.github/workflows/ci.yml): tests, typecheck, Node smoke test, and package validation.

Automatic reviews only run for non-draft, same-repository PRs whose author association is `OWNER` or `MEMBER`. Forks and outside collaborators are excluded. GitHub requires repository write access to manually dispatch auth refreshes or rerun workflows. The daily auth schedule runs trusted default-branch code. Ordinary CI checks run for all PRs without auth secrets.

### API key

Prefer a provider API key for automation. Copy the review workflow, remove its auth load/save steps, and set the review step's environment:

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

Set `OPENAI_API_KEY` as a repository secret and `OPENCODE_MODEL` as a repository variable, or use your provider's equivalents. For another repository, replace `node dist/cli.js` with `npx --yes opencode-ci@latest` and remove the Bun install/build steps. The skill installation and member checks still apply.

### OAuth setup for this repository's workflows

The workflows use repository secrets. Reviews use per-PR concurrency, cancelling older reviews when the PR is updated. Auth keepalive has its own concurrency group.

1. Set repository variable `OPENCODE_MODEL` to your model, for example `openai/gpt-6-luna`.
2. Export a dedicated OpenCode login using the instructions below, then seed the repository secret:

   ```sh
   gh secret set OPENCODE_CI_AUTH_JSON < "$HOME/opencode-ci.auth.json"
   ```

3. Add `PAT_TOKEN` as a repository secret. Use a fine-grained PAT scoped to this repository with **Secrets: Read and write** (`GITHUB_TOKEN` cannot update secrets). It is exposed only to the credential-save step.
4. Commit the workflows and run **OpenCode auth keepalive** manually to check the setup.

The auth file is refreshed even after a failed session when cleanup completes. GitHub-hosted runners are discarded after each job, so no explicit file deletion is needed.

Repository secrets are loaded when a workflow is queued. Concurrent jobs can also rotate the same OAuth credential and overwrite each other's saved tokens. Authentication failures may require a fresh login and reseed.

Only expose account credentials to code and PR authors you trust. Do not cache, log, or upload credential files. A failed refresh or interrupted write-back may require a fresh login and reseed.

## Use your OpenCode login in CI

For account auth, the client reads `~/opencode-ci.auth.json` and saves refreshed tokens to the same file:

```sh
npx opencode-ci run --model openai/gpt-6-luna 'Review this repository'
```

Give CI its own credential so local and CI runs do not rotate the same refresh token:

1. Log in with OpenCode. For ChatGPT Plus/Pro, choose OpenAI's ChatGPT OAuth method.
2. Export the saved login:

   ```sh
   npx --yes opencode-ci@latest auth export \
     --db "$(opencode debug paths db)" \
     --integration openai
   ```

   This writes `~/opencode-ci.auth.json` with owner-only permissions (`0600`). Use `--output PATH` for another location.

3. Upload it as a repository secret as described above. Never commit or print the file.
4. Log out and log in again locally to get a new credential for local use. Re-export only when CI needs reseeding.

Each run uses a fresh OpenCode database and updates the default auth file only when credentials change. For another file, use both `--auth-file PATH` and `--auth-output PATH`. Explicit auth inputs are not overwritten unless an output path is supplied.

The keepalive model request makes OpenCode check and refresh an expiring access token; copying the secret alone does not. Unchanged credentials are not rewritten. The daily schedule is a keepalive attempt, not a provider guarantee; monitor failures and reseed when needed.

### Persistent self-hosted runner

On a trusted persistent runner with a private home directory, seed `~/opencode-ci.auth.json` only if it is missing, with mode `0600`, and let later jobs reuse it. Do not overwrite it from the original secret on every run. Serialize jobs sharing the file and back up or reseed it if refresh stops working. Ephemeral runners need the secret round-trip used by the included workflows.

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
| `--skill ID` | Require a skill by ID; repeat for multiple skills |
| `--file PATH`, `-f` | Include a file, up to 10 MiB; repeat for multiple files |
| `--thinking` | Print reasoning blocks when available |
| `--auto` | Approve each permission request once |
| `--title TITLE` | Set the session title |
| `--timeout SECONDS` | Stop after this many seconds (default: 2700) |
| `--auth-env NAME` | Read auth JSON from an environment variable |
| `--auth-file PATH` | Read auth JSON from a specific file instead of `~/opencode-ci.auth.json` |
| `--auth-output PATH` | Save refreshed auth JSON to a specific file (the default file is updated automatically) |

`auth export` takes `--db PATH` and one or more `--integration ID` flags. It writes to `~/opencode-ci.auth.json` unless you set `--output PATH`.

## Working on this project

You need Bun to build and test:

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run smoke:node
npm pack --dry-run
```

The Node smoke test also checks timeout handling, inherited CI variables, and child-session question restrictions without a model request. `npm publish` builds the package automatically through `prepack`.

## License

[MIT](LICENSE)
