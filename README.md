# OpenCode CI

Use your OpenAI subscription to run OpenCode in CI. See what subagents are doing, run project commands, and load the skills your workflow needs.

![OpenCode CI terminal output showing two subagents replying, with their names colored](docs/subagent-output-terminal.png)

- [OpenAI subscription via OAuth](#use-your-opencode-login-in-ci): use your ChatGPT Plus/Pro login, with refreshed tokens saved for the next run.
- Subagent logs: see child agents' steps and replies.
- Project `/commands` and explicit `--skill` loading.
- Provider API keys work too.

Requires Node.js 24+. You don't need an installed OpenCode CLI to run it.

## Quick start

With a provider API key in your environment, or an exported login saved as described below:

```sh
npx opencode-ci run --model openai/gpt-6-luna 'Review this repository'
```

## Use your OpenCode login in CI

Give CI its own login so local and CI runs don't compete to rotate the same refresh token.

1. Log in with OpenCode. For ChatGPT Plus/Pro, choose OpenAI's ChatGPT OAuth method.
2. Export the login:

   ```sh
   npx --yes opencode-ci@latest auth export \
     --db "$(opencode debug paths db)" \
     --integration openai
   ```

   This saves `~/opencode-ci.auth.json` with owner-only permissions (`0600`). Never commit or print it.
3. For GitHub Actions, [save it as a repository secret and copy the example workflows](docs/github-actions.md#oauth).
4. Log out and log in again locally to get a separate credential. Re-export only when CI needs reseeding.

The runner reads `~/opencode-ci.auth.json` by default and saves rotated tokens there. For another path, use both `--auth-file PATH` and `--auth-output PATH`. Explicit auth inputs are not overwritten unless you supply an output path. Files are only rewritten when credentials change.

Newer OpenCode checkouts also have native `auth import` / `auth export` commands. Their format differs from this runner's; [see compatibility and the proposed SDK integration](docs/native-auth.md).

## Subagent output

```sh
npx opencode-ci run --skill=humanizer 'say hi to 2 subagents in parallel'
```

Child agents get their own labels in the log, so you can follow their steps and replies even when they overlap.

Output appears as text blocks complete. Missed events are recovered from saved messages before the child's completion line, including for reused sessions.

Tool/status output goes to stderr. Redirected assistant text and requested reasoning go to stdout. Capture both with:

```sh
npx opencode-ci run --thinking 'Review this repository' > review.log 2>&1
```

### Secret masking

Known environment and auth secrets, including refreshed tokens, are replaced with `[REDACTED]` on both streams. Raw, JSON-escaped, and URL-encoded forms are covered. The CLI emits no secret-bearing `::add-mask::` commands.

GitHub console masking does not sanitize uploaded files. Earlier versions could leak credentials through captured masking commands: **remove affected artifacts, revoke/rotate exposed credentials, and sanitize logs before upload**. Read the [limits and cleanup guidance](docs/security.md).

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

Missing required skills fail the run. `--skill` cannot be combined with a `/command` prompt.

Use `--skill` in CI: `@review-pr` and `@skill:review-pr` mentions can be left as plain text when the skill catalog isn't ready. See [issue #51680](https://github.com/anomalyco/opencode/issues/51680) and [PR #50430](https://github.com/anomalyco/opencode/pull/50430).

The [review-pr skill](https://github.com/dbpolito/skills/tree/main/skills/review-pr) requires `git`, authenticated `gh`, `jq`, the PR head checked out, and enough history to compare the PR's base and head commits. Publishing requires PR review permissions. To let the bot approve PRs, enable that option in the repository's Actions settings.

## GitHub Actions

Copy a workflow to get started:

- [PR review](https://github.com/dbpolito/opencode-ci/blob/main/.github/workflows/opencode-review-pr.yml): builds and runs this checkout, attaches `review-pr`, and publishes findings.
- [Auth keepalive](https://github.com/dbpolito/opencode-ci/blob/main/.github/workflows/opencode-auth.yml): makes a small model request daily or on manual dispatch, saving rotated OAuth tokens.
- [CI checks](https://github.com/dbpolito/opencode-ci/blob/main/.github/workflows/ci.yml): tests, typecheck, Node smoke test, and package validation.

For another repository, replace `node dist/cli.js` with `npx --yes opencode-ci@latest`. The [setup guide](docs/github-actions.md) covers OAuth secrets, API keys, token rotation, and self-hosted runners.

Only expose credentials to trusted code and PR authors. The review example excludes forks and outside collaborators.

## Running unattended

- No interactive questions. Requests for other interactive input fail the run.
- Web search defaults to `random` to avoid interactive provider selection. Explicit provider settings and disabled web search are preserved.
- Use `--auto` to approve permission requests once; configured denials still apply.
- Failed sessions fail the job. The default timeout is 45 minutes; SIGINT and SIGTERM interrupt active work.
- Each run starts a fresh session and database.

Project config and plugins load by default. Use `--skip-project-config` to skip checkout-provided configuration; it is not a sandbox. See [runtime behavior and configuration](docs/behavior.md) for details.

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
| `--skip-project-config` | Skip project/ancestor configuration and plugin discovery; keep global configuration |
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
