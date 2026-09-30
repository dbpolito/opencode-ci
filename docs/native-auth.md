# OpenCode's native auth import/export

Checked against `/Users/danielpolito/Code/opencode-2`, commit `4c33a253aa` (September 29, 2026, [PR #52139](https://github.com/anomalyco/opencode/pull/52139)). The published V2 CLI/API docs did not yet describe the new commands and credential list/create endpoints when checked.

## Commands

Export one integration to a private file:

```sh
(umask 077; opencode auth export openai > openai-credentials.json)
```

Import that file, or read it from stdin:

```sh
opencode auth import openai-credentials.json
opencode auth import < openai-credentials.json
```

These commands use the OpenCode service/client, not direct SQLite access. They also accept the shared server options. Export without a target includes every integration; targeting `openai` includes all its saved accounts, not just the selected one. Environment-only connections are not exported.

Export writes real secrets to stdout. Its warning appears only when stdout is a TTY, and the CLI does not set file permissions on shell redirection. Use `umask 077`, never `tee`, and never include the result in logs or artifacts.

## Format and import behavior

The export is an array of entries with `id`, `integrationID`, `label`, `active`, and `value`. The value contains the API key or OAuth access/refresh tokens, expiry, method ID, and optional metadata/configuration.

Import validates the array and creates missing entries. Existing IDs are skipped, not overwritten. Existing destination account selections are preserved; integrations new to the destination adopt the exported selection. Import reports counts on stderr.

Repeated import does **not** update rotated tokens. It is a transfer tool, not credential synchronization.

## Fit for opencode-ci

Our current auth file is an object keyed by integration ID with one credential value per integration. Native exports are not accepted by `parseAuth` as-is. Do not substitute a native export in the current workflow.

The new `credential.list()` and `credential.create()` SDK APIs are useful replacements for direct SQLite reads/writes in `src/auth.ts`. Our pinned `@opencode/sdk@2.0.16` has neither method, so this needs a compatible SDK upgrade and tests first.

A follow-up could:

- Accept native exports alongside existing auth JSON, choosing the selected account for each integration.
- Seed the private run host with `credential.create()` and read refreshed values with `credential.list()` while it is still open.
- Keep local masking up to date before output, retain old masks, and save write-back files atomically with mode `0600`.

That would remove our dependency on OpenCode's SQLite layout and simplify local export. Calling the OpenCode CLI during a run would add an installation/service dependency without solving token write-back, so prefer the embedded SDK APIs.
