# Runtime behavior

## Noninteractive runs

- The question tool is removed from the embedded SDK's registry, including for custom agents and child sessions. Other interactive forms, including MCP requests, are cancelled and fail the run.
- Without `--auto`, permission requests are rejected and the requesting session is interrupted. `--auto` approves each request once; configured denials remain enforced.
- The SDK and local shell tools inherit the process environment, including `CI`, `GITHUB_ACTIONS`, `GH_TOKEN`, and provider API keys. The runner does not force `CI=true`; set it when running locally if needed. Shell tools receive no interactive stdin.
- Timeouts include reading piped input and startup. SIGINT and SIGTERM interrupt active work. Failed sessions fail the job.
- Each run starts a fresh session and database. Session continuation, forking, and JSON output are not implemented.

## Skipping project configuration

Project configuration and plugins load by default. To skip them for a run:

```sh
npx opencode-ci run --skip-project-config --model openai/gpt-6-luna 'Review this repository'
```

This sets the SDK's `config.project: false`, skipping project and ancestor configuration discovery, including `opencode.json(c)` and project `.opencode`, `.agents`, and `.claude` configuration roots. Project plugins and configuration-defined agents, commands, and skills from those roots are unavailable. Global configuration, globally installed skills, and explicit configuration inputs remain available.

This flag is not a sandbox. The agent can still read repository files and execute code through permitted tools, especially with `--auto`.

## Logs and skills

Tool labels and output follow `opencode run`. This runner also prints child transcripts, with a dim-colored label in terminals and GitHub Actions. `opencode run` shows the subagent call without the child's transcript.

Required skills are attached directly, without a preliminary catalog lookup. Missing skills fail the prompt. `--skill` cannot be combined with a `/command` prompt.
